import {
  connectStateSocket,
  splitPageTools,
  type PageToolDef,
  REMOTE_REGISTER_BY_PATH_CALL,
  REMOTE_REGISTER_BY_CODE_CALL,
  REMOTE_UNREGISTER_CALL,
  REMOTE_REQUEST_RECONNECT_CALL,
} from 'mcp-tenant-lib/client';

// The page itself defines its tools (function + manifest entry together,
// see legacy-page/hello-world.html's inline <script>) and exposes them as
// window.__mcpTools. This bridge doesn't know what those tools do — it
// just reads that array, keeps the real function references locally, and
// relays the serializable parts (name/description/params/example) to the
// server so they can be registered as MCP tools.
//
// currentPageTools() re-reads window.__mcpTools fresh and merges in
// window.__mcpToolBus's current tools (if the bus is present) - called
// both at initial connect and again on every bus onChange (see below), so
// a provider (or a single registerTool() call) that registers after this
// page has already connected still reaches the server. `own` entries are
// tagged source:'host' (unless the page already set one itself, unlikely
// but respected if so) - the bus's own getTools() already tags everything
// it returns source:'dynamic'. This distinction is load-bearing for
// unregister_page_tool's "can never touch a host tool" safety guarantee.
function currentPageTools(): PageToolDef[] {
  const rawOwn: PageToolDef[] = (window as any).__mcpTools ?? [];
  const own = rawOwn.map((t) => ({ ...t, source: t.source ?? 'host' as const }));
  const bus: PageToolDef[] = (window as any).__mcpToolBus?.getTools() ?? [];
  return [...own, ...bus];
}

// let, not const: reassigned wholesale (not mutated in place) on every bus
// onChange below - onCall's closure reads fnByName live, so a reassignment
// here is visible there without any extra plumbing.
let { manifest, fnByName } = splitPageTools(currentPageTools());

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
//
// hostProvidedLabel tracks whether the PAGE itself set __mcpAppName before
// this script ran, as opposed to us falling back to document.title below —
// see labelForFirstRegister's use of it.
const hostProvidedLabel = typeof (window as any).__mcpAppName === 'string' && (window as any).__mcpAppName;
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
//
// Skipped entirely when the host page already set window.__mcpAppName
// before importing this script (hostProvidedLabel) — that's a page
// deliberately orchestrating its OWN connect flow (e.g. an app-level
// Connect button with its own rename UI), so this generic prompt would
// just be a redundant, unwanted popup on top of that page's own UX. Still
// asked for the classic paste-the-snippet flow, where the page never set a
// label and document.title is the only fallback.
let askedOnce = false;
function labelForFirstRegister(): string | undefined {
  if (askedOnce) return appLabel;
  askedOnce = true;
  if (hostProvidedLabel) return appLabel;
  const chosen = prompt('Name this MCP connection (used to identify it to the agent):', appLabel ?? '');
  if (chosen) appLabel = chosen;
  return appLabel;
}

const scriptUrl = new URL(import.meta.url);
const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;

// tool-bus.js is optional, host-page-loaded infrastructure by design (see
// its own header comment) - a page that never imports it simply has no
// window.__mcpToolBus, and currentPageTools()/onChange above already
// handle that with `?.`. But register_page_tool_by_path/_by_code REQUIRE
// the bus to exist (that's literally what they call), and the common
// "paste get_embed_snippet's snippet into DevTools, nothing else" flow
// (e.g. formalin, which never wires up tool-bus.js or the SDK itself)
// never loads it - so main.js self-loads it here, once, from the same
// server this script itself came from, guaranteeing window.__mcpToolBus
// exists before either register branch below can be reached. A redundant
// load (a host page that already imported tool-bus.js itself) is a safe
// no-op, since tool-bus.js's own IIFE is `window.__mcpToolBus ??= ...`.
const toolBusUrl = new URL('tool-bus.js', serverUrl ? `${serverUrl}/` : scriptUrl).href;
const toolBusReady: Promise<void> = import(/* @vite-ignore */ toolBusUrl).then(
  () => undefined,
  () => undefined // unreachable - register_page_tool_by_*__ will surface a clear error instead of a silent crash
);

// Tracks the unregister function returned by window.__mcpToolBus.registerTool
// for each tool THIS bridge dynamically registered via a reserved-name call
// (register_page_tool_by_path/_by_code) — separate from any dynamic tool a
// human registered directly from DevTools, which this map does NOT need to
// track: __unregister_tool__ only needs to unregister tools THIS mechanism
// added, and a human-pasted registerTool call already has its own unregister
// fn discarded at the DevTools console (nothing to look up). Populated on
// every successful __register_tool_by_*__ call below; a name collision
// (registering over an existing dynamic entry of the same name) overwrites
// the map entry — the bus's own registerProvider already replaces the prior
// provider slot for that name (same-key re-registration), so the old
// unregister closure would be stale/no-op anyway.
const dynamicUnregisterByName = new Map<string, () => void>();

