// The real bundle in workerd: the sign-on gate, the page, the JSON API and the
// cron handler, with D1 migrated by wrangler itself. The portal's JWKS and
// Bluesky are faked through Miniflare's outbound service. Run with
// `npm run smoke` (it bundles and migrates first), not as part of `npm test`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// Miniflare 5 takes a new options shape; the v4 shape below is converted.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as b from './fixtures/bsky.js';

const ORIGIN = 'https://skyback.sevitz.com';
const ISSUER = 'https://auth.sevitz.com';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DIST = new URL('../.wrangler/smoke/dist', import.meta.url).pathname;
const DB_ID = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/database_id = "([^"]+)"/)[1];

let mf;
let keys;
const bsky = new b.FakeBluesky();

const b64url = (data) => Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64url');

async function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64url({ iss: ISSUER, aud: 'sevitz-apps', iat: now, nbf: now - 30, exp: now + 3600, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Buffer.from(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(sig).toString('base64url')}`;
}

const sev = () => token({ sub: 'sev', name: 'Sev', role: 'admin', apps: '*' });

async function get(path, { cookie, headers = {}, method = 'GET', body } = {}) {
  return mf.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie: `sev_id=${cookie}` } : {}), ...headers },
    body,
  });
}

before(async () => {
  keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fakeBluesky = bsky.handler();

  bsky.timeline = [
    b.item(b.post({ text: 'Spotted a kingfisher on the Hogsmill this morning', embed: b.images('Blue bird on a branch') })),
    b.item(b.post({ text: 'Train strike next week', embed: b.external('https://example.com/strike', 'Strike dates', 'What runs and what does not') })),
  ];

  mf = new Miniflare(convertV4MiniflareOptions({
    // The bundle as wrangler wrote it: index.js plus the two text modules.
    modulesRoot: DIST,
    modules: readdirSync(DIST)
      .filter((f) => /\.(js|html)$/.test(f))
      .sort((a, b2) => (a === 'index.js' ? -1 : b2 === 'index.js' ? 1 : 0)) // main module first
      .map((f) => ({
        type: f === 'index.js' ? 'ESModule' : 'Text',
        path: `${DIST}/${f}`,
        contents: readFileSync(`${DIST}/${f}`, 'utf8'),
      })),
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: DB_ID },
    bindings: {
      AUTH_ISSUER: ISSUER,
      AUTH_APP: 'skyback',
      GITHUB_REPO: 'sevitz/skyback',
      BSKY_SERVICE: 'https://bsky.social',
      BSKY_HANDLE: 'sev.bsky.social',
      BSKY_APP_PASSWORD: 'aaaa-bbbb-cccc-dddd',
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.host === 'auth.sevitz.com' && url.pathname === '/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
      }
      return fakeBluesky(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.method === 'POST' ? await request.text() : undefined,
      });
    },
  }));
  // Apply the migration through the D1 binding itself (the smoke script has
  // already checked that `wrangler d1 migrations apply` accepts it).
  const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const statements = [];
  let current = '';
  for (const line of sql.split('\n')) {
    current += `${line}\n`;
    const inTrigger = /^\s*CREATE TRIGGER/i.test(current);
    if ((inTrigger && /^\s*END;\s*$/i.test(line)) || (!inTrigger && /;\s*$/.test(line))) {
      statements.push(current.trim());
      current = '';
    }
  }
  const db = await mf.getD1Database('DB');
  await db.batch(statements.map((st) => db.prepare(st)));
});

after(async () => {
  if (mf) await mf.dispose();
});

test('public routes: health and icons', async () => {
  const h = await get('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true, version: pkg.version });
  const ico = await get('/favicon.ico');
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get('content-type'), 'image/x-icon');
  await ico.arrayBuffer();
});

test('signed out: the front page lands on the demo, /login goes to the portal, the API says 401', async () => {
  const page = await get('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), 'https://skyback.sevitz.com/demo');
  const login = await get('/login');
  assert.equal(login.status, 302);
  assert.match(login.headers.get('location'), /^https:\/\/auth\.sevitz\.com\/login\?next=https%3A%2F%2Fskyback\.sevitz\.com%2Flogin&app=skyback$/);
  const lapsed = await get('/', { cookie: 'not-a-token' });
  assert.equal(lapsed.status, 302);
  assert.match(lapsed.headers.get('location'), /^https:\/\/auth\.sevitz\.com\/login\?next=https%3A%2F%2Fskyback\.sevitz\.com%2F&app=skyback$/, 'a stale cookie still renews through the portal');
  const back = await get('/login', { cookie: await sev() });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), 'https://skyback.sevitz.com/');
  const api = await get('/api/status');
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, 'Not signed in');
});

test('only an admin identity with access gets in', async () => {
  const parent = await get('/', { cookie: await token({ sub: 'parent-user', name: 'Parent', role: 'parent', apps: '*' }) });
  assert.equal(parent.status, 403);
  await parent.text();
  const noApp = await get('/', { cookie: await token({ sub: 'x', name: 'X', role: 'admin', apps: ['other-app'] }) });
  assert.equal(noApp.status, 403);
  await noApp.text();
  const forged = (await sev()).replace(/\.[^.]+\./, `.${b64url({ iss: ISSUER, aud: 'sevitz-apps', sub: 'sev', role: 'admin', apps: '*', exp: 9999999999 })}.`);
  const bad = await get('/api/status', { cookie: forged });
  assert.equal(bad.status, 401);
  await bad.text();
});

test('the page, its script and the corner widgets', async () => {
  const cookie = await sev();
  const page = await get('/', { cookie });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(html, new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
  assert.match(html, /<script src="\/app\.js\?v=/);
  for (const id of ['sync-now', 'feeds-btn', 'back-btn', 'feed', 'posted', 'sort', 'backfill', 'status']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /data-demo|class="demo-pill"/);
  assert.match(html, /href="https:\/\/github\.com\/sevitz\/skyback"/);
  assert.match(html, /bug-report-widget\.js/);
  assert.match(html, /whoami-widget\.js/);
  assert.doesNotMatch(html, /\{\{/);

  const js = await get('/app.js', { cookie });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /skyback page script/);

  const who = await get('/api/whoami', { cookie });
  assert.deepEqual(await who.json(), { signedIn: true, sub: 'sev', name: 'Sev', role: 'admin' });
});

test('the demo is public, holds no owner controls, and touches no data', async () => {
  const db = await mf.getD1Database('DB');
  const rowsBefore = (await db.prepare('SELECT (SELECT COUNT(*) FROM usage) + (SELECT COUNT(*) FROM state) AS n').first()).n;
  const page = await get('/demo');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /public/);
  const html = await page.text();
  assert.match(html, /data-demo="1"/);
  assert.match(html, /class="demo-pill"><span>demo<\/span><a href="\/login">login<\/a>/);
  assert.match(html, /id="demo-data"/);
  assert.match(html, /<script src="\/demo\/app\.js\?v=/);
  for (const id of ['sync-now', 'feeds-btn', 'back-btn', 'feeds-panel', 'feed', 'posted', 'sort', 'backfill', 'status', 'notices']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} must not be in the demo DOM`);
  }
  assert.doesNotMatch(html, /whoami-widget|bug-report-widget/);
  assert.doesNotMatch(html, /\{\{/);
  assert.match(html, /theonion\.com/);
  const data = JSON.parse(html.match(/<script type="application\/json" id="demo-data">([\s\S]*?)<\/script>/)[1]);
  assert.ok(data.posts.length >= 5);
  assert.ok(data.posts.every((p) => p.author.handle === 'theonion.com'), 'only the sample account, nothing from the archive');
  const js = await get('/demo/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  await js.text();

  for (const path of ['/', '/app.js', '/api/search?q=a', '/api/status', '/api/feeds', '/api/whoami']) {
    const r = await get(path);
    assert.ok([302, 401].includes(r.status), `${path} must still need a sign-in, got ${r.status}`);
    await r.text();
  }
  for (const path of ['/api/sync', '/api/backfill/step', '/api/feeds/refresh', '/api/feeds/toggle']) {
    const r = await get(path, { method: 'POST', headers: { origin: ORIGIN } });
    assert.equal(r.status, 401, `${path} must still need a sign-in`);
    await r.text();
  }
  const rowsAfter = (await db.prepare('SELECT (SELECT COUNT(*) FROM usage) + (SELECT COUNT(*) FROM state) AS n').first()).n;
  assert.equal(rowsAfter, rowsBefore, 'the demo and the refused requests wrote nothing');
});

test('search further back needs the sign-in, the origin and a real target', async () => {
  const cookie = await sev();
  const noOrigin = await get('/api/backfill/step', { cookie, method: 'POST' });
  assert.equal(noOrigin.status, 403);
  await noOrigin.text();
  const bad = await get('/api/backfill/step', { cookie, method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'not a time' }) });
  assert.equal(bad.status, 400);
  await bad.text();
});

