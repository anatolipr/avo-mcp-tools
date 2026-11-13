import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

/**
 * Lets the scaffoldify.com web app (its "MCP" tab) call this server's /api routes from the browser.
 *
 * The page runs on another origin, so it needs CORS, and Chrome also asks before a public page
 * reaches localhost (Private Network Access preflight). Allowing an origin is not enough on its
 * own: the /api routes can browse the local filesystem and change files. So a request from an
 * allowed origin must also carry this server's UI token in an `x-bucket-token` header. The token
 * reaches the page only through the URL bucket_open_ui returns (in its #fragment, which browsers
 * never send to a server), so only someone who can call this MCP server can open the tab.
 *
 * Requests with no Origin header or an origin not in the list are left exactly as before: the
 * bucket's own page on localhost keeps working with no token.
 */
export const SCAFFOLDIFY_UI_URL = (process.env.SCAFFOLDIFY_UI_URL || 'https://scaffoldify.com').replace(/\/+$/, '');

const DEFAULT_ORIGINS = ['https://scaffoldify.com', 'https://www.scaffoldify.com', 'http://localhost:3000', 'http://127.0.0.1:3000'];

export function allowedOrigins(): Set<string> {
  const extra = (process.env.SCAFFOLDIFY_UI_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, new URL(SCAFFOLDIFY_UI_URL).origin, ...extra]);
}

/** The UI token, created once and kept in the base dir (mode 600) so open tabs survive a restart. */
export function loadUiToken(baseDir: string): string {
  const file = path.join(baseDir, '.scaffoldify-ui-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(existing)) return existing;
  } catch {
    // first run
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function scaffoldifyAccess(token: string, origins = allowedOrigins()) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin) || !req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bucket-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.status(204).end();
      return;
    }
    const given = req.headers['x-bucket-token'];
    if (typeof given !== 'string' || !sameToken(given, token)) {
      res.status(401).json({ error: 'Open this page from bucket_open_ui: the link carries the token this server needs.' });
      return;
    }
    next();
  };
}

/** What bucket_open_ui returns: the scaffoldify MCP tab, told where this server is and its token. */
export function scaffoldifyUiUrl(port: number, token: string): string {
  return `${SCAFFOLDIFY_UI_URL}/mcp#port=${port}&token=${encodeURIComponent(token)}`;
}
