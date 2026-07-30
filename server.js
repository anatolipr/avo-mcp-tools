import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8765;

// ---------------------------------------------------------------------------
// 1. Mutable form definition — starts from fields.json, replaced by
//    define_form tool calls at runtime.
// ---------------------------------------------------------------------------
const initialConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config', 'fields.json'), 'utf-8')
);

let formDef = {
  title: initialConfig.title ?? '',
  fields: initialConfig.fields,
};

// ---------------------------------------------------------------------------
// 2. Store — rebuilt whenever the form definition changes.
// ---------------------------------------------------------------------------
class Store {
  #values = new Map();
  #subscribers = new Set();

  constructor(fieldConfigs) {
    for (const f of fieldConfigs) this.#values.set(f.name, f.default ?? '');
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

let store = new Store(formDef.fields);

// ---------------------------------------------------------------------------
// 3. Submit bus — fires once per user Submit click, resolved by wait_for_submit.
// ---------------------------------------------------------------------------
const submitBus = new EventEmitter();
submitBus.setMaxListeners(0);

// ---------------------------------------------------------------------------
// 4. Helpers to rebuild the form and push it to all connected browsers.
// ---------------------------------------------------------------------------
function applyFormDef(def) {
  store.dispose();
  formDef = def;
  store = new Store(formDef.fields);

  // Re-register the broadcast listener on the new store.
  store.onChange((field, value) => broadcastUpdate(field, value));

  broadcastReinit();
}

function broadcastReinit() {
  const payload = JSON.stringify({ type: 'reinit', formDef, state: store.snapshot() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function broadcastUpdate(field, value) {
  const payload = JSON.stringify({ type: 'update', field, value });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// ---------------------------------------------------------------------------
// 5. HTTP + WebSocket server
// ---------------------------------------------------------------------------
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/mcp') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST' && !sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          console.error(`[mcp] session opened: ${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.error(`[mcp] session closed: ${transport.sessionId}`);
        }
      };
      const mcpInstance = buildMcpServer();
      await mcpInstance.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).handleRequest(req, res);
      return;
    }

    res.writeHead(404); res.end('Unknown session');
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', formDef, state: store.snapshot() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'set' && store.has(msg.field)) {
      store.set(msg.field, msg.value);
    }

    if (msg.type === 'submit') {
      submitBus.emit('submit', store.snapshot());
    }
  });
});

// Initial broadcast wiring for the startup store.
store.onChange((field, value) => broadcastUpdate(field, value));

httpServer.listen(PORT, () => {
  console.error(`[mcp-form-demo] UI available at http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// 6. MCP server — tools read/write the live formDef and store.
// ---------------------------------------------------------------------------

const fieldTypeEnum = z.enum(['text', 'number', 'textarea', 'select']);

const fieldDefSchema = z.object({
  name: z.string().describe('Unique field identifier (snake_case)'),
  label: z.string().describe('Human-readable label shown above the input'),
  type: fieldTypeEnum.default('text').describe('Input type: text | number | textarea | select'),
  placeholder: z.string().optional().describe('Placeholder text for text/number/textarea'),
  options: z.array(z.string()).optional().describe('Required when type is "select"'),
  default: z.string().optional().describe('Initial value'),
});

function buildMcpServer() {
  const mcp = new McpServer({ name: 'mcp-form-demo', version: '0.2.0' });

  // --- form-level tools ---

  mcp.tool(
    'get_form_url',
    'Returns the URL of the live browser form UI (e.g. http://localhost:8765). ' +
    'Call this and share the URL with the user whenever you are about to collect input via define_form, ' +
    'so they know where to open the form before you call wait_for_submit.',
    {},
    async () => ({
      content: [{ type: 'text', text: `http://localhost:${PORT}` }],
    })
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
    '2. Call define_form with a clear title and well-labelled fields. The browser UI reloads instantly. ' +
    '3. Call wait_for_submit — this blocks until the user clicks Submit, then returns all values as JSON. ' +
    '\n\n' +
    'FIELD TYPES: ' +
    '"text" — single-line free input (names, titles, short answers). ' +
    '"number" — numeric input (age, quantity, rating 1-10). ' +
    '"textarea" — multi-line input (descriptions, feedback, long answers). ' +
    '"select" — dropdown from a fixed list; requires options[] array (yes/no, category, priority). ' +
    '\n\n' +
    'EXAMPLES OF GOOD FORM USE: ' +
    '"What are your top 3 favourite movies?" → 3 text fields. ' +
    '"Rate your experience 1-5 and leave a comment" → 1 number + 1 textarea. ' +
    '"Set up your profile (name, role, team, timezone)" → 4 text/select fields. ' +
    '"Which features do you want enabled?" → multiple select fields. ',
    {
      title: z.string().optional().describe(
        'Question or prompt shown at the top of the form. Write it as a natural-language prompt ' +
        'the user will read before filling in fields, e.g. "Tell us about your top 3 favourite movies" ' +
        'or "Configure your project settings below."'
      ),
      fields: z.array(fieldDefSchema).min(1),
    },
    async ({ title, fields }) => {
      applyFormDef({ title: title ?? '', fields });
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
    'Blocks until the user clicks the Submit button on the live form UI, then returns all field values as a JSON object. ' +
    'Always call define_form before this — wait_for_submit has no effect if no form has been defined. ' +
    'Do not ask the user any follow-up questions in chat while this is waiting; the form is the interaction. ' +
    'Once this returns, read the JSON values and proceed — do not call wait_for_submit again unless you define a new form.',
    {},
    async () => {
      const values = await new Promise((resolve) => {
        submitBus.once('submit', resolve);
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(values, null, 2) }],
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
          formDef.fields.map((f) => ({ ...f, value: store.get(f.name) })),
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
      if (!store.has(field)) {
        return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
      }
      return { content: [{ type: 'text', text: String(store.get(field)) }] };
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
      if (!store.has(field)) {
        return { content: [{ type: 'text', text: `Error: field "${field}" does not exist in the current form` }], isError: true };
      }
      store.set(field, value);
      return { content: [{ type: 'text', text: `${field} = ${value}` }] };
    }
  );

  return mcp;
}