test('POSTs need this origin', async () => {
  const cookie = await sev();
  const none = await get('/api/sync', { cookie, method: 'POST' });
  assert.equal(none.status, 403);
  await none.text();
  const other = await get('/api/sync', { cookie, method: 'POST', headers: { origin: 'https://docs.sevitz.com' } });
  assert.equal(other.status, 403);
  await other.text();
});

test('the cron handler syncs, and search finds it', async () => {
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: '*/10 * * * *' });
  const cookie = await sev();
  const st = await (await get('/api/status', { cookie })).json();
  assert.equal(st.posts, 2, JSON.stringify(st.last_run));
  assert.equal(st.account, 'sev.bsky.social');
  assert.ok(st.last_ok_at);
  assert.ok(st.usage.rows_written > 0, 'real D1 meta is tallied');

  const s = await (await get('/api/search?q=kingfish', { cookie })).json();
  assert.equal(s.results.length, 1);
  assert.match(s.results[0].text, /\u0001kingfisher\u0002/);
  const alt = await (await get('/api/search?q=branch', { cookie })).json();
  assert.equal(alt.results.length, 1, 'alt text');
  const link = await (await get('/api/search?q=has%3Alink%20strike', { cookie })).json();
  assert.equal(link.results.length, 1);
  const weird = await get('/api/search?q=%22%20OR%20%7Btext%7D%20NEAR(', { cookie });
  assert.equal(weird.status, 200);
  await weird.text();
});

