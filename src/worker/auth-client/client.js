// GENERATED FILE -- do not edit here.
//
// Source of truth: app-ops/lib/auth-client/client.js
// Refresh with:   zsh ~/Code/app-ops/bin/lib-sync.sh --install
// Check drift:    zsh ~/Code/app-ops/bin/lib-sync.sh
//
// ---------------------------------------------------------------------------
//
// The whole of what an app has to do to join the family sign-on.
//
// An app holds NOTHING secret. It fetches auth.sevitz.com's public key over
// JWKS and verifies the identity cookie offline, so a compromise of this app
// cannot forge an identity for any other, and rotating the portal's key needs no
// redeploy here.
//
// This module answers "who is this". It has no opinion about what they may do:
// that is the app's own business, and the moment this file knows what a recipe
// or a calendar is, the split is wrong.
//
// Config, both plain [vars] in wrangler.toml, neither a secret:
//   AUTH_ISSUER  "https://auth.sevitz.com"  -- must match exactly, no trailing slash
//   AUTH_APP     this app's name            -- checked against the identity's `apps`
//
// Typical use, as the last gate before the app's own routes:
//
//   const who = await requireIdentity(request, env);
//   if (who instanceof Response) return who;      // 302 to the portal, or 403
//   // ... who.sub / who.role from here on
//
// For a JSON API, pass { json: true } so an expired identity is a 401 rather
// than a redirect the caller's fetch cannot follow.

const IDENTITY_COOKIE = 'sev_id';
const APP_AUDIENCE = 'sevitz-apps';

// Access-style key cache: keyed by `kid`, one hour, and a miss forces a refetch
// rather than failing until the TTL lapses. That last part matters -- without it
// every rotation of the portal's key locks this app out for up to an hour.
const KEY_TTL_MS = 60 * 60 * 1000;
let keyCache = { issuer: null, fetchedAt: 0, keys: new Map() };

// Stops a token with a bogus `kid` from causing a JWKS fetch per request.
let lastForcedFetch = 0;
const FORCE_COOLDOWN_MS = 10 * 1000;

function b64urlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function b64urlToJson(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
}

function normalizeIssuer(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

async function loadKeys(issuer, force) {
  const fresh = !force
    && keyCache.issuer === issuer
    && Date.now() - keyCache.fetchedAt < KEY_TTL_MS
    && keyCache.keys.size > 0;
  if (fresh) return keyCache.keys;

  const resp = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const { keys } = await resp.json();

  const imported = new Map();
  for (const jwk of keys || []) {
    if (!jwk.kid) continue;
    imported.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    ));
  }
  keyCache = { issuer, fetchedAt: Date.now(), keys: imported };
  return imported;
}

// Returns { sub, name, role, apps } for a valid identity, or null. Never throws:
// a malformed cookie, an expired token or a JWKS blip are all just "not signed
// in", so the caller can send them to the portal rather than 500.
export async function readIdentity(request, env) {
  const issuer = normalizeIssuer(env.AUTH_ISSUER);
  if (!issuer) return null;

  const token = readCookie(request, IDENTITY_COOKIE);
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  try {
    const header = b64urlToJson(headerB64);
    // Pinned, not read from the token. An `alg` an attacker controls is how JWT
    // libraries get talked into accepting "none" or an HMAC verified with the
    // public key as its secret.
    if (header.alg !== 'RS256' || !header.kid) return null;

    let keys = await loadKeys(issuer, false);
    let key = keys.get(header.kid);
    if (!key && Date.now() - lastForcedFetch > FORCE_COOLDOWN_MS) {
      lastForcedFetch = Date.now();
      keys = await loadKeys(issuer, true);
      key = keys.get(header.kid);
    }
    if (!key) return null;

    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' }, key, b64urlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!ok) return null;

    const payload = b64urlToJson(payloadB64);
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== issuer) return null;
    if (payload.aud !== APP_AUDIENCE) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now) return null;
    if (!payload.sub || !payload.role) return null;

    return {
      sub: payload.sub,
      name: payload.name || payload.sub,
      role: payload.role,
      apps: payload.apps,
    };
  } catch {
    return null;
  }
}

// Does this identity's `apps` claim admit it to this app? '*' means every app.
// Anything unparseable means none -- a corrupt or hostile claim must never widen
// access.
export function mayEnter(identity, app) {
  if (!app) return true;
  if (identity.apps === '*') return true;
  return Array.isArray(identity.apps) && identity.apps.includes(app);
}

// Where to send somebody who is not signed in. `next` is the absolute URL they
// were trying to reach, so the portal can send them back to it.
export function loginUrl(env, request) {
  const issuer = normalizeIssuer(env.AUTH_ISSUER);
  const params = new URLSearchParams({ next: request.url });
  if (env.AUTH_APP) params.set('app', env.AUTH_APP);
  return `${issuer}/login?${params}`;
}

// The one call an app makes. Returns an identity, or a Response to return as-is.
//
// A browser gets a 302 to the portal, which is what makes the invisible refresh
// work: the portal recognises its own long-lived session and bounces straight
// back with a fresh identity, no form. A JSON caller gets 401 instead, because a
// cross-origin redirect is not something in-page fetch can follow -- it fails
// CORS and rejects with an opaque TypeError, which is exactly the trap that cost
// crawlbot a release.
export async function requireIdentity(request, env, options = {}) {
  const identity = await readIdentity(request, env);

  if (!identity) {
    if (options.json) {
      return new Response(JSON.stringify({ ok: false, error: 'Not signed in' }), {
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return Response.redirect(loginUrl(env, request), 302);
  }

  if (!mayEnter(identity, env.AUTH_APP)) {
    return new Response(
      options.json ? JSON.stringify({ ok: false, error: 'No access' }) : 'No access to this app',
      {
        status: 403,
        headers: {
          'content-type': options.json
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8',
        },
      }
    );
  }

  return identity;
}