const socket = connectStateSocket<undefined, undefined>(
  {
    onConnect() {
      const label = labelForFirstRegister();
      console.log(`[js-bridge-mcp] connected as "${label ?? '(unlabeled)'}"`);
      socket.send({ type: 'register_tools', tools: manifest, summary: pageSummary, appLabel: label });
    },
    async onCall(id, name, args) {
      try {
        if (name === REMOTE_REGISTER_BY_PATH_CALL) {
          await toolBusReady;
          const bus = (window as any).__mcpToolBus;
          if (!bus) throw new Error('window.__mcpToolBus failed to load on this page - cannot register a tool');
          const { name: toolName, description, path } = args as { name: string; description: string; path: string };
          const segments = path.split('.');
          const lastKey = segments.pop()!;
          const parent = segments.reduce((obj: any, key) => obj?.[key], window as any);
          const fn = parent?.[lastKey];
          if (typeof fn !== 'function') {
            throw new Error(`"${path}" does not resolve to a function on window`);
          }
          // .call(parent, a) preserves `this` the same way a human pasting
          // `window.myApp.save()` in DevTools would get it, rather than an
          // unbound call that could break a method relying on its own `this`.
          const bound = (a: unknown) => fn.call(parent, a);
          const unregister = bus.registerTool(toolName, bound, { description, origin: { kind: 'path', path } });
          dynamicUnregisterByName.set(toolName, unregister);
          socket.send({ type: 'call_result', id, result: `registered "${toolName}" -> window.${path}` });
          return;
        }

        if (name === REMOTE_REGISTER_BY_CODE_CALL) {
          await toolBusReady;
          const bus = (window as any).__mcpToolBus;
          if (!bus) throw new Error('window.__mcpToolBus failed to load on this page - cannot register a tool');
          const { name: toolName, description, code } = args as { name: string; description: string; code: string };
          // Registers immediately, no confirmation of its own — the
          // js-bridge-mcp dashboard separately logs this as a sticky toast
          // (Tenant.logToolRegistration) so a human can review it after the
          // fact. See manifest-tools.ts's register_page_tool_by_code handler.
          let compiled: (a: unknown, doc: Document, win: Window) => unknown;
          try {
            compiled = new Function('args', 'document', 'window', code) as any;
          } catch (err) {
            throw new Error(`code failed to compile: ${(err as Error).message}`);
          }
          const wrapped = async (a: unknown) => compiled(a, document, window);
          const unregister = bus.registerTool(toolName, wrapped, { description, origin: { kind: 'code', code } });
          dynamicUnregisterByName.set(toolName, unregister);
          socket.send({ type: 'call_result', id, result: `registered "${toolName}" from code` });
          return;
        }

        if (name === REMOTE_UNREGISTER_CALL) {
          const { toolName } = args as { toolName: string };
          const unregister = dynamicUnregisterByName.get(toolName);
          if (!unregister) {
            throw new Error(`"${toolName}" is not a currently-tracked dynamically-registered tool on this connection (already removed, never dynamic, or a host tool — host tools can never be unregistered remotely)`);
          }
          unregister();
          dynamicUnregisterByName.delete(toolName);
          socket.send({ type: 'call_result', id, result: `unregistered "${toolName}"` });
          return;
        }

        if (name === REMOTE_REQUEST_RECONNECT_CALL) {
          // A page's own socket dying (e.g. on navigation) is exactly the
          // situation request_reconnect exists to work around - by the time
          // this handler could ever run, this connection is by definition
          // still alive, so there's nothing to actually DO here beyond
          // acking clearly rather than falling through to "no page tool
          // named..." (which would misleadingly suggest a typo/missing
          // tool rather than "this connection type can't act on this").
          // The real reconnect-without-a-re-paste behavior comes from the
          // browser-extension package's auto-reconnect, not from this page
          // bridge itself.
          socket.send({
            type: 'call_result',
            id,
            result: 'This page connection is already live and has no way to reconnect a different tab — request_reconnect only has an effect against a browser-extension connection.',
          });
          return;
        }

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
    // The dashboard's "move to channel" action (mcp-tenant-lib's
    // Tenant.moveConnection / MoveChannelMessage) — leave this channel and
    // reconnect fresh to the target one, the same leave-then-reimport flow
    // connect.js's own connectToChannel runs for a human-typed "channel:app",
    // just triggered server-side. scriptUrl already carries this page's real
    // main.js URL (host, and any server= param) - cloning it and swapping
    // `tenant` (plus a cache-busting `_`, same trick connect.js uses) works
    // whether this page loaded main.js via connect.js or a bare pasted
    // snippet, unlike a connect.js-only mechanism. Closing this socket
    // (rather than leaving it to drop on its own) stops ITS OWN reconnect
    // loop from ever retrying against the channel we just left.
    onMove(channel) {
      console.log(`[js-bridge-mcp] server requested this connection move to channel "${channel}"`);
      socket.send({ type: 'leave_channel' });
      // Stash the CURRENT label onto window.__mcpAppName before the new
      // instance evaluates, so its own hostProvidedLabel check (above) sees
      // it as already-set and skips labelForFirstRegister()'s prompt — a
      // page with no connect.js (never sets __mcpAppName itself) would
      // otherwise get a surprise "Name this connection" popup mid-session
      // triggered by nothing the user did. A no-op when connect.js (or the
      // host page) already set this, since it's the same value either way.
      (window as any).__mcpAppName = appLabel;
      const nextUrl = new URL(scriptUrl.href);
      nextUrl.searchParams.set('tenant', channel);
      nextUrl.searchParams.set('_', String(Date.now()));
      import(/* @vite-ignore */ nextUrl.href).then(() => {
        // Fires only once the NEW instance has fully evaluated (so its own
        // window.__mcpLeaveChannel assignment has already happened) — lets
        // connect.js (if this page uses it) keep its own currentChannel/
        // localStorage bookkeeping in sync with a move it didn't initiate
        // itself; see connect.js's own listener for why this can't just be
        // done here; main.js has no idea whether connect.js is even in use.
        window.dispatchEvent(new CustomEvent('mcp-bridge-moved', { detail: { channel } }));
      }).catch((err) => {
        console.error(`[js-bridge-mcp] failed to reconnect after move to "${channel}": ${(err as Error).message}`);
      });
      socket.close();
    },
  },
  { serverUrl, tenant }
);

// Live/late tool registration: a page-authored provider (e.g. via
// window.__mcpToolBus.registerTool from DevTools, or a lazily-loaded
// provider module) can register tools at ANY point during an
// already-connected session, not just before the first connect. Every bus
// onChange re-merges window.__mcpTools + the bus's current tools and
// re-sends register_tools - mcp-tenant-lib's updateConnectionManifest
// (tenant.ts) + syncManifestToolRegistries (manifest-tools.ts) are both
// safe to call repeatedly and already emit the MCP SDK's own
// tools/list_changed notification on every call, so no server-side change
// was needed for this.
//
// CAVEAT, documented in this package's own README ("Common mistakes"):
// some MCP clients (Claude Code included, observed against js-bridge-mcp)
// fetch tools/list ONCE at initialize and do not re-poll on
// tools/list_changed mid-session - a tool registered after that client's
// session started may need a full MCP client restart to become callable,
// even though this resend succeeds and the server registers it correctly.
// This is a known, already-documented client limitation, not a bug in
// this resend path.
//
// Does NOT re-trigger labelForFirstRegister()'s prompt - that's gated by
// askedOnce and only relevant to the very first register_tools call; a
// resend reuses whatever appLabel is already in scope, same as __mcpRename
// below does for its own direct send.
//
// Subscribed only AFTER toolBusReady resolves - window.__mcpToolBus is
// undefined at this point on a page that never imported tool-bus.js itself
// (e.g. formalin's manual-snippet-paste flow, where main.ts's own
// self-load above is the only thing that will ever create it). Subscribing
// synchronously here with `?.` used to silently no-op on such a page - the
// bus's own notify() (fired by registerTool/registerProvider, including
// from the register_page_tool_by_path/_by_code branches above) would then
// have no listener at all, so a newly-registered tool never got re-sent to
// the server even though registerTool() itself succeeded with no error.
toolBusReady.then(() => {
  (window as any).__mcpToolBus?.onChange(() => {
    ({ manifest, fnByName } = splitPageTools(currentPageTools()));
    socket.send({ type: 'register_tools', tools: manifest, summary: pageSummary, appLabel });
    console.log(`[js-bridge-mcp] tool bus changed — re-sent ${manifest.length} tool(s)`);
  });
});

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

// Best-effort hook for connect.js (or any other importer that wants to
// switch this tab to a different channel/tenant): tells the server this
// socket is intentionally leaving its current channel, right before a
// fresh main.js import opens a new one on the new channel/tenant. Lets the
// server drop the old tenant immediately once empty (see leave_channel in
// mcp-tenant-lib) instead of only after this socket's close is detected.
// Assigned as a plain global rather than returned, matching this module's
// no-exports/side-effects-only shape (see the header comment on main.ts's
// design) - overwritten harmlessly on every re-import since only the most
// recently opened socket is ever the "current" one worth leaving.
(window as any).__mcpLeaveChannel = () => {
  socket.send({ type: 'leave_channel' });
};

// Genuine full disconnect - unlike __mcpLeaveChannel (which only tells the
// server this socket is leaving, ahead of a FRESH main.js import opening a
// new one; the old socket keeps running its own reconnect loop until then),
// this actually closes the socket via connectStateSocket's own close()
// (which sets closedByCaller and stops it retrying) with no follow-up
// reconnect. Added for the browser extension's popup "Disconnect" action -
// there was previously no page-side API for "stop this connection for real"
// distinct from "I'm about to open a different one instead."
(window as any).__mcpDisconnect = () => {
  socket.send({ type: 'leave_channel' });
  socket.close();
  console.log('[js-bridge-mcp] disconnected (not retrying)');
};
