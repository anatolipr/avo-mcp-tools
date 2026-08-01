import { connectStateSocket } from '@avo-mcp-tools/mcp-tenant-server/client';
import type { HelloState } from '../types.js';

function insertTitle({ title }: { title: string }) {
  document.title = title;
  const el = document.querySelector('h1');
  if (el) el.textContent = title;
  return `title set to "${title}"`;
}

function insertMain({ main }: { main: string }) {
  const el = document.querySelector('main');
  if (el) el.textContent = main;
  return 'main content updated';
}

// Exposed globally so the #mcp-tools manifest's "target" entries can be
// dispatched by name (target: "insertTitle" -> window.insertTitle(args)),
// and so the WS state-sync path (onInit/onUpdate below) can call them
// directly too.
(window as any).insertTitle = insertTitle;
(window as any).insertMain = insertMain;

function readToolManifest(): unknown[] {
  const el = document.getElementById('mcp-tools');
  if (!el || !el.textContent) return [];
  try {
    return JSON.parse(el.textContent);
  } catch {
    return [];
  }
}

const scriptUrl = new URL(import.meta.url);
const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;

const socket = connectStateSocket<undefined, HelloState>(
  {
    onInit(_schema, state) {
      insertTitle({ title: state.title });
      insertMain({ main: state.main });
      socket.send({ type: 'register_tools', tools: readToolManifest() as any });
    },
    onReinit(_schema, state) {
      insertTitle({ title: state.title });
      insertMain({ main: state.main });
    },
    onUpdate(field, value) {
      if (field === 'title') insertTitle({ title: value as string });
      if (field === 'main') insertMain({ main: value as string });
    },
    onCall(id, target, args) {
      try {
        const fn = (window as any)[target];
        if (typeof fn !== 'function') throw new Error(`window.${target} is not a function`);
        const result = fn(args);
        socket.send({ type: 'call_result', id, result });
      } catch (err) {
        socket.send({ type: 'call_result', id, error: String((err as Error).message) });
      }
    },
    onConnect() {
      console.log('[js-bridge-mcp] connected');
    },
    onDisconnect() {
      console.log('[js-bridge-mcp] disconnected, retrying...');
    },
  },
  { serverUrl, tenant }
);
