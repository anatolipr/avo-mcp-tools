/**
 * folderfoo integration: sign-in, reading/writing documents in the user's
 * folderfoo storage, and public (no-account) links used for presentations.
 *
 * Everything is loaded live from the folderfoo host's own /elements/*
 * modules (per folderfoo's integration guide: never vendored), so the app
 * keeps working offline / when folderfoo is unreachable — only the cloud
 * actions fail, with a message.
 *
 * Auth is an httpOnly cookie on the folderfoo origin. Nothing here reads or
 * stores a token; auth-guard.js's readFile/saveFile open folderfoo's own
 * login modal on a 401 and retry once.
 */

// Same backend the other folderfoo apps use. A developer running a local
// folderfoo can point at it with:
//   localStorage.setItem('screenmarker_folderfoo_host', 'https://localhost:3000')
function resolveHost(): string {
  try {
    const override = localStorage.getItem('screenmarker_folderfoo_host');
    if (override) return override.replace(/\/$/, '');
  } catch {
    // storage blocked: use the default
  }
  return 'https://files.cuul.cc';
}

export const FOLDERFOO_HOST = resolveHost();
/** Identifies screenmarker to folderfoo (X-Tenant-Id), isolating its files from other apps'. */
export const TENANT_ID = 'smkr';

interface AuthGuard {
  saveFile(name: string, data: unknown): Promise<unknown>;
  readFile(name: string): Promise<unknown>;
  createPublicLink(path: string, type: 'file' | 'folder'): Promise<{ token: string; expiresAt: string }>;
  getPublicLink(token: string): Promise<{ content?: unknown; owner: string; path: string; type: string }>;
  getCurrentUser(): Promise<{ username: string; fullname: string } | null>;
  redeemShareTokenFromUrl(): void;
  checkShareLinkJoins(): void;
}

async function importElement<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ `${FOLDERFOO_HOST}/elements/${file}`)) as T;
}

/**
 * `?publicToken=` marks a folderfoo public link (made by Share, or by
 * folderfoo's own share manager, which builds links off this page's URL).
 * Read once and stripped, so a reload or later save never carries it.
 */
export const publicToken: string | null = (() => {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('publicToken');
  if (token) {
    url.searchParams.delete('publicToken');
    window.history.replaceState(null, '', url.toString());
  }
  return token;
})();

let guardPromise: Promise<AuthGuard> | null = null;

/** Loads auth-guard.js with this app's tenant set. Rejects if folderfoo is unreachable. */
export function authGuard(): Promise<AuthGuard> {
  guardPromise ??= (async () => {
    const [guard, client] = await Promise.all([
      importElement<AuthGuard>('auth-guard.js'),
      importElement<{ setTenantId(id: string): void }>('api-client.js'),
    ]);
    client.setTenantId(TENANT_ID);
    return guard;
  })();
  guardPromise.catch(() => {
    guardPromise = null; // let a later action retry
  });
  return guardPromise;
}

/**
 * Mounts folderfoo's avatar menu (login/register/logout/File Open) and its
 * session keep-alive. Best-effort: if folderfoo is unreachable the editor
 * simply works without it. A public (presentation) view mounts nothing.
 */
export async function mountAccountUi(): Promise<void> {
  if (publicToken) return;
  try {
    const guard = await authGuard();
    guard.redeemShareTokenFromUrl();
    guard.checkShareLinkJoins();
    const [, refresh] = await Promise.all([
      importElement('folderfoo-profile-circle.js'),
      importElement<{ installSessionRefresh(): void }>('session-refresh.js'),
      importElement('folderfoo-share-toast.js'),
    ]);
    refresh.installSessionRefresh();
    const circle = document.createElement('folderfoo-profile-circle');
    circle.setAttribute('app-name', 'Screenmarker');
    circle.setAttribute('tenant-id', TENANT_ID);
    circle.setAttribute('open-shared-folders', '');
    document.body.appendChild(circle);
    document.body.appendChild(document.createElement('folderfoo-share-toast'));
  } catch {
    // folderfoo unreachable: local-only editing still works
  }
}

/** Opens folderfoo's file browser. Picking a file fires `folderfoo-file-open` on document. */
export async function showFilePicker(): Promise<void> {
  await authGuard();
  await importElement('folderfoo-file-open-modal.js');
  let picker = document.querySelector('folderfoo-file-open-modal') as (HTMLElement & { show(): void }) | null;
  if (!picker) {
    picker = document.createElement('folderfoo-file-open-modal') as HTMLElement & { show(): void };
    picker.setAttribute('app-name', 'Screenmarker');
    picker.setAttribute('tenant-id', TENANT_ID);
    document.body.appendChild(picker);
  }
  picker.show();
}

/** Stores the document value as-is (folderfoo is format-agnostic); throws with `.conflict` if changed elsewhere since it was read. */
export async function saveCloudDocument(name: string, value: unknown): Promise<void> {
  await (await authGuard()).saveFile(name, value);
}

/** Reads a stored document; throws with `.status === 404` if there is none. */
export async function loadCloudDocument(name: string): Promise<unknown> {
  return (await authGuard()).readFile(name);
}

/** Creates a no-account link to a saved document and returns the presentation URL for it. */
export async function createPresentationLink(name: string): Promise<{ url: string; expiresAt: string }> {
  const { token, expiresAt } = await (await authGuard()).createPublicLink(name, 'file');
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('publicToken', token);
  return { url: url.toString(), expiresAt };
}

/** Reads the document behind a public link. Needs no account. */
export async function loadPublicDocument(token: string): Promise<{ content: unknown; owner: string; path: string }> {
  const link = await (await authGuard()).getPublicLink(token);
  return { content: link.content, owner: link.owner, path: link.path };
}

/** The current document's cloud name, from the URL `#hash` (the same convention as folderfoo's other apps). */
export function cloudNameFromHash(): string | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function setCloudNameInHash(name: string | null): void {
  const url = new URL(window.location.href);
  url.hash = name ? encodeURIComponent(name) : '';
  window.history.replaceState(null, '', url.toString());
}