test('D1 rows written per new post stay small (the daily budget math)', async (t) => {
  const cookie = await sev();
  const headers = { origin: ORIGIN };
  const before = (await (await get('/api/status', { cookie })).json()).usage;
  bsky.timeline.unshift(...Array.from({ length: 40 }, (_, i) =>
    b.item(b.post({ text: `budget probe ${i} about something long enough to index well`, embed: i % 2 ? b.images('alt text here') : undefined }))));
  const r = await (await get('/api/sync', { cookie, method: 'POST', headers })).json();
  assert.equal(r.catchup.new_posts, 40, JSON.stringify(r));
  const afterSync = (await (await get('/api/status', { cookie })).json()).usage;
  const perPost = (afterSync.rows_written - before.rows_written) / 40;
  t.diagnostic(`rows written per new post: ${perPost.toFixed(1)}; rows read for the run: ${afterSync.rows_read - before.rows_read}`);
  assert.ok(perPost < 12, `${perPost} rows written per post`);

  const again = await (await get('/api/sync', { cookie, method: 'POST', headers })).json();
  assert.equal(again.catchup.new_posts, 0);
  const idle = (await (await get('/api/status', { cookie })).json()).usage;
  t.diagnostic(`a sync with nothing new wrote ${idle.rows_written - afterSync.rows_written} rows`);
  assert.ok(idle.rows_written - afterSync.rows_written < 15);
});

test('sync now and feeds over HTTP', async () => {
  const cookie = await sev();
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  bsky.timeline.unshift(b.item(b.post({ text: 'Fresh post about allotments' })));
  const r = await (await get('/api/sync', { cookie, method: 'POST', headers })).json();
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.catchup.new_posts, 1);

  bsky.preferences = [{ $type: 'app.bsky.actor.defs#savedFeedsPrefV2', items: [{ type: 'feed', value: 'at://did:plc:fm/app.bsky.feed.generator/sci', pinned: true, id: '1' }] }];
  bsky.generators.set('at://did:plc:fm/app.bsky.feed.generator/sci', 'Science');
  bsky.feeds.set('at://did:plc:fm/app.bsky.feed.generator/sci', [b.item(b.post({ text: 'Comet visible tonight' }))]);
  const reload = await (await get('/api/feeds/refresh', { cookie, method: 'POST', headers })).json();
  assert.equal(reload.ok, true);
  const toggle = await get('/api/feeds/toggle', { cookie, method: 'POST', headers, body: JSON.stringify({ uri: 'at://did:plc:fm/app.bsky.feed.generator/sci', enabled: true }) });
  assert.equal(toggle.status, 200);
  await toggle.text();
  const fetched = await (await get('/api/feeds/fetch', { cookie, method: 'POST', headers, body: JSON.stringify({ uri: 'at://did:plc:fm/app.bsky.feed.generator/sci' }) })).json();
  assert.equal(fetched.feeds[0].new_items, 1);
  const feeds = await (await get('/api/feeds', { cookie })).json();
  assert.deepEqual(feeds.feeds.map((f) => [f.name, f.enabled]), [['Following', 1], ['Science', 1]]);
  const comet = await (await get('/api/search?q=comet&feed=' + encodeURIComponent('at://did:plc:fm/app.bsky.feed.generator/sci'), { cookie })).json();
  assert.equal(comet.results.length, 1);
});
