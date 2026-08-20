const STORAGE_KEY = 'screenmarker_tab_id';
const CHANNEL_NAME = 'screenmarker-tabs';
const CLAIM_TIMEOUT_MS = 200;

type ChannelMessage = { type: 'claim'; id: string; nonce: string } | { type: 'claimed'; id: string; nonce: string };

function makeUuid(): string {
  return crypto.randomUUID();
}

/**
 * Returns a document id unique to this browser tab, persisted across
 * reloads (via sessionStorage) but never shared with another tab.
 *
 * sessionStorage is copied when a tab is duplicated, so a freshly-duplicated
 * tab starts with the SAME id as its source tab. This resolves that: on
 * load, broadcast a claim over BroadcastChannel; if another live tab
 * answers "I already have this id", mint a new one and persist that
 * instead. A plain reload gets no reply (the previous instance of this same
 * tab is gone) so it keeps its id and reloads the same document.
 */
export async function getTabId(): Promise<string> {
  let id: string = sessionStorage.getItem(STORAGE_KEY) ?? '';
  if (!id) {
    id = makeUuid();
    sessionStorage.setItem(STORAGE_KEY, id);
  }

  if (typeof BroadcastChannel === 'undefined') return id;

  const channel = new BroadcastChannel(CHANNEL_NAME);
  const nonce = makeUuid();

  const conflict = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      resolve(result);
    };

    const onMessage = (e: MessageEvent<ChannelMessage>) => {
      const msg = e.data;
      if (msg.type === 'claimed' && msg.id === id && msg.nonce === nonce) {
        finish(true);
      }
    };

    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'claim', id, nonce } satisfies ChannelMessage);
    const timer = setTimeout(() => finish(false), CLAIM_TIMEOUT_MS);
  });

  if (conflict) {
    id = makeUuid();
    sessionStorage.setItem(STORAGE_KEY, id);
  }

  // From here on, answer other tabs' claims for whichever id this tab
  // ultimately settled on, so a second/third duplicate is caught too.
  channel.addEventListener('message', (e: MessageEvent<ChannelMessage>) => {
    const msg = e.data;
    if (msg.type === 'claim' && msg.id === id) {
      channel.postMessage({ type: 'claimed', id: msg.id, nonce: msg.nonce } satisfies ChannelMessage);
    }
  });

  return id;
}
