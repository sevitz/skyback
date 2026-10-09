// Serves the real bundle locally with a fake Bluesky full of sample posts and a
// signed-in identity, for working on the page without credentials.
//
//   npm run preview        then open the printed URL
//
// Needs `npm run smoke` (or the dry-run build it starts with) to have written
// .wrangler/smoke/dist first.

import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as b from '../test/fixtures/bsky.js';

const DIST = new URL('../.wrangler/smoke/dist', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8787);
const ISSUER = 'https://auth.sevitz.com';
const DB_ID = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/database_id = "([^"]+)"/)[1];

const keys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'preview', alg: 'RS256', use: 'sig' };
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64url({ alg: 'RS256', typ: 'JWT', kid: 'preview' });
const body = b64url({ iss: ISSUER, aud: 'sevitz-apps', iat: now, nbf: now - 30, exp: now + 86400, sub: 'sev', name: 'Sev', role: 'admin', apps: '*' });
const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Buffer.from(`${head}.${body}`))).toString('base64url');
export const COOKIE = `${head}.${body}.${sig}`;

const p = (h, n) => b.author(h, n);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const ana = p('ana.bsky.social', 'Ana Ruiz');
const tom = p('tomwrites.com', 'Tom Hughes');
const kit = p('kit.bsky.social', 'Kit');
const lab = p('cityplanner.bsky.social', 'Urban Planning Notes');
const quoted = b.post({ by: lab, text: 'Cities that added protected bike lanes saw retail footfall go up, not down. The data from 14 high streets is in.', at: ago(400) });

const bsky = new b.FakeBluesky();
bsky.timeline = [
  b.item(b.post({ by: ana, text: 'Spotted a kingfisher on the Hogsmill this morning, first time in years. Bright blue flash and gone.', embed: b.images('A kingfisher perched on a branch over the river'), at: ago(12) })),
  b.item(b.post({ by: tom, text: 'This is the clearest explainer on heat pumps I have read. Worth ten minutes.', embed: b.external('https://example.com/heat-pumps', 'Heat pumps, explained properly', 'Why they work in cold climates, what they cost to run, and the three mistakes installers make.'), at: ago(55) })),
  b.item(b.post({ by: kit, text: 'Exactly this. Our high street needs it.', embed: b.quote(quoted), at: ago(130) })),
  b.item(b.post({ by: lab, text: 'Thread on the new timetable: what changes for South Western Railway from December.', at: ago(190) }), b.repostBy(ana, ago(150))),
  b.item(b.post({ by: tom, text: 'Sourdough attempt number four. The crumb is finally open!', embed: b.images('A loaf of sourdough cut in half', 'Close up of the crumb'), at: ago(300) })),
  b.item(b.post({ by: ana, text: 'Anyone know a good café near Wimbledon station that is quiet enough to work from?', at: ago(1500) })),
];

// Older posts for trying "Search further back": 20 days at about 12 posts a day,
// with the timeline cursors real Bluesky uses (ISO times). Every few posts mention
// one of these words so there is something to find at each depth.
const OLD_WORDS = ['microsoft', 'telescope', 'sourdough', 'tramlines', 'kestrel', 'allotment'];
const olderAuthors = [ana, tom, kit, lab];
for (let i = 0; i < 20 * 12; i++) {
  const minutesAgo = 1600 + i * 120;
  const word = OLD_WORDS[i % OLD_WORDS.length];
  bsky.timeline.push(b.item(b.post({
    by: olderAuthors[i % olderAuthors.length],
    text: i % 3 === 0 ? `Still thinking about ${word}, day ${Math.floor(i / 12) + 2}.` : `Ordinary post number ${i} about nothing in particular.`,
    at: ago(minutesAgo),
  })));
}
bsky.timeCursors = true;

const mf = new Miniflare(convertV4MiniflareOptions({
  port: PORT,
  host: '127.0.0.1',
  modulesRoot: DIST,
  modules: readdirSync(DIST)
    .filter((f) => /\.(js|html)$/.test(f))
    .sort((x, y) => (x === 'index.js' ? -1 : y === 'index.js' ? 1 : 0))
    .map((f) => ({ type: f === 'index.js' ? 'ESModule' : 'Text', path: `${DIST}/${f}`, contents: readFileSync(`${DIST}/${f}`, 'utf8') })),
  compatibilityDate: '2026-10-01',
  d1Databases: { DB: DB_ID },
  bindings: {
    AUTH_ISSUER: ISSUER,
    AUTH_APP: 'skyback',
    GITHUB_REPO: 'sevitz/skyback',
    BSKY_SERVICE: 'https://bsky.social',
    BSKY_HANDLE: 'sev.bsky.social',
    BSKY_APP_PASSWORD: 'preview',
  },
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.host === 'auth.sevitz.com') return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
    return bsky.handler()(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === 'POST' ? await request.text() : undefined });
  },
}));

const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
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
await db.batch(statements.map((s) => db.prepare(s)));
bsky.preferences = [{ $type: 'app.bsky.actor.defs#savedFeedsPrefV2', items: [
  { type: 'timeline', value: 'following', pinned: true, id: '1' },
  { type: 'feed', value: 'at://did:plc:x/app.bsky.feed.generator/science', pinned: true, id: '2' },
  { type: 'feed', value: 'at://did:plc:x/app.bsky.feed.generator/photos', pinned: false, id: '3' },
] }];
bsky.generators.set('at://did:plc:x/app.bsky.feed.generator/science', 'Science');
bsky.generators.set('at://did:plc:x/app.bsky.feed.generator/photos', 'Wildlife Photography');
await (await mf.getWorker()).scheduled({ cron: '*/10 * * * *' });

console.log(`skyback preview on http://127.0.0.1:${PORT}`);
console.log(`set this cookie for 127.0.0.1: sev_id=${COOKIE}`);
