import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is <pkg>/src when run via tsx (dev) and <pkg>/dist/src once built.
const packageRoot = __dirname.endsWith(`${path.sep}dist${path.sep}src`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8766;
const STATIC_DIR = path.join(packageRoot, 'dist', 'client');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const relPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(STATIC_DIR, relPath);

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
});

function killExistingServer(port: number): void {
  try {
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((pid) => Number(pid) !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
        console.error(`[screenmarker] killed previous instance (pid ${pid}) on port ${port}`);
      } catch {
        // process may have already exited
      }
    }
  } catch {
    // lsof exits non-zero when nothing is listening on the port — nothing to kill
  }
}

killExistingServer(PORT);

server.once('listening', () => {
  const url = `http://localhost:${PORT}`;
  console.error(`[screenmarker] running at ${url}`);
  if (!process.env.SCREENMARKER_NO_OPEN) {
    open(url).catch(() => {
      console.error(`[screenmarker] could not auto-open browser — open ${url} manually`);
    });
  }
});

function listen(): void {
  server.listen(PORT);
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[screenmarker] port ${PORT} still in use, retrying...`);
    setTimeout(listen, 200);
    return;
  }
  throw err;
});

listen();

export { server };
