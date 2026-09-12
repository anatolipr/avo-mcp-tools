// The extension's own always-on WS connection to js-bridge-mcp - "the
// extension becomes a root connection," independent of any page's
// connection. One connection for the whole install (not per-tab), analogous
// to a page's own TenantConnection but living in the background service
// worker.
//
// Reuses mcp-tenant-lib's connectStateSocket directly rather than
// reimplementing reconnect/backoff (see client-bridge.ts) - it's already the
// shared, non-page-specific WS transport. connectStateSocket does reference
// `location.pathname/protocol/host` and defaults onIdentify to
// `alert(...)` when no tenant/serverUrl/onIdentify is supplied, none of which
// exist in a service worker - but this call always supplies serverUrl+tenant
// explicitly and its own onIdentify override, so those branches are simply
// dead code paths here, never a build failure (WebSocket itself is a global,
// available in service workers).
import { connectStateSocket } from 'mcp-tenant-lib/client';
import { JSBRIDGE_HOST } from '../shared/constants.js';
import { getExtensionToolBus, type ExtensionTool } from './extension-tool-bus.js';
import { getHostTools, getHostTool, onHostToolsChange, type HostTool } from './host-tools.js';
import { handleReservedCall } from './reserved-calls.js';
import { getOrCreateExtensionAppLabel, getExtensionConnectionName } from './storage.js';

let socket: ReturnType<typeof connectStateSocket> | undefined;

// Merges the fixed host-tool manifest (built-ins from builtin-tools.ts) with
// the bus's current agent-registered dynamic tools - same two-source merge
// main.ts's currentPageTools() does for window.__mcpTools + window.__mcpToolBus.
function currentExtensionTools(): (HostTool | ExtensionTool)[] {
  return [...getHostTools(), ...getExtensionToolBus().getTools()];
}

function findTool(name: string): HostTool | ExtensionTool | undefined {
  return getHostTool(name) ?? getExtensionToolBus().getTools().find((t) => t.name === name);
}

export async function startExtensionConnection(): Promise<void> {
  const [appLabel, connectionName] = await Promise.all([getOrCreateExtensionAppLabel(), getExtensionConnectionName()]);
  const bus = getExtensionToolBus();

  socket = connectStateSocket(
    {
      onConnect() {
        console.log(`[browser-extension] connected to js-bridge-mcp as "${appLabel}" (connection "${connectionName}")`);
        socket!.send({
          type: 'register_tools',
          tools: currentExtensionTools(),
          summary: 'Browser extension: privileged tool-provider channel (network/injection/debugging tools).',
          appLabel,
          // No page to alert()/no channel worth joining - a background
          // service worker, not a browser tab. Hides identify/move on the
          // dashboard (see TenantConnection.internal).
          internal: true,
        });
      },
      async onCall(id, name, args) {
        const reserved = await handleReservedCall(name, args);
        if (reserved.handled) {
          socket!.send({ type: 'call_result', id, result: reserved.result, error: reserved.error });
          return;
        }
        const tool = findTool(name);
        if (!tool) {
          socket!.send({ id, type: 'call_result', error: `no extension tool named "${name}"` });
          return;
        }
        try {
          const result = await tool.fn(args);
          socket!.send({ type: 'call_result', id, result });
        } catch (err) {
          socket!.send({ type: 'call_result', id, error: String((err as Error).message) });
        }
      },
      onDisconnect() {
        console.log('[browser-extension] disconnected from js-bridge-mcp, retrying...');
      },
      onIdentify(label) {
        console.log(`[browser-extension] identify: this is the "${label ?? 'unlabeled'}" connection`);
      },
    },
    // Passed straight through as `?tenant=` - a bare name (the default,
    // "extension") resolves server-side to a root connection; a user who
    // overrides this to "somechannel:ext" via setExtensionConnectionName
    // joins that real channel instead. Either way, name collisions with
    // another live connection of the same name are auto-suffixed
    // server-side (e.g. a second browser profile's extension becomes
    // "extension2") - no client-side handling needed.
    { serverUrl: JSBRIDGE_HOST, tenant: connectionName }
  );

  // Live/late tool registration, same pattern as main.ts's own bus
  // subscription: any register_page_tool_by_code/_by_path call re-sends the
  // full manifest so the server (and any agent re-calling describe_tools)
  // sees the change immediately. Also re-sends when the HOST tool set
  // changes (e.g. read_response_body/modify_request appearing after a
  // successful chrome.debugger attach, or disappearing on detach - see
  // debugger-permission.ts/builtin-tools.ts).
  const resend = () => {
    const tools = currentExtensionTools();
    socket?.send({ type: 'register_tools', tools, appLabel });
    console.log(`[browser-extension] tool set changed — re-sent ${tools.length} tool(s)`);
  };
  bus.onChange(resend);
  onHostToolsChange(resend);
}
