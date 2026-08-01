import { connectStateSocket } from '@avo-mcp-tools/mcp-tenant-server/client';
import type { HelloState } from '../types.js';

function insertTitle(title: string) {
  document.title = title;
  const el = document.querySelector('h1');
  if (el) el.textContent = title;
}

function insertMain(main: string) {
  const el = document.querySelector('main');
  if (el) el.textContent = main;
}

// Exposed globally so createClientBridge's 'window' resolve mode (or a
// build-time-wired page) can call these directly, matching the MCP tool
// names 1:1 (insert_title -> window.insertTitle, insert_main -> window.insertMain).
(window as any).insertTitle = insertTitle;
(window as any).insertMain = insertMain;

const scriptUrl = new URL(import.meta.url);
const serverUrl = scriptUrl.searchParams.get('server') ?? undefined;
const tenant = scriptUrl.searchParams.get('tenant') ?? undefined;

connectStateSocket<undefined, HelloState>(
  {
    onInit(_schema, state) {
      insertTitle(state.title);
      insertMain(state.main);
    },
    onReinit(_schema, state) {
      insertTitle(state.title);
      insertMain(state.main);
    },
    onUpdate(field, value) {
      if (field === 'title') insertTitle(value as string);
      if (field === 'main') insertMain(value as string);
    },
    onConnect() {
      console.log('[hello-world-mcp] connected');
    },
    onDisconnect() {
      console.log('[hello-world-mcp] disconnected, retrying...');
    },
  },
  { serverUrl, tenant }
);
