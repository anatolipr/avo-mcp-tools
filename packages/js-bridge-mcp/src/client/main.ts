import { connectStateSocket, splitPageTools, type PageToolDef } from '@avo-mcp-tools/mcp-tenant-server/client';

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

const scriptUrl = new URL(import.meta.url);
const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;

const socket = connectStateSocket<undefined, undefined>(
  {
    onConnect() {
      console.log('[js-bridge-mcp] connected');
      socket.send({ type: 'register_tools', tools: manifest, summary: pageSummary });
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
