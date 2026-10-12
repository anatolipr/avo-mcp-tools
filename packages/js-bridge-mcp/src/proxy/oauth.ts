import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ProxyOAuthOptions } from './types.js';

/** Everything one proxy's OAuth flow has to remember between requests and across restarts. */
interface StoredOAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * OAuth state for every proxy, in one JSON file keyed by proxy id. Holds
 * access and refresh tokens, so it gets the same treatment as the proxy
 * config file: owner-only (0600), written via temp-file + rename. An
 * unreadable file starts empty — the cost is authorizing again, which is
 * better than a server that will not start.
 */
export class OAuthStore {
  #filePath: string;
  #data: Record<string, StoredOAuth> = {};

  constructor(filePath: string) {
    this.#filePath = filePath;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.#data = parsed;
      try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error(`[proxy-oauth] ignoring unreadable ${filePath}: ${err?.message ?? err}`);
    }
  }

  get(proxyId: string): StoredOAuth {
    return this.#data[proxyId] ?? {};
  }

  patch(proxyId: string, patch: Partial<StoredOAuth>) {
    this.#data[proxyId] = { ...this.#data[proxyId], ...patch };
    this.#save();
  }

  delete(proxyId: string) {
    if (!(proxyId in this.#data)) return;
    delete this.#data[proxyId];
    this.#save();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      const tmp = `${this.#filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.#filePath);
    } catch (err: any) {
      console.error(`[proxy-oauth] failed to write ${this.#filePath}: ${err?.message ?? err}`);
    }
  }
}

/**
 * The MCP SDK's OAuthClientProvider for one proxy. The SDK drives the flow
 * (metadata discovery, dynamic client registration, PKCE, token refresh);
 * this class only stores what it is handed and reports the authorization
 * URL instead of opening it — this server may be headless, and a browser
 * tab opening on every boot with expired tokens would be worse than a link
 * in /admin. `onAuthorizationUrl` receives that URL together with the
 * `state` value the authorization server will echo back to /oauth/callback.
 */
export class ProxyOAuthProvider implements OAuthClientProvider {
  #proxyId: string;
  #redirectUrl: string;
  #store: OAuthStore;
  #options: ProxyOAuthOptions;
  #onAuthorizationUrl: (url: URL, state: string) => void;
  #state = '';

  constructor(proxyId: string, redirectUrl: string, store: OAuthStore, options: ProxyOAuthOptions, onAuthorizationUrl: (url: URL, state: string) => void) {
    this.#proxyId = proxyId;
    this.#redirectUrl = redirectUrl;
    this.#store = store;
    this.#options = options;
    this.#onAuthorizationUrl = onAuthorizationUrl;
  }

  get redirectUrl() {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'js-bridge-mcp',
      redirect_uris: [this.#redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.#options.clientSecret ? 'client_secret_post' : 'none',
      ...(this.#options.scope ? { scope: this.#options.scope } : {}),
    };
  }

  state() {
    this.#state = randomUUID();
    return this.#state;
  }

  clientInformation() {
    // A pre-registered client (for a server without dynamic registration) wins over a stored dynamic one.
    if (this.#options.clientId) {
      return { client_id: this.#options.clientId, ...(this.#options.clientSecret ? { client_secret: this.#options.clientSecret } : {}) };
    }
    return this.#store.get(this.#proxyId).clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    this.#store.patch(this.#proxyId, { clientInformation });
  }

  tokens() {
    return this.#store.get(this.#proxyId).tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.#store.patch(this.#proxyId, { tokens });
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.#onAuthorizationUrl(authorizationUrl, this.#state || authorizationUrl.searchParams.get('state') || '');
  }

  saveCodeVerifier(codeVerifier: string) {
    this.#store.patch(this.#proxyId, { codeVerifier });
  }

  codeVerifier() {
    const verifier = this.#store.get(this.#proxyId).codeVerifier;
    if (!verifier) throw new Error('no OAuth code verifier saved — start the authorization again');
    return verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all') this.#store.delete(this.#proxyId);
    else if (scope === 'client') this.#store.patch(this.#proxyId, { clientInformation: undefined });
    else if (scope === 'tokens') this.#store.patch(this.#proxyId, { tokens: undefined });
    else if (scope === 'verifier') this.#store.patch(this.#proxyId, { codeVerifier: undefined });
  }
}
