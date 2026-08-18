import { connectStateSocket, splitPageTools, type PageToolDef } from 'mcp-tenant-lib/client';

// The page itself defines its tools (function + manifest entry together,
// see legacy-page/hello-world.html's inline <script>) and exposes them as
// window.__mcpTools. This bridge doesn't know what those tools do — it
// just reads that array, keeps the real function references locally, and
// relays the serializable parts (name/description/params/example) to the
// server so they can be registered as MCP tools.
const pageTools: PageToolDef[] = (window as any).__mcpTools ?? [];
const { manifest, fnByName } = splitPageTools(pageTools);

// Optional page-authored manifest-level context (what kind of page this is,
// cross-tool sequencing rules, shared domain concepts) - distinct from each
// tool's own description. Read once, same as __mcpTools. Surfaced to agents
// via the describe_tools tool that createManifestToolRegistry registers.
const pageSummary: string | undefined = (window as any).__mcpSummary ?? undefined;

// Identifies this page/app when multiple tabs share the same tenant (e.g.
// the same get_embed_snippet output pasted into two tabs) — used server-side
// to build a readable tool-name prefix and connection label. Falls back to
// the page title, which works with zero page changes for the common case.
// Mutable (not `const`) because __mcpRename below (and the connect-time
// prompt right after) reassigns it, so a reconnect after a dropped socket
// re-registers under the chosen label instead of reverting to the original
// document.title-derived one.
let appLabel: string | undefined = (window as any).__mcpAppName ?? document.title ?? undefined;

// A rename that happens AFTER an agent has already connected and read
// tool names (e.g. via describe_tools) doesn't reach that agent — MCP has
// no server-push for "tool list changed", so a stale prefix (like
// "mindfoo2") would keep failing until the agent happens to re-call
// describe_tools. Asking once here, before the very first register_tools
// call, means whatever label the human picks is the ONLY one any agent
// ever sees — no rename-after-the-fact race. Only asked once per page
// load (not on every reconnect) via `askedOnce`, and silently falls back
// to the auto-derived appLabel if the human cancels/dismisses the prompt
// — never blocks the connection on an answer.
let askedOnce = false;
function labelForFirstRegister(): string | undefined {
  if (askedOnce) return appLabel;
  askedOnce = true;
  const chosen = prompt('Name this MCP connection (used to identify it to the agent):', appLabel ?? '');
  if (chosen) appLabel = chosen;
  return appLabel;
}

const scriptUrl = new URL(import.meta.url);
const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;

const socket = connectStateSocket<undefined, undefined>(
  {
    onConnect() {
      console.log('[js-bridge-mcp] connected');
      socket.send({ type: 'register_tools', tools: manifest, summary: pageSummary, appLabel: labelForFirstRegister() });
    },
    async onCall(id, name, args) {
      try {
        const fn = fnByName.get(name);
        if (!fn) throw new Error(`no page tool named "${name}" — was it in window.__mcpTools when this script loaded?`);
        // Page tools may be async (e.g. ones that fetch another document) —
        // await here so we send the resolved value, not a pending Promise
        // (which serializes to "{}" over the socket).
        const result = await fn(args);
        socket.send({ type: 'call_result', id, result });
      } catch (err) {
        socket.send({ type: 'call_result', id, error: String((err as Error).message) });
      }
    },
    onDisconnect() {
      console.log('[js-bridge-mcp] disconnected, retrying...');
    },
  },
  { serverUrl, tenant }
);

// Lets a human rename this connection later from DevTools, after the
// connect-time prompt above already ran (e.g. they dismissed it, or want
// to change their mind mid-session). Same caveat as the module comment
// above: any agent that already read the OLD prefix (e.g. via
// describe_tools) won't automatically learn the new one — MCP has no
// server-push for a changed tool list — so this is best used before an
// agent starts relying on this connection's tool names, not mid-task.
// Exposed as a global rather than wired into __mcpTools since it renames
// the CONNECTION itself, not something a page author defines — same
// rationale as __mcpAppName. Prompts with the current label pre-filled so
// re-running it (or opening DevTools later) shows what's already
// registered, not a blank field.
(window as any).__mcpRename = (newLabel?: string) => {
  const next = newLabel ?? prompt('Rename this MCP connection:', appLabel ?? '');
  if (!next) return; // user cancelled the prompt, or passed an empty string
  appLabel = next;
  socket.send({ type: 'rename_connection', appLabel: next });
  console.log(`[js-bridge-mcp] renamed connection to "${next}"`);
};
