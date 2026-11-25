import type { Page } from './types.js';

/**
 * Local drafts in IndexedDB. Every document you work on is a draft, saved
 * as you edit, so nothing is lost on reload, crash, or "New document" —
 * whether or not it is also a cloud document or a local file. Each tab
 * remembers which draft it has open (`session` store: tab id -> draft id),
 * so tabs never write over each other.
 */

const DB_NAME = 'screenmarker';
const DB_VERSION = 2;
const SESSION_STORE = 'session';
const DRAFT_STORE = 'drafts';

export interface Draft {
  id: string;
  pages: Page[];
  activePageId: string;
  updatedAt: number;
  // Where else the document lives, for the drafts list (and to rebind a local file).
  cloudName?: string | null;
  fileName?: string | null;
  fileHandle?: FileSystemFileHandle | null;
}

/** A draft without its pages, plus what the drafts list shows. */
export interface DraftSummary extends Omit<Draft, 'pages'> {
  title: string;
  pageCount: number;
  firstPage: Page | undefined;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      // Version 1 kept each tab's document in `session` under the tab id: those become drafts.
      if (e.oldVersion === 1) {
        const tx = req.transaction!;
        const drafts = tx.objectStore(DRAFT_STORE);
        const cursorReq = tx.objectStore(SESSION_STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const v = cursor.value as { pages?: Page[]; activePageId?: string } | string;
          if (typeof v === 'object' && Array.isArray(v.pages)) {
            const id = String(cursor.key);
            drafts.put({ id, pages: v.pages, activePageId: v.activePageId ?? '', updatedAt: Date.now() } satisfies Draft);
            cursor.update(id);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error);
      })
  );
}

/** The draft this tab has open, if any. */
export async function loadTabDraftId(tabId: string): Promise<string | null> {
  try {
    const v = await request<unknown>(SESSION_STORE, 'readonly', (s) => s.get(tabId));
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export async function saveTabDraftId(tabId: string, draftId: string): Promise<void> {
  try {
    await request(SESSION_STORE, 'readwrite', (s) => s.put(draftId, tabId));
  } catch {
    // best-effort
  }
}

export async function loadDraft(id: string): Promise<Draft | null> {
  try {
    return (await request<Draft | undefined>(DRAFT_STORE, 'readonly', (s) => s.get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function saveDraft(draft: Draft): Promise<void> {
  try {
    await request(DRAFT_STORE, 'readwrite', (s) => s.put(draft));
  } catch {
    // Persistence is best-effort; a failed save shouldn't break the app.
  }
}

export async function deleteDraft(id: string): Promise<void> {
  try {
    await request(DRAFT_STORE, 'readwrite', (s) => s.delete(id));
  } catch {
    // best-effort
  }
}

/** A readable name for a draft: where it is saved, else its first slide title or label. */
export function draftTitle(d: Pick<Draft, 'pages' | 'cloudName' | 'fileName'>): string {
  if (d.cloudName) return d.cloudName.split('/').pop()!;
  if (d.fileName) return d.fileName;
  for (const p of d.pages) if (p.title?.trim()) return p.title.trim();
  for (const p of d.pages) {
    const label = p.shapes.find((s) => (s.type === 'text' || s.type === 'tag') && s.label?.trim())?.label;
    if (label) return label.trim().split('\n')[0]!.replace(/[*_~`#]/g, '').slice(0, 60);
  }
  return 'Untitled';
}

/** Every draft, most recently edited first. */
export async function listDrafts(): Promise<DraftSummary[]> {
  try {
    const all = await request<Draft[]>(DRAFT_STORE, 'readonly', (s) => s.getAll());
    return all
      .map(({ pages, ...rest }) => ({
        ...rest,
        title: draftTitle({ pages, cloudName: rest.cloudName, fileName: rest.fileName }),
        pageCount: pages.length,
        firstPage: pages.find((p) => p.shapes.length > 0),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
