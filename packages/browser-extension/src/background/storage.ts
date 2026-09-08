import {
  KNOWN_ORIGIN_KEY_PREFIX,
  EXTENSION_LABEL_STORAGE_KEY,
  EXTENSION_CHANNEL_STORAGE_KEY,
} from '../shared/constants.js';
import type { KnownOriginEntry } from '../shared/types.js';

export async function getKnownOrigin(origin: string): Promise<KnownOriginEntry | undefined> {
  const key = `${KNOWN_ORIGIN_KEY_PREFIX}${origin}`;
  const result = await chrome.storage.local.get(key);
  return result[key] as KnownOriginEntry | undefined;
}

export async function setKnownOrigin(entry: KnownOriginEntry): Promise<void> {
  const key = `${KNOWN_ORIGIN_KEY_PREFIX}${entry.origin}`;
  await chrome.storage.local.set({ [key]: entry });
}

export async function deleteKnownOrigin(origin: string): Promise<void> {
  const key = `${KNOWN_ORIGIN_KEY_PREFIX}${origin}`;
  await chrome.storage.local.remove(key);
}

// Derived once from chrome.runtime.id (stable per-install, per-browser-profile)
// and persisted so the extension's WS connection registers under the SAME
// appLabel on every (re)connect - required for mcp-tenant-lib's
// Tenant#stashDynamicTools/#replayDynamicTools (tenant.ts) to treat a
// service-worker restart as "the same connection reconnecting" rather than
// a brand-new unlabeled one, which would never get its dynamic tools back.
export async function getOrCreateExtensionAppLabel(): Promise<string> {
  const existing = await chrome.storage.local.get(EXTENSION_LABEL_STORAGE_KEY);
  const stored = existing[EXTENSION_LABEL_STORAGE_KEY] as string | undefined;
  if (stored) return stored;
  const label = `extension-${chrome.runtime.id.slice(0, 8)}`;
  await chrome.storage.local.set({ [EXTENSION_LABEL_STORAGE_KEY]: label });
  return label;
}

// Defaults to a dedicated "extension" channel, NOT the shared "default"
// channel every unnamed page connection also lands on - the extension is
// meant to be trivially discoverable as its own thing (join_channel("extension"),
// or its own row in the dashboard) rather than blended in among whatever
// pages happen to be on "default". Still overridable via setExtensionChannel
// below if a user wants it to share a channel with something specific.
export async function getExtensionChannel(): Promise<string> {
  const result = await chrome.storage.local.get(EXTENSION_CHANNEL_STORAGE_KEY);
  return (result[EXTENSION_CHANNEL_STORAGE_KEY] as string | undefined) ?? 'extension';
}

export async function setExtensionChannel(channel: string): Promise<void> {
  await chrome.storage.local.set({ [EXTENSION_CHANNEL_STORAGE_KEY]: channel });
}
