// A minimal Bluesky (AT Protocol) client: an app password session, and the
// handful of read calls skyback needs. Deliberately not @atproto/api: that SDK
// pulls in the whole lexicon codegen, and the free plan's 10ms CPU budget is
// better spent parsing timelines.
//
// Routing follows the official SDK (AtpAgent): session management
// (createSession, refreshSession) goes to BSKY_SERVICE, the entryway; data
// calls go to the PDS named in the account's DID document, which proxies app.bsky
// reads to the Bluesky AppView (named explicitly with the atproto-proxy header).
//
// The session lives in D1 (state.session). The access token is reused until a
// couple of minutes before it expires, then refreshed; only when the refresh
// token itself is rejected does it fall back to createSession, which Bluesky
// rate limits per account (30 per 5 minutes, 300 a day).

const APPVIEW = 'did:web:api.bsky.app#bsky_appview';

export class BskyError extends Error {
  constructor(status, error, message) {
    super(`${status} ${error || 'Error'}${message ? `: ${message}` : ''}`);
    this.status = status;
    this.error = error || '';
  }
}

export class BudgetSpent extends Error {
  constructor() {
    super('fetch budget for this run is spent');
  }
}

function jwtExp(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4)));
    return typeof json.exp === 'number' ? json.exp : 0;
  } catch {
    return 0;
  }
}

export function pdsFromDidDoc(didDoc) {
  const services = (didDoc && Array.isArray(didDoc.service) && didDoc.service) || [];
  for (const s of services) {
    const id = String(s.id || '');
    if ((id === '#atproto_pds' || id.endsWith('#atproto_pds')) && typeof s.serviceEndpoint === 'string') {
      return s.serviceEndpoint.replace(/\/+$/, '');
    }
  }
  return null;
}

async function readError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON
  }
  return new BskyError(response.status, body && body.error, body && body.message);
}

export class Bsky {
  // store: Store. options.maxFetches caps outbound requests for this run; the
  // free plan allows 50 subrequests per invocation, D1 calls not included.
  constructor(env, store, options = {}) {
    this.env = env;
    this.store = store;
    this.service = String(env.BSKY_SERVICE || 'https://bsky.social').replace(/\/+$/, '');
    this.maxFetches = options.maxFetches || 40;
    this.userAgent = `skyback/${options.version || '0'} (+https://skyback.sevitz.com)`;
    this.fetches = 0;
    this.session = null;
  }

  canFetch() {
    return this.fetches < this.maxFetches;
  }

  async fetch(url, init) {
    if (!this.canFetch()) throw new BudgetSpent();
    this.fetches += 1;
    const headers = { 'user-agent': this.userAgent, accept: 'application/json', ...(init && init.headers) };
    return fetch(url, { ...init, headers });
  }

  // ---- session ----

  async loadSession() {
    if (!this.session) this.session = await this.store.getJson('session');
    return this.session;
  }

  async saveSession(data, previous) {
    const session = {
      did: data.did,
      handle: data.handle || (previous && previous.handle) || '',
      pds: pdsFromDidDoc(data.didDoc) || (previous && previous.pds) || this.service,
      access: data.accessJwt,
      refresh: data.refreshJwt,
      saved_at: new Date().toISOString(),
    };
    this.session = session;
    await this.store.setState({ session });
    return session;
  }

  async createSession() {
    const identifier = String(this.env.BSKY_HANDLE || '').trim().replace(/^@/, '');
    const password = String(this.env.BSKY_APP_PASSWORD || '').trim();
    if (!identifier || !password) {
      throw new BskyError(0, 'NotConfigured', 'BSKY_HANDLE and BSKY_APP_PASSWORD secrets are not set');
    }
    const response = await this.fetch(`${this.service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    if (!response.ok) throw await readError(response);
    return this.saveSession(await response.json(), null);
  }

  async refreshSession(session) {
    const response = await this.fetch(`${this.service}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.refresh}` },
    });
    if (!response.ok) throw await readError(response);
    const data = await response.json();
    if (data.did !== session.did) throw new BskyError(400, 'InvalidDID', 'refreshed session is for another account');
    return this.saveSession(data, session);
  }

  // A refresh token rejected outright (401, ExpiredToken, InvalidToken) means
  // start again with the app password. Anything else (a 5xx, the network) is
  // assumed transient and thrown, keeping the stored session for next time --
  // the same rule as the SDK.
  async ensureSession(force = false) {
    const session = await this.loadSession();
    const now = Math.floor(Date.now() / 1000);
    if (!force && session && session.access && jwtExp(session.access) > now + 120) return session;
    if (session && session.refresh) {
      try {
        return await this.refreshSession(session);
      } catch (err) {
        const dead = err instanceof BskyError &&
          (err.status === 401 || ['ExpiredToken', 'InvalidToken', 'InvalidDID'].includes(err.error));
        if (!dead) throw err;
      }
    }
    return this.createSession();
  }

  // ---- data calls ----

  async get(method, params) {
    let session = await this.ensureSession();
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((item) => query.append(k, item));
      else query.set(k, String(v));
    }
    const qs = query.toString();
    const call = (s) =>
      this.fetch(`${s.pds}/xrpc/${method}${qs ? `?${qs}` : ''}`, {
        headers: { authorization: `Bearer ${s.access}`, 'atproto-proxy': APPVIEW },
      });

    let response = await call(session);
    if (response.status === 401 || response.status === 400) {
      const err = await readError(response);
      if (err.status !== 401 && err.error !== 'ExpiredToken') throw err;
      session = await this.ensureSession(true);
      response = await call(session);
    }
    if (!response.ok) throw await readError(response);
    return response.json();
  }

  getTimeline({ limit = 100, cursor, since } = {}) {
    return this.get('app.bsky.feed.getTimeline', { limit, cursor, since });
  }

  getFeed({ feed, limit = 50, cursor }) {
    return this.get('app.bsky.feed.getFeed', { feed, limit, cursor });
  }

  getListFeed({ list, limit = 50, cursor }) {
    return this.get('app.bsky.feed.getListFeed', { list, limit, cursor });
  }

  getPreferences() {
    return this.get('app.bsky.actor.getPreferences', {});
  }

  getFeedGenerators(feeds) {
    return this.get('app.bsky.feed.getFeedGenerators', { feeds });
  }

  getList(list) {
    return this.get('app.bsky.graph.getList', { list, limit: 1 });
  }
}
