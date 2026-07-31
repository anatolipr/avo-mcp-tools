import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8765;

const UPLOAD_DIR = path.join(os.tmpdir(), 'mcp-form-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Tenant -- bundles the form definition, store, submit bus, and connected
//    WebSocket clients for one MCP session (or the 'default' tenant used by
//    plain browser access with no MCP session involved).
// ---------------------------------------------------------------------------
const initialConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config', 'fields.json'), 'utf-8')
);

class Store {
  #values = new Map();
  #subscribers = new Set();

  constructor(fieldConfigs) {
    for (const f of fieldConfigs) {
      if (f.type === 'html_output') continue;
      this.#values.set(f.name, f.default ?? '');
    }
  }

  has(name) { return this.#values.has(name); }
  get(name) { return this.#values.get(name); }

  set(name, value) {
    this.#values.set(name, value);
    for (const fn of this.#subscribers) fn(name, value);
  }

  snapshot() { return Object.fromEntries(this.#values); }

  onChange(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  dispose() { this.#subscribers.clear(); }
}

class Tenant {
  constructor(id) {
    this.id = id;
    this.formDef = { title: initialConfig.title ?? '', fields: initialConfig.fields };
    this.store = new Store(this.formDef.fields);
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.wsClients = new Set();
    this.lastActivityAt = Date.now();
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  applyFormDef(def) {
    this.store.dispose();
    this.formDef = def;
    this.store = new Store(this.formDef.fields);
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
    this.broadcastReinit();
  }

  broadcastReinit() {
    const payload = JSON.stringify({ type: 'reinit', formDef: this.formDef, state: this.store.snapshot() });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  broadcastUpdate(field, value) {
    const payload = JSON.stringify({ type: 'update', field, value });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  dispose() {
    this.submitBus.emit('submit', { __interrupted: true, __disposed: true, ...this.store.snapshot() });
    this.store.dispose();
    this.submitBus.removeAllListeners();
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();
  }
}

const tenants = new Map();

function getOrCreateTenant(id) {
  let tenant = tenants.get(id);
  if (!tenant) {
    tenant = new Tenant(id);
    tenants.set(id, tenant);
  }
  return tenant;
}

// The 'default' tenant backs plain browser access (no MCP session), so
// `node server.js` + opening http://localhost:PORT keeps working standalone.
getOrCreateTenant('default');
export { Tenant, tenants, getOrCreateTenant, httpServer };

// ---------------------------------------------------------------------------
// 5. HTTP + WebSocket server
// ---------------------------------------------------------------------------
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const sessions = new Map();

function envMs(name, defaultMs) {
  const raw = process.env[name];
  if (!raw) return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

const TENANT_IDLE_TIMEOUT_MS = envMs('TENANT_IDLE_TIMEOUT_MS', 30 * 60 * 1000);
const TENANT_SWEEP_INTERVAL_MS = envMs('TENANT_SWEEP_INTERVAL_MS', 5 * 60 * 1000);

function disposeTenant(id) {
  const transport = sessions.get(id);
  if (transport) {
    transport.close();
  } else {
    tenants.get(id)?.dispose();
    tenants.delete(id);
  }
}

const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, tenant] of tenants) {
    if (id === 'default') continue;
    if (now - tenant.lastActivityAt > TENANT_IDLE_TIMEOUT_MS) {
      console.error(`[mcp] sweeping idle tenant: ${id}`);
      disposeTenant(id);
    }
  }
}, TENANT_SWEEP_INTERVAL_MS);
sweepInterval.unref();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/mcp') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST' && !sessionId) {
      const tenantId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => tenantId,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          getOrCreateTenant(id);
          console.error(`[mcp] session opened: ${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          tenants.get(transport.sessionId)?.dispose();
          tenants.delete(transport.sessionId);
          console.error(`[mcp] session closed: ${transport.sessionId}`);
        }
      };
      const mcpInstance = buildMcpServer(tenantId);
      await mcpInstance.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (sessionId && sessions.has(sessionId)) {
      if (req.method === 'DELETE') {
        tenants.get(sessionId)?.dispose();
        tenants.delete(sessionId);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await sessions.get(sessionId).handleRequest(req, res);
      return;
    }

    res.writeHead(404); res.end('Unknown session');
    return;
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }

    const boundary = Buffer.from('--' + boundaryMatch[1]);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // Find the filename from Content-Disposition header in the part
      const headerEnd = body.indexOf('\r\n\r\n');
      const headerSection = body.slice(0, headerEnd).toString();
      const nameMatch = headerSection.match(/filename="([^"]+)"/);
      const originalName = nameMatch ? nameMatch[1] : 'upload';
      const ext = path.extname(originalName);
      const savedName = `${randomUUID()}${ext}`;
      const savedPath = path.join(UPLOAD_DIR, savedName);

      // Extract file bytes: after \r\n\r\n, before the closing boundary
      const fileStart = headerEnd + 4;
      const closingBoundary = Buffer.from('\r\n' + boundary.toString() + '--');
      let fileEnd = body.length;
      for (let i = fileStart; i <= body.length - closingBoundary.length; i++) {
        if (body.slice(i, i + closingBoundary.length).equals(closingBoundary)) {
          fileEnd = i;
          break;
        }
      }

      fs.writeFile(savedPath, body.slice(fileStart, fileEnd), (err) => {
        if (err) { res.writeHead(500); res.end('Write error'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: savedPath, name: originalName }));
      });
    });
    return;
  }

  let pathname = url.pathname;
  if (pathname.startsWith('/t/')) {
    pathname = '/';
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const wsUrl = new URL(req.url, `http://localhost:${PORT}`);
  const requestedTenantId = wsUrl.searchParams.get('tenant');

  if (requestedTenantId && !tenants.has(requestedTenantId)) {
    // An explicit tenant was requested but no longer exists (for example
    // because its MCP session was disposed). Reject instead of silently
    // falling back to the shared default tenant.
    ws.close(4404, 'Unknown or expired tenant');
    return;
  }

  const tenantId = requestedTenantId || 'default';
  const t = getOrCreateTenant(tenantId);

  t.wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'init', formDef: t.formDef, state: t.store.snapshot() }));

  ws.on('message', (raw) => {
    t.touch();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'set' && t.store.has(msg.field)) {
      t.store.set(msg.field, msg.value);
    }

    if (msg.type === 'submit') {
      t.submitBus.emit('submit', { __interrupted: false, ...t.store.snapshot() });
    }

    if (msg.type === 'interrupt') {
      t.submitBus.emit('submit', { __interrupted: true, ...t.store.snapshot() });
    }
  });

  ws.on('close', () => {
    t.wsClients.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.error(`[mcp-form-demo] UI available at http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// 6. MCP server — tools read/write the live formDef and store.
// ---------------------------------------------------------------------------

const fieldTypeEnum = z.enum(['text', 'number', 'textarea', 'select', 'checkbox', 'radio', 'date', 'datetime', 'range', 'multiselect', 'file', 'list', 'color', 'html_output']);
const subFieldTypeEnum = z.enum(['text', 'number', 'textarea', 'select', 'checkbox', 'radio', 'date', 'datetime', 'range', 'multiselect', 'color']);

const validationSchema = {
  required: z.boolean().optional().describe(
    'If true, the field must have a non-empty value before the form can be submitted. ' +
    'For checkbox, the box must be checked. For multiselect/list, at least one item must be present.'
  ),
  pattern: z.string().optional().describe(
    'A JavaScript-compatible regular expression string (without delimiters) that the value must match. ' +
    'Applied to text, textarea, and number fields. ' +
    'Examples: "^[a-zA-Z]+$" (letters only), "^[a-zA-Z0-9 ]+$" (alphanumeric), "^\\\\d{5}$" (5-digit ZIP), ' +
    '"^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$" (email). ' +
    'Always pair with patternMessage so the user knows what format is expected.'
  ),
  patternMessage: z.string().optional().describe(
    'Human-readable error shown when the value does not match the pattern. ' +
    'Be specific: "Only letters allowed", "Enter a valid email address", "Must be a 5-digit ZIP code". ' +
    'Required whenever pattern is set.'
  ),
  minLength: z.number().optional().describe('Minimum character count for text and textarea fields.'),
  maxLength: z.number().optional().describe('Maximum character count for text and textarea fields.'),
};

const subFieldDefSchema = z.object({
  name: z.string().describe('Unique field identifier within a list row (snake_case)'),
  label: z.string().describe('Human-readable label shown above the input'),
  type: subFieldTypeEnum.default('text'),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  ...validationSchema,
});

const fieldDefSchema = z.object({
  name: z.string().describe('Unique field identifier (snake_case)'),
  label: z.string().describe('Human-readable label shown above the input'),
  type: fieldTypeEnum.default('text').describe(
    'Input type: text | number | textarea | select | checkbox | radio | date | datetime | range | multiselect. ' +
    '"checkbox" — boolean toggle, value is "true"/"false". ' +
    '"radio" — pick exactly one from a list; requires options[] array. ' +
    '"date" — date picker, value is ISO date string YYYY-MM-DD. ' +
    '"datetime" — date+time picker, value is ISO datetime string YYYY-MM-DDTHH:MM. ' +
    '"range" — slider; value is a number string. Use min/max/step to control bounds. ' +
    '"multiselect" — checkbox list allowing multiple selections; requires options[] array; value is a JSON array string e.g. "[\"a\",\"b\"]". ' +
    '"file" — file upload; value returned as the absolute path on the server where the file was saved. The agent can Read that path directly. ' +
    '"color" — color picker; value returned as a hex string e.g. "#ff0000". ' +
    '"list" — repeatable group of sub-fields; the user can add or remove rows with +/trash buttons. ' +
    'Requires a fields[] array defining the sub-schema for each row (supports all types except list). ' +
    'Value returned as a JSON array of objects e.g. \'[{"first_name":"Alice","last_name":"Smith"}]\'. ' +
    'Use this for collecting structured multi-entry data: team members, addresses, favorite movies with ratings, etc.'
  ),
  placeholder: z.string().optional().describe('Placeholder text for text/number/textarea'),
  options: z.array(z.string()).optional().describe('Required when type is "select", "radio", or "multiselect"'),
  default: z.string().optional().describe('Initial value. For checkbox use "true"/"false". For multiselect use a JSON array string e.g. "[\"option1\"]". For range use a number string.'),
  accept: z.string().optional().describe('For file type only: MIME type filter or file extension filter, e.g. ".pdf,.docx" or "image/*"'),
  fields: z.array(subFieldDefSchema).optional().describe(
    'Required when type is "list". Defines the sub-schema rendered inside each repeatable row card. ' +
    'Supports all field types except "list" (no nesting) and "file". ' +
    'Each entry follows the same shape as a top-level field: name (snake_case, unique within the row), label, type, and type-specific options. ' +
    'The submitted value for the list field will be a JSON array of objects, one per row, keyed by each sub-field name. ' +
    'Example: fields=[{name:"first_name",label:"First Name",type:"text"},{name:"role",label:"Role",type:"select",options:["Eng","PM"]}] ' +
    'produces values like [{first_name:"Alice",role:"Eng"},{first_name:"Bob",role:"PM"}].'
  ),
  min: z.number().optional().describe('Minimum value for range/number types. Also used as validation: number inputs below this value will be rejected.'),
  max: z.number().optional().describe('Maximum value for range/number types. Also used as validation: number inputs above this value will be rejected.'),
  step: z.number().optional().describe('Step increment for range type (default 1)'),
  html: z.string().optional().describe(
    'Required when type is "html_output". Raw HTML string to render inside the block. ' +
    'Can contain any HTML: headings, color swatches, tables, images, styled divs, etc. ' +
    'CSS in <style> tags here is NOT scoped — use the css field for scoped styles instead.'
  ),
  css: z.string().optional().describe(
    'Optional CSS string to inject into the html_output block\'s shadow DOM. ' +
    'Styles are fully scoped to the block and cannot affect other fields. ' +
    'Example: "div { border-radius: 8px; padding: 0.5rem; }" or ":host { display: flex; gap: 1rem; }"'
  ),
  ...validationSchema,
});

function buildMcpServer(tenantId) {
  const mcp = new McpServer({ name: 'mcp-form-demo', version: '0.2.0' });
  const tenant = () => {
    const t = tenants.get(tenantId) ?? getOrCreateTenant(tenantId);
    t.touch();
    return t;
  };

  // --- form-level tools ---

  mcp.tool(
    'get_form_url',
    'Returns the URL of the live browser form UI (e.g. http://localhost:8765/t/<id>). ' +
    'Call this and share the URL with the user whenever you are about to collect input via define_form, ' +
    'so they know where to open the form before you call wait_for_submit.',
    {},
    async () => {
      tenant();
      return { content: [{ type: 'text', text: `http://localhost:${PORT}/t/${tenantId}` }] };
    }
  );

  mcp.tool(
    'define_form',
    'PREFERRED method for collecting structured input from the user. ' +
    'Use this tool instead of asking questions inline in chat whenever you need to gather: ' +
    '(1) two or more pieces of information at once, ' +
    '(2) constrained choices (use type "select" with an options[] list), ' +
    '(3) longer free-text answers (use type "textarea"), or ' +
    '(4) any input where seeing all questions together helps the user give better answers. ' +
    '\n\n' +
    'WHEN TO PREFER THIS OVER CHAT: rankings, preferences, settings, profiles, ratings, ' +
    'multi-step wizard data, survey-style questions, form fills, onboarding info, ' +
    'search/filter criteria, or any time you would otherwise ask 2+ follow-up questions sequentially. ' +
    '\n\n' +
    'HOW TO USE: ' +
    '1. Call get_form_url and tell the user to open that URL in their browser. ' +
    '2. Call define_form with a clear title and well-labelled fields. Pass wait:true to block and receive submitted values in one step (preferred). ' +
    '   Omit wait (or pass false) only if you need to prefill fields with set_field before blocking. In that case call wait_for_submit separately afterward. ' +
    '\n\n' +
    'FIELD TYPES: ' +
    '"text" — single-line free input (names, titles, short answers). ' +
    '"number" — numeric input (age, quantity, rating 1-10). ' +
    '"textarea" — multi-line input (descriptions, feedback, long answers). ' +
    '"select" — dropdown from a fixed list; requires options[] array (yes/no, category, priority). ' +
    '"checkbox" — boolean toggle (agree to terms, enable feature, yes/no flags). ' +
    '"radio" — mutually exclusive choice shown as buttons; requires options[] array (better than select for ≤5 short options). ' +
    '"date" — date picker; value returned as YYYY-MM-DD (deadlines, birthdays, start dates). ' +
    '"datetime" — date+time picker; value returned as YYYY-MM-DDTHH:MM (scheduling, appointments). ' +
    '"range" — slider with min/max/step; value returned as a number string (ratings, confidence, budget). ' +
    '"multiselect" — checkbox list for picking multiple items from a fixed set; requires options[] array; ' +
    'value returned as a JSON array string e.g. \'["tag1","tag2"]\' — parse with JSON.parse() to get an array. ' +
    'Use when the set of choices is known in advance. Prefer "list" when the user supplies free-form entries. ' +
    '"color" — color picker; value returned as a hex string e.g. "#ff0000". Use for theme colors, label colors, or any color choice. ' +
    '"file" — file upload button; value returned as absolute server path the agent can Read directly (PDFs, images, documents). Use accept to restrict file types e.g. ".pdf" or "image/*". ' +
    '"html_output" — read-only display block; renders arbitrary HTML in a scoped shadow DOM. ' +
    'Not an input — has no value and is excluded from the submitted data. ' +
    'Use this to show context, previews, color swatches, summaries, or formatted data alongside input fields. ' +
    'Set html to the raw HTML string to render. Optionally set css with scoped stylesheet rules. ' +
    'Supports full HTML: headings, divs, tables, inline SVG, color swatches, images (data URIs), etc. ' +
    'Good uses: show a color chosen in a previous step above a related color input; display a summary of earlier answers before a confirmation submit; show a styled table of results; render a preview of a chosen palette. ' +
    'Example: {type:"html_output", name:"color_preview", html:"<div style=\'background:#ff5733;width:100%;height:40px;border-radius:6px\'></div><p>Your primary color: #ff5733</p>", css:"p{margin:0.3rem 0;font-size:0.85rem;color:#555}"}. ' +
    '"list" — repeatable group of sub-fields the user can add or remove rows of. ' +
    'Use this whenever you need one or more items of the same structure: people, addresses, tasks, movies, ingredients, etc. ' +
    'Requires a fields[] array (the sub-schema); each row renders as a card. Supports all field types inside a row except "list" (no nesting) and "file". ' +
    'Value returned as a JSON array of objects e.g. \'[{"first_name":"Alice","role":"Engineer"},{"first_name":"Bob","role":"PM"}]\' — parse with JSON.parse(). ' +
    'The array will always contain at least one entry (the model should filter out blank rows if the user left one empty). ' +
    '\n\n' +
    'VALIDATION (applies to any field type): ' +
    'required:true — blocks submit if empty; for checkbox the box must be checked; for multiselect/list at least one item must exist. ' +
    'pattern + patternMessage — regex the value must match; use for format constraints on text/textarea/number ' +
    '(e.g. pattern:"^[a-zA-Z ]+$", patternMessage:"Only letters and spaces allowed" for a name field). ' +
    'minLength / maxLength — character count bounds for text and textarea. ' +
    'min / max on number fields — numeric range validation (value must be between min and max). ' +
    'All validation rules apply equally to sub-fields inside a list type. ' +
    '\n\n' +
    'WHEN TO USE "list" vs OTHER TYPES: ' +
    'Use "list" when the number of entries is unknown in advance or the user should be able to add more. ' +
    'Use fixed fields (text × N) only when you know exactly how many entries are needed (e.g. exactly 3 references). ' +
    'Use "multiselect" only when picking from a predefined set, not for free-form entry. ' +
    '\n\n' +
    'EXAMPLES OF GOOD FORM USE: ' +
    '"What are your top 3 favourite movies?" → 1 list field (title + year) so the user can add exactly as many as they want. ' +
    '"Rate your experience 1-5 and leave a comment" → 1 range + 1 textarea. ' +
    '"Set up your profile (name, role, team, timezone)" → 4 text/select fields. ' +
    '"Which features do you want enabled?" → 1 multiselect field with the known feature options. ' +
    '"Add your team members" → 1 list field with sub-fields: first_name (text), last_name (text), role (select). ' +
    '"Enter your reading list with priority" → 1 list field with sub-fields: title (text), author (text), priority (radio: Low/Medium/High). ' +
    '"Choose complementary colors (primary was #ff5733 last session)" → 1 html_output showing a swatch of the previous color, then 1 color input for the new pick. ' +
    '"Confirm your choices before we proceed" → multiple html_output blocks summarizing earlier answers, no input fields, just a Submit to acknowledge. ' +
    '"Pick a font size (current preview)" → 1 html_output showing live-styled sample text, then a range input for size. ',
    {
      title: z.string().optional().describe(
        'Question or prompt shown at the top of the form. Write it as a natural-language prompt ' +
        'the user will read before filling in fields, e.g. "Tell us about your top 3 favourite movies" ' +
        'or "Configure your project settings below."'
      ),
      fields: z.array(fieldDefSchema).min(1),
      wait: z.boolean().optional().describe(
        'If true, immediately block after defining the form and return the submitted values once the user clicks Submit — ' +
        'equivalent to calling wait_for_submit right after. ' +
        'Use this for the common case where you do not need to prefill fields with set_field between defining and waiting. ' +
        'Omit (or set false) when you need to call set_field before waiting.'
      ),
    },
    async ({ title, fields, wait }) => {
      tenant().applyFormDef({ title: title ?? '', fields });
      if (wait) {
        const raw = await new Promise((resolve) => {
          tenant().submitBus.once('submit', resolve);
        });
        const { __interrupted, __disposed, ...values } = raw;
        if (__disposed) {
          return {
            content: [{ type: 'text', text: 'Error: the session was closed while waiting for submit' }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: __interrupted ? 'interrupted' : 'submitted', values }, null, 2) }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Form updated with ${fields.length} field(s). Call wait_for_submit to wait for the user.`,
        }],
      };
    }
  );

  mcp.tool(
    'wait_for_submit',
    'Blocks until the user clicks Submit or clicks "Update form" (interrupt) on the live form UI. ' +
    'Always call define_form before this — wait_for_submit has no effect if no form has been defined. ' +
    '\n\n' +
    'RETURN SHAPE: a JSON object with two top-level keys: ' +
    '"status": either "submitted" (user clicked Submit — form is done) or "interrupted" (user clicked "Update form" — agent should read chat, adjust the form via define_form, then call wait_for_submit again). ' +
    '"values": object of all current field values at the moment of submission or interruption. ' +
    '\n\n' +
    'INTERRUPTION FLOW: when status is "interrupted", the form stays open in the browser with all values intact. ' +
    'The agent should read the user\'s latest chat message, optionally call define_form with updated/additional fields (existing values are preserved if field names match), then call wait_for_submit again. ' +
    '\n\n' +
    'RETURNED VALUE SHAPES BY FIELD TYPE: ' +
    'text / number / textarea / select / radio / date / datetime / range → plain string. ' +
    'checkbox → "true" or "false" string. ' +
    'multiselect → JSON array string e.g. \'["a","b"]\'; use JSON.parse() to get an array. ' +
    'list → JSON array-of-objects string e.g. \'[{"first_name":"Alice","role":"Engineer"}]\'; use JSON.parse() to get an array. ' +
    'Filter out list rows where all sub-field values are empty strings. ' +
    'file → absolute server path string; use the Read tool to access the file contents.',
    {},
    async () => {
      const raw = await new Promise((resolve) => {
        tenant().submitBus.once('submit', resolve);
      });
      const { __interrupted, __disposed, ...values } = raw;
      if (__disposed) {
        return {
          content: [{ type: 'text', text: 'Error: the session was closed while waiting for submit' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: __interrupted ? 'interrupted' : 'submitted', values }, null, 2) }],
      };
    }
  );

  // --- field-level tools (operate on whatever is currently live) ---

  mcp.tool(
    'list_fields',
    'Returns every field in the currently active form with its name, label, type, options (if select), and current value. ' +
    'Use this to inspect what the user has filled in so far without waiting for a full submit, ' +
    'or to verify the form structure after calling define_form.',
    {},
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify(
          tenant().formDef.fields.map((f) => f.type === 'html_output'
            ? { name: f.name, type: 'html_output' }
            : { ...f, value: tenant().store.get(f.name) }
          ),
          null, 2
        ),
      }],
    })
  );

  mcp.tool(
    'get_field',
    'Reads the current value of a single form field by its snake_case name. ' +
    'Use this to check one specific field without fetching the entire form state. ' +
    'Field must exist in the currently active form (use list_fields to see available names).',
    { field: z.string().describe('snake_case field name as defined in the current form schema') },
    async ({ field }) => {
      const t = tenant();
      if (!t.store.has(field)) {
        return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
      }
      return { content: [{ type: 'text', text: String(t.store.get(field)) }] };
    }
  );

  mcp.tool(
    'set_field',
    'Programmatically sets the value of a form field, updating the live browser UI immediately. ' +
    'Use this to pre-populate fields with sensible defaults or suggestions before the user fills the form — ' +
    'for example, pre-filling a "name" field from a previous session, or setting a default selection. ' +
    'The user can still edit the value before submitting. ' +
    'Field must exist in the currently active form (call define_form first).',
    {
      field: z.string().describe('snake_case field name as defined in the current form schema'),
      value: z.string(),
    },
    async ({ field, value }) => {
      const t = tenant();
      if (!t.store.has(field)) {
        return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
      }
      t.store.set(field, value);
      return { content: [{ type: 'text', text: `${field} = ${value}` }] };
    }
  );

  return mcp;
}
