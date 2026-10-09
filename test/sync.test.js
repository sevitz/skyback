// End to end against real SQL (the migration, FTS5, json_each) and a fake
// Bluesky: sync, catch up with `since`, gaps, search further back, feeds, sessions, the
// budget guards, and search over the result.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.js';
import * as b from './fixtures/bsky.js';
import { runSync, backfillStep } from '../src/worker/sync.js';
import { Store, utcDay } from '../src/worker/store.js';
import { search, status, parseQuery, ftsExpression } from '../src/worker/search.js';
import { reloadSavedFeeds, listFeeds, setFeedEnabled } from '../src/worker/feeds.js';

let db;
let bsky;
let env;
const realFetch = globalThis.fetch;

const alice = b.author('alice.bsky.social', 'Alice');
const bob = b.author('bob.example.com', 'Bob');
const carol = b.author('carol.bsky.social', 'Carol Danvers');

function filler(count, by = alice, word = 'filler') {
  return Array.from({ length: count }, (_, i) => b.item(b.post({ by, text: `${word} post number ${i}` })));
}

beforeEach(() => {
  db = freshDb();
  bsky = new b.FakeBluesky();
  globalThis.fetch = bsky.handler();
  env = {
    DB: db,
    BSKY_SERVICE: 'https://bsky.social',
    BSKY_HANDLE: '@sev.bsky.social',
    BSKY_APP_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
    MAX_ITEMS_PER_RUN: '1000',
    TIMELINE_PAGE_SIZE: '100',
    MAX_FETCHES_PER_RUN: '40',
    CATCHUP_MAX_PAGES: '3',
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const store = () => new Store(db);
const q = (text, opts = {}) => search(store(), { q: text, ...opts });
const calls = (method) => bsky.calls.filter((c) => c.method === method);

test('first run archives the timeline and searches find text, alt text, link cards and quotes', async () => {
  const inner = b.post({ by: bob, text: 'Thinking about tram networks' });
  bsky.timeline = [
    b.item(b.post({ by: alice, text: 'The new Café by the station is great' })),
    b.item(b.post({ by: bob, text: 'look', embed: b.images('A heron standing in the Hogsmill river') })),
    b.item(b.post({ by: carol, text: 'read this', embed: b.external('https://example.com/pumps', 'Heat pumps explained', 'Why they work in the cold') })),
    b.item(b.post({ by: alice, text: 'yes', embed: b.quote(inner) })),
    b.item(b.post({ by: carol, text: 'Sourdough again' }), b.repostBy(bob, '2026-10-09T07:00:00.000Z')),
  ];
  const r = await runSync(env, { now: new Date('2026-10-09T08:00:00Z') });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.catchup.pages, 1);
  assert.equal(r.catchup.new_posts, 5);
  assert.equal(db.q("SELECT value FROM state WHERE key = 'posts_count'")[0].value, '5');

  // Session: created at the entryway, data from the PDS with the proxy header.
  assert.equal(calls('com.atproto.server.createSession').length, 1);
  assert.equal(calls('app.bsky.feed.getTimeline')[0].host, 'pds.example');

  assert.equal((await q('cafe')).results.length, 1, 'accents fold');
  assert.equal((await q('heron hogs')).results.length, 1, 'alt text, prefix');
  assert.equal((await q('heat pumps')).results.length, 1, 'link card');
  assert.equal((await q('example.com/pumps')).results.length, 1, 'url');
  assert.equal((await q('tram')).results.length, 1, 'quoted post text');
  assert.equal((await q('"tram networks"')).results.length, 1);
  assert.equal((await q('sourdough')).results[0].seen[0].by, 'bob.example.com', 'repost recorded');
  assert.equal((await q('from:carol')).results.length, 2);
  assert.equal((await q('from:danvers')).results.length, 2, 'display name');
  assert.equal((await q('has:image')).results.length, 1);
  assert.equal((await q('has:link heat')).results.length, 1);
  assert.equal((await q('')).results.length, 5, 'browse newest');

  const hit = (await q('heron')).results[0];
  assert.match(hit.extra, /\u0001heron\u0002/, 'highlight in extra');
  assert.match(hit.url, /^https:\/\/bsky\.app\/profile\/did:plc:/);
});

test('later runs ask only for what is new, using since', async () => {
  bsky.timeline = filler(30);
  await runSync(env);
  const sinceAfterFirst = db.q("SELECT value FROM state WHERE key = 'timeline_since'")[0].value;
  assert.ok(sinceAfterFirst);

  bsky.timeline.unshift(...filler(4, bob, 'fresh'));
  bsky.calls = [];
  const r = await runSync(env);
  assert.equal(r.catchup.new_posts, 4);
  assert.equal(r.catchup.pages, 1);
  const call = calls('app.bsky.feed.getTimeline')[0];
  assert.equal(call.params.since, sinceAfterFirst);
  assert.equal((await q('fresh')).results.length, 4);

  // Nothing new: one cheap page, nothing written.
  const before = db.q('SELECT COUNT(*) AS n FROM posts')[0].n;
  const r3 = await runSync(env);
  assert.equal(r3.catchup.new_posts, 0);
  assert.equal(db.q('SELECT COUNT(*) AS n FROM posts')[0].n, before);
});

test('a server that ignores since still stops at the archive', async () => {
  bsky.ignoreSince = true;
  bsky.timeline = filler(20);
  await runSync(env);
  bsky.timeline.unshift(...filler(3, bob, 'newer'));
  const r = await runSync(env);
  assert.equal(r.catchup.new_posts, 3);
  assert.equal(r.catchup.caught_up, true);
});

test('the first run saves where the rest of the timeline starts and does not page back itself', async () => {
  env.CATCHUP_MAX_PAGES = '1';
  env.MAX_ITEMS_PER_RUN = '50';
  env.TIMELINE_PAGE_SIZE = '50';
  const now = new Date('2026-10-09T08:00:00Z');
  bsky.timeline = Array.from({ length: 350 }, (_, i) =>
    b.item(b.post({ text: `old post ${i}`, at: new Date(now.getTime() - i * 30 * 60000).toISOString() })));
  const r1 = await runSync(env, { now });
  assert.equal(r1.catchup.pages, 1);
  assert.equal(r1.backfill, undefined, 'a sync run no longer backfills');
  const bf = JSON.parse(db.q("SELECT value FROM state WHERE key = 'backfill'")[0].value);
  assert.equal(bf.done, false);
  assert.ok(bf.cursor, 'resume point saved');
  await runSync(env, { now });
  assert.equal(db.q('SELECT COUNT(*) AS n FROM posts')[0].n, 50, 'nothing older was fetched');
});

test('a catch up that runs out of budget leaves a gap, drained on later runs', async () => {
  env.CATCHUP_MAX_PAGES = '1';
  bsky.timeline = filler(10);
  await runSync(env);
  bsky.timeline.unshift(...filler(250, bob, 'burst'));
  env.MAX_ITEMS_PER_RUN = '100';
  const r = await runSync(env);
  assert.equal(r.catchup.gap, true);
  assert.equal(r.catchup.new_posts, 100);
  let total = 100;
  for (let i = 0; i < 4; i++) {
    const rn = await runSync(env);
    total += (rn.catchup ? rn.catchup.new_posts : 0) + (rn.gaps ? rn.gaps.new_posts : 0);
  }
  assert.equal(total, 250);
  assert.equal(JSON.parse(db.q("SELECT value FROM state WHERE key = 'gaps'")[0].value).length, 0);
  assert.equal((await q('burst')).more, true);
});

test('sessions: reused, refreshed when expired, recreated when the refresh token dies', async () => {
  bsky.timeline = filler(3);
  await runSync(env);
  await runSync(env);
  assert.equal(calls('com.atproto.server.createSession').length, 1);
  assert.equal(calls('com.atproto.server.refreshSession').length, 0);

  bsky.accessLifetime = -10; // next tokens issued are already expired
  const s = JSON.parse(db.q("SELECT value FROM state WHERE key = 'session'")[0].value);
  s.access = s.access.replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.`);
  db.q("UPDATE state SET value = ? WHERE key = 'session'", JSON.stringify(s));
  bsky.accessLifetime = 7200;
  await runSync(env);
  assert.equal(calls('com.atproto.server.refreshSession').length, 1);

  db.q("UPDATE state SET value = ? WHERE key = 'session'", JSON.stringify({ ...s, access: s.access }));
  bsky.refreshValid = false;
  const r = await runSync(env);
  assert.equal(r.error, undefined, r.error);
  assert.equal(calls('com.atproto.server.createSession').length, 2);
});

test('a wrong app password is reported, not thrown', async () => {
  bsky.badPassword = true;
  const r = await runSync(env);
  assert.match(r.error, /AuthenticationRequired/);
  const st = await status(store(), { dailyWriteBudget: 1, dailyReadBudget: 1 });
  assert.match(st.last_error.message, /AuthenticationRequired/);
  assert.equal(db.q("SELECT value FROM state WHERE key = 'lock_until'")[0].value, '', 'lock released');
});

test('missing secrets say so', async () => {
  delete env.BSKY_APP_PASSWORD;
  const r = await runSync(env);
  assert.match(r.error, /BSKY_HANDLE and BSKY_APP_PASSWORD/);
});

test('the daily write budget pauses syncing before any Bluesky call', async () => {
  db.q('INSERT INTO usage (day, rows_read, rows_written, runs) VALUES (?, 0, 50000, 1)', utcDay());
  bsky.timeline = filler(3);
  const r = await runSync(env);
  assert.match(r.paused, /write budget/);
  assert.equal(bsky.calls.length, 0);
});

test('usage is tallied per day', async () => {
  bsky.timeline = filler(5);
  await runSync(env);
  const u = db.q('SELECT * FROM usage WHERE day = ?', utcDay())[0];
  assert.ok(u.rows_written > 5, `rows_written ${u.rows_written}`);
  assert.equal(u.runs, 1);
});

test('one sync at a time', async () => {
  const s = store();
  assert.equal(await s.acquireLock(60), true);
  bsky.timeline = filler(2);
  const r = await runSync(env);
  assert.equal(r.paused, 'another sync is running');
  await s.releaseLock();
  const r2 = await runSync(env);
  assert.equal(r2.paused, undefined);
});

test('feeds: reload saved feeds, switch one on, archive it, isolate a broken one', async () => {
  const gen1 = 'at://did:plc:fm/app.bsky.feed.generator/science';
  const gen2 = 'at://did:plc:fm/app.bsky.feed.generator/broken';
  const list = 'at://did:plc:me/app.bsky.graph.list/friends';
  bsky.generators.set(gen1, 'Science');
  bsky.generators.set(gen2, 'Broken feed');
  bsky.preferences = [
    { $type: 'app.bsky.actor.defs#adultContentPref', enabled: false },
    {
      $type: 'app.bsky.actor.defs#savedFeedsPrefV2',
      items: [
        { type: 'timeline', value: 'following', pinned: true, id: '1' },
        { type: 'feed', value: gen1, pinned: true, id: '2' },
        { type: 'feed', value: gen2, pinned: false, id: '3' },
        { type: 'list', value: list, pinned: false, id: '4' },
      ],
    },
  ];
  bsky.feeds.set(gen1, [b.item(b.post({ by: carol, text: 'Jupiter moon discovered' }))]);
  bsky.failFeeds.add(gen2);
  bsky.lists.set(list, [b.item(b.post({ by: bob, text: 'Dinner at ours on Friday' }))]);

  const reload = await reloadSavedFeeds(env, 'test');
  assert.equal(reload.ok, true);
  assert.equal(reload.count, 3);
  let feeds = (await listFeeds(store())).feeds;
  assert.deepEqual(feeds.map((f) => f.name), ['Following', 'Science', 'Broken feed', 'Close friends']);
  assert.equal(feeds.filter((f) => f.enabled).length, 1);

  await setFeedEnabled(store(), gen1, true);
  await setFeedEnabled(store(), gen2, true);
  await setFeedEnabled(store(), list, true);
  assert.equal((await setFeedEnabled(store(), 'following', false)).ok, false);

  bsky.timeline = filler(2);
  const r = await runSync(env);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.feeds.length, 3);
  assert.ok(r.feeds.find((f) => f.error && /UnknownFeed/.test(f.error)));
  assert.equal((await q('jupiter')).results.length, 1);
  assert.equal((await q('jupiter', { feed: gen1 })).results.length, 1);
  assert.equal((await q('jupiter', { feed: 'following' })).results.length, 0);
  assert.equal((await q('jupiter')).results[0].seen[0].feed_name, 'Science');
  assert.equal((await q('dinner', { feed: list })).results.length, 1);

  // Within FEED_INTERVAL_MINUTES the feeds are not fetched again...
  bsky.calls = [];
  await runSync(env);
  assert.equal(calls('app.bsky.feed.getFeed').length, 0);
  // ...unless asked to directly.
  const one = await runSync(env, { only: { feed: gen1 } });
  assert.equal(one.feeds.length, 1);
  assert.equal(calls('app.bsky.feed.getTimeline').length, 1, 'fetch now skips the timeline');

  // A feed removed from Bluesky stays, marked unsaved, still switched on.
  bsky.preferences[1].items = bsky.preferences[1].items.filter((i) => i.value !== gen1);
  await reloadSavedFeeds(env, 'test');
  feeds = (await listFeeds(store())).feeds;
  const sci = feeds.find((f) => f.uri === gen1);
  assert.equal(sci.saved, 0);
  assert.equal(sci.enabled, 1);
});

test('the old savedFeedsPref format is understood', async () => {
  const { savedFeedsFrom } = await import('../src/worker/feeds.js');
  const out = savedFeedsFrom([{
    $type: 'app.bsky.actor.defs#savedFeedsPref',
    pinned: ['at://x/app.bsky.feed.generator/a'],
    saved: ['at://x/app.bsky.feed.generator/a', 'at://x/app.bsky.graph.list/b'],
  }]);
  assert.deepEqual(out, [
    { uri: 'at://x/app.bsky.feed.generator/a', kind: 'feed', pinned: true },
    { uri: 'at://x/app.bsky.graph.list/b', kind: 'list', pinned: false },
  ]);
});

test('search filters: posted window, newest order, paging, and hostile queries run', async () => {
  const now = Date.now();
  bsky.timeline = Array.from({ length: 60 }, (_, i) =>
    b.item(b.post({ text: `bicycle lane ${i}`, at: new Date(now - i * 3600000).toISOString() })));
  await runSync(env);
  const day = await q('bicycle', { posted: '1' });
  assert.equal(day.results.length, 24);
  assert.equal(day.more, false);
  const week = await q('bicycle', { posted: '7' });
  assert.equal(week.results.length, 25);
  assert.equal(week.more, true);
  const newest = await q('bicycle', { sort: 'new' });
  assert.match(newest.results[0].text, /lane 0$/);
  const page2 = await q('bicycle', { sort: 'new', offset: newest.next_offset });
  assert.match(page2.results[0].text, /lane 25$/);
  assert.ok((await q('bicycle', { posted: '1' })).results.every((r) => Date.parse(r.created_at) > now - 86400000 - 1000));

  for (const s of ['a" OR text:"b', 'NEAR(x y) *', '{text} : secret', 'bicycle -lane', 'x OR', '"unterminated', '*', 'AND', 'NOT bicycle', '^bicycle', 'bicycle:lane']) {
    let expr;
    try {
      expr = ftsExpression(parseQuery(s));
    } catch {
      continue;
    }
    await q(s); // must not throw an FTS5 syntax error
    assert.ok(expr === null || typeof expr === 'string');
  }
});

test('retention prunes the oldest posts once a day', async () => {
  env.RETENTION_DAYS = '1';
  const now = new Date();
  bsky.timeline = [
    b.item(b.post({ text: 'recent thing', at: new Date(now.getTime() - 3600000).toISOString() })),
    b.item(b.post({ text: 'ancient thing', at: new Date(now.getTime() - 5 * 86400000).toISOString() })),
  ];
  const r = await runSync(env, { now });
  assert.equal(r.prune.deleted, 1);
  assert.equal((await q('ancient')).results.length, 0, 'gone from the index too');
  assert.equal((await q('recent')).results.length, 1);
  assert.equal(db.q("SELECT value FROM state WHERE key = 'posts_count'")[0].value, '1');
  const r2 = await runSync(env, { now });
  assert.equal(r2.prune, null, 'once a day');
});

test('with the production defaults a run stays inside the free plan caps', async () => {
  for (const k of ['MAX_ITEMS_PER_RUN', 'TIMELINE_PAGE_SIZE', 'MAX_FETCHES_PER_RUN', 'CATCHUP_MAX_PAGES']) delete env[k];
  bsky.timeline = filler(400);
  const r1 = await runSync(env);
  assert.equal(r1.items, 100, 'two pages of 50, then stop');
  assert.ok(r1.fetches <= 12);
  bsky.timeline.unshift(...filler(5, bob, 'live'));
  const r2 = await runSync(env);
  assert.equal(r2.catchup.new_posts, 5);
  assert.ok(r2.items <= 100);
  assert.equal(db.q('SELECT COUNT(*) AS n FROM posts')[0].n, 105, 'a sync run only reads what is new');
  let ended = false;
  for (let i = 0; i < 20 && !ended; i++) {
    const step = await backfillStep(env);
    assert.ok(step.items <= 100 && step.fetches <= 12, 'a step stays inside the caps');
    ended = step.ended;
  }
  assert.equal(ended, true);
  assert.equal(db.q('SELECT COUNT(*) AS n FROM posts')[0].n, 405, 'search further back reaches the end');
});

test('status never counts rows', async () => {
  bsky.timeline = filler(7);
  await runSync(env);
  const st = await status(store(), { dailyWriteBudget: 40000, dailyReadBudget: 1500000 });
  assert.equal(st.posts, 7);
  assert.equal(st.account, 'sev.bsky.social');
  assert.ok(st.oldest <= st.newest);
  assert.equal(JSON.stringify(st).includes('refresh-'), false, 'no tokens in status');
});

// ---- search further back ----

const NOW = new Date('2026-10-09T12:00:00Z');
const DAY = 86400000;

// `days` days of timeline, `perDay` posts a day, newest first, with real ISO cursors.
function days(n, perDay = 20) {
  const step = DAY / perDay;
  return Array.from({ length: n * perDay }, (_, i) =>
    b.item(b.post({ text: `day post ${i}`, at: new Date(NOW.getTime() - i * step).toISOString() })));
}

async function seeded(opts = {}) {
  bsky.timeCursors = true;
  bsky.timeline = days(opts.days || 10, opts.perDay || 20);
  env.TIMELINE_PAGE_SIZE = '10';
  env.MAX_ITEMS_PER_RUN = '10';
  env.CATCHUP_MAX_PAGES = '1';
  await runSync(env, { now: NOW });
  env.MAX_ITEMS_PER_RUN = '1000';
  env.MAX_FETCHES_PER_RUN = '40';
}

const count = () => db.q('SELECT COUNT(*) AS n FROM posts')[0].n;

test('a backfill step goes back exactly one day from where the timeline has been read to', async () => {
  await seeded();
  assert.equal(count(), 10);
  const s1 = await backfillStep(env, { now: NOW });
  assert.equal(s1.ok, true);
  assert.equal(s1.reached, true);
  assert.equal(s1.edge, s1.target, 'the day ends exactly on its boundary');
  const before = count();
  assert.ok(before > 10);
  const oldest = db.q('SELECT MIN(created_at) AS m FROM posts')[0].m;
  assert.ok(oldest >= s1.target, 'nothing older than the target was kept');
  const s2 = await backfillStep(env, { now: NOW });
  assert.equal(Date.parse(s2.target), Date.parse(s1.edge) - DAY, 'the next day starts at the old edge');
  assert.ok(count() > before);
  const dup = db.q('SELECT COUNT(*) - COUNT(DISTINCT uri) AS d FROM posts')[0].d;
  assert.equal(dup, 0, 'nothing added twice');
  const expected = bsky.timeline.filter((it) => it.post.indexedAt >= s2.edge).length;
  assert.equal(count(), expected, 'every post back to the edge is present exactly once, no stretch skipped');
});

test('a target sent back keeps the same day across steps', async () => {
  await seeded();
  env.MAX_ITEMS_PER_RUN = '10';
  const s1 = await backfillStep(env, { now: NOW });
  assert.equal(s1.reached, false, 'one page of 10 is half a day');
  const s2 = await backfillStep(env, { target: s1.target, now: NOW });
  assert.equal(s2.target, s1.target);
  assert.equal(s2.reached, true);
});

test('a backfill step ends at the start of the timeline, then does no work', async () => {
  await seeded({ days: 2 });
  let step;
  for (let i = 0; i < 5; i++) {
    step = await backfillStep(env, { now: NOW });
    if (step.ended) break;
  }
  assert.equal(step.ended, true);
  assert.equal(count(), 40);
  const calls0 = bsky.calls.length;
  const again = await backfillStep(env, { now: NOW });
  assert.equal(again.ended, true);
  assert.equal(bsky.calls.length, calls0, 'no Bluesky call once ended');
});

test('a backfill step stays inside the free plan caps with the production defaults', async () => {
  bsky.timeCursors = true;
  bsky.timeline = days(30, 40);
  await runSync(env, { now: NOW });
  for (const k of ['MAX_ITEMS_PER_RUN', 'TIMELINE_PAGE_SIZE', 'MAX_FETCHES_PER_RUN', 'CATCHUP_MAX_PAGES']) delete env[k];
  const far = new Date(NOW.getTime() - 400 * DAY).toISOString();
  const before = count();
  const step = await backfillStep(env, { target: far, now: NOW });
  assert.equal(step.items, 100, 'a step really does two full pages, not nothing');
  assert.equal(step.pages, 2);
  assert.ok(step.fetches >= 2 && step.fetches <= 12);
  assert.equal(step.reached, false);
  assert.equal(count() - before, 100, 'and writes what it read');
});

test('a backfill step refuses while another sync holds the lock, and releases its own', async () => {
  await seeded();
  db.q("UPDATE state SET value = ? WHERE key = 'lock_until'", '2999-01-01T00:00:00.000Z#x');
  const calls0 = bsky.calls.length;
  const busy = await backfillStep(env, { now: NOW });
  assert.equal(busy.busy, true);
  assert.match(busy.paused, /another sync/);
  assert.equal(bsky.calls.length, calls0);
  db.q("UPDATE state SET value = '' WHERE key = 'lock_until'");
  await backfillStep(env, { now: NOW });
  assert.equal(db.q("SELECT value FROM state WHERE key = 'lock_until'")[0].value, '', 'lock released');
});

test('the daily write budget pauses a backfill step before any Bluesky call', async () => {
  await seeded();
  db.q('INSERT INTO usage (day, rows_read, rows_written, runs) VALUES (?, 0, 50000, 1) ON CONFLICT(day) DO UPDATE SET rows_written = 50000', utcDay());
  const calls0 = bsky.calls.length;
  const r = await backfillStep(env, { now: NOW });
  assert.match(r.paused, /write budget/);
  assert.equal(bsky.calls.length, calls0);
});

test('with no saved resume point a backfill step starts at the top and never skips a stretch', async () => {
  bsky.timeCursors = true;
  bsky.timeline = days(3, 10);
  env.TIMELINE_PAGE_SIZE = '10';
  const step = await backfillStep(env, { now: NOW });
  assert.equal(step.ok, true);
  assert.equal(count(), 10, 'newest page first');
  assert.ok(step.edge < NOW.toISOString());
});

test('a backfill step that fails part way reports it and still releases the lock', async () => {
  await seeded();
  bsky.badPassword = true;
  delete bsky.session_cached;
  db.q("DELETE FROM state WHERE key = 'session'");
  const r = await backfillStep(env, { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid identifier or password|AuthenticationRequired/);
  assert.equal(db.q("SELECT value FROM state WHERE key = 'lock_until'")[0].value, '', 'lock released after an error');
  bsky.badPassword = false;
  const again = await backfillStep(env, { now: NOW });
  assert.equal(again.ok, true, 'and the next step works');
});
