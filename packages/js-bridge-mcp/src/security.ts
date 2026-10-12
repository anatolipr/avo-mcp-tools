import type { IncomingMessage } from 'node:http';

/**
 * Access policy for this server's HTTP surface. js-bridge-mcp can spawn
 * arbitrary processes (a stdio proxy's `command`) and run arbitrary JS in
 * bridged tabs, so "who may call /mcp and /api/*" is a real boundary — any
 * website a human happens to visit can otherwise reach http://localhost:8766
 * from its own page JS.
 *
 * Deliberately NOT applied to the WebSocket bridge (/ws) or the static assets
 * (/main.js, /connect.js, /tool-bus.js, the dashboard): cross-origin pages
 * loading those and bridging themselves in is the whole point of this server.
 */
export interface SecurityOptions {
  /** Accept TCP connections from non-loopback addresses, and any Host header. Off by default. */
  allowRemote: boolean;
  /** Extra exact Origin values (e.g. "https://app.example.com") allowed to call /mcp and /api/* from page JS. */
  allowedOrigins: string[];
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag && argv[i + 1] !== undefined) values.push(argv[++i]!);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Lowercased, trailing-slash-free form, so "https://App.example.com/" and the browser-sent "https://app.example.com" compare equal. */
function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

export function resolveSecurityOptions(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): SecurityOptions {
  const allowRemote = argv.includes('--allow-remote') || TRUTHY.has((env.JS_BRIDGE_MCP_ALLOW_REMOTE ?? '').toLowerCase());
  const allowedOrigins = [
    ...flagValues(argv, '--allow-origin').flatMap(splitList),
    ...splitList(env.JS_BRIDGE_MCP_ALLOWED_ORIGINS),
  ].map(normalizeOrigin);
  return { allowRemote, allowedOrigins: [...new Set(allowedOrigins)] };
}

/** True for 127.0.0.0/8, ::1, and the IPv4-mapped IPv6 form of the former — every address a same-machine client can arrive from. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  if (a === '::1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}

/** True for a hostname that can only resolve to this machine: localhost, *.localhost, 127.x.x.x, [::1]. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Paths that can change state, spawn processes, or reveal proxy configs. Everything else is a public static asset. */
export function isGuardedPath(pathname: string): boolean {
  return pathname === '/mcp' || pathname === '/upload' || pathname === '/api' || pathname.startsWith('/api/');
}

function hostnameOfHostHeader(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Decides whether one request to a guarded path may proceed. Two independent
 * checks, both needed:
 *
 * - Host header: a DNS-rebinding attack points an attacker-owned name at
 *   127.0.0.1, which makes the attacker's page same-origin with this server
 *   (so the Origin check below sees nothing wrong). Such a request still
 *   carries the attacker's name in Host, so requiring a loopback Host stops
 *   it. Skipped under allowRemote, where a LAN IP or hostname is expected.
 *
 * - Origin header: browsers attach it to every cross-origin fetch that can
 *   change state. Absent means a non-browser client (Claude Code, VS Code,
 *   curl, a Node script) or a same-origin GET, both fine. Present, it must be
 *   this server itself, another loopback page (a local dev server), a browser
 *   extension, or explicitly allowlisted. "null" (a sandboxed iframe or a
 *   file:// page) is rejected unless allowlisted, since any website can
 *   manufacture one.
 */
export function checkRequest(
  req: Pick<IncomingMessage, 'headers'>,
  options: SecurityOptions,
): { ok: true } | { ok: false; reason: string } {
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (!options.allowRemote) {
    const hostname = host ? hostnameOfHostHeader(host) : undefined;
    if (!hostname || !isLoopbackHostname(hostname)) {
      return { ok: false, reason: `Host "${host ?? ''}" is not a loopback name — start js-bridge-mcp with --allow-remote to accept it` };
    }
  }

  const rawOrigin = req.headers.origin;
  if (typeof rawOrigin !== 'string' || rawOrigin === '') return { ok: true };
  const origin = normalizeOrigin(rawOrigin);
  if (options.allowedOrigins.includes(origin) || options.allowedOrigins.includes('*')) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: `Origin "${rawOrigin}" is not allowed — start js-bridge-mcp with --allow-origin ${rawOrigin} to allow it` };
  }
  if (/^(chrome|moz|safari-web)-extension:$/.test(parsed.protocol)) return { ok: true };
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname)) return { ok: true };
  // Same-origin request to a non-loopback Host: only reachable under
  // allowRemote (the Host check above already rejected it otherwise), e.g.
  // the dashboard opened from another device as http://192.168.1.5:8766.
  if (options.allowRemote && host && parsed.host === host.toLowerCase()) return { ok: true };

  return { ok: false, reason: `Origin "${rawOrigin}" is not allowed — start js-bridge-mcp with --allow-origin ${rawOrigin} to allow it` };
}
