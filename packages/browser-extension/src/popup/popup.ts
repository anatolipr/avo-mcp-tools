import { JSBRIDGE_HOST, VALID_CHANNEL_NAME } from '../shared/constants.js';
import type { ConnectActiveTabResult, ActiveTabStatus, ActionResult } from '../shared/types.js';

// Structural subset of mcp-tenant-lib's DashboardChannel (dashboard.ts) -
// not imported directly, since that package's main entry pulls in
// server-only Node code (ws, etc.) that doesn't belong in a popup bundle;
// this is the same JSON shape GET /api/dashboard already returns.
interface DashboardChannel {
  channel: string;
  connections: { id: string; label: string | null }[];
}

const statusEl = document.getElementById('status')!;
const tabStatusEl = document.getElementById('tab-status')!;
const connectedPanelEl = document.getElementById('connected-panel')!;
const renameInputEl = document.getElementById('rename-input') as HTMLInputElement;
const renameBtn = document.getElementById('rename-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const channelLabelEl = document.getElementById('channel-label')!;
const selectEl = document.getElementById('channel-select') as HTMLSelectElement;
const newChannelEl = document.getElementById('new-channel') as HTMLInputElement;
const appLabelLabelEl = document.getElementById('app-label-label')!;
const appLabelEl = document.getElementById('app-label') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const resultEl = document.getElementById('result')!;

let lastStatus: ActiveTabStatus | undefined;

async function loadTabStatus(): Promise<void> {
  const tabStatus: ActiveTabStatus = await chrome.runtime.sendMessage({ type: 'get-active-tab-status' });
  lastStatus = tabStatus;
  tabStatusEl.className = '';

  if (!tabStatus.connectable) {
    tabStatusEl.textContent = "This tab can't be connected (not a regular http(s) page).";
    tabStatusEl.classList.add('unconnectable');
    connectBtn.disabled = true;
    connectedPanelEl.hidden = true;
    return;
  }

  connectBtn.disabled = false;

  if (tabStatus.connected) {
    // A page can be connected WITHOUT going through this extension's popup
    // at all - e.g. a page with its own hand-authored connect.js/snippet
    // (htmlpaint, bulletino, etc. all auto-connect themselves independently).
    // tabAlreadyConnected() correctly detects the live connection either
    // way, but knownChannel/knownAppLabel only exist for connections THIS
    // extension itself made - show that distinction plainly instead of a
    // bare "?" placeholder.
    if (tabStatus.knownChannel) {
      const nameSuffix = tabStatus.knownAppLabel ? ` as "${tabStatus.knownAppLabel}"` : '';
      tabStatusEl.textContent = `✓ Connected to "${tabStatus.knownChannel}"${nameSuffix}.`;
    } else {
      tabStatusEl.textContent = '✓ Connected (by this page itself, not via this extension — channel/name unknown).';
    }
    tabStatusEl.classList.add('connected');
    connectedPanelEl.hidden = false;
    renameInputEl.value = tabStatus.knownAppLabel ?? '';
    channelLabelEl.textContent = 'Switch to a different channel';
    appLabelLabelEl.textContent = 'Connection name for the new channel (optional)';
  } else {
    connectedPanelEl.hidden = true;
    channelLabelEl.textContent = 'Existing channel';
    appLabelLabelEl.textContent = 'Connection name (optional)';
    if (tabStatus.knownChannel) {
      tabStatusEl.textContent = `Not currently connected (was on "${tabStatus.knownChannel}").`;
      tabStatusEl.classList.add('disconnected');
    } else {
      tabStatusEl.textContent = 'Not connected yet.';
      tabStatusEl.classList.add('disconnected');
    }
    newChannelEl.value = '';
  }
}

async function loadChannels(): Promise<void> {
  try {
    const res = await fetch(`${JSBRIDGE_HOST}/api/dashboard`);
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const channels: DashboardChannel[] = await res.json();
    selectEl.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = channels.length ? '— pick a channel —' : '(no channels yet)';
    selectEl.appendChild(blank);
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch.channel;
      opt.textContent = `${ch.channel} (${ch.connections.length} connection${ch.connections.length === 1 ? '' : 's'})`;
      selectEl.appendChild(opt);
    }
    statusEl.textContent = `js-bridge-mcp is running at ${JSBRIDGE_HOST}.`;
  } catch (err) {
    statusEl.textContent = `Can't reach js-bridge-mcp at ${JSBRIDGE_HOST} — is the server running? (${(err as Error).message})`;
  }
}

connectBtn.addEventListener('click', async () => {
  const chosen = newChannelEl.value.trim() || selectEl.value;
  if (!chosen) {
    resultEl.textContent = 'Pick an existing channel or type a new one.';
    return;
  }
  if (!VALID_CHANNEL_NAME.test(chosen)) {
    resultEl.textContent = 'Channel names may only contain letters, digits, underscore, and hyphen.';
    return;
  }
  resultEl.textContent = 'Connecting…';
  const appLabel = appLabelEl.value.trim() || undefined;
  const response: ConnectActiveTabResult = await chrome.runtime.sendMessage({
    type: 'connect-active-tab',
    channel: chosen,
    appLabel,
  });
  resultEl.textContent = response.ok ? `Connected to "${chosen}".` : `Failed: ${response.error}`;
  if (response.ok) await loadTabStatus();
});

renameBtn.addEventListener('click', async () => {
  const newLabel = renameInputEl.value.trim();
  if (!newLabel) {
    resultEl.textContent = 'Enter a name to rename to.';
    return;
  }
  resultEl.textContent = 'Renaming…';
  const response: ActionResult = await chrome.runtime.sendMessage({ type: 'rename-active-tab', appLabel: newLabel });
  resultEl.textContent = response.ok ? `Renamed to "${newLabel}".` : `Failed: ${response.error}`;
  if (response.ok) await loadTabStatus();
});

disconnectBtn.addEventListener('click', async () => {
  resultEl.textContent = 'Disconnecting…';
  const response: ActionResult = await chrome.runtime.sendMessage({ type: 'disconnect-active-tab' });
  resultEl.textContent = response.ok ? 'Disconnected.' : `Failed: ${response.error}`;
  if (response.ok) await loadTabStatus();
});

loadTabStatus();
loadChannels();
