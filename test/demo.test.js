// The demo's sample builder: runs against a recorded-style response, never the
// live API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from './fixtures/bsky.js';
import { buildDemo, chipsFor, shownText, COUNT } from '../tools/refresh-demo.js';

const onion = b.author('theonion.com', 'The Onion');

function feed(n, extra = []) {
  const items = Array.from({ length: n }, (_, i) =>
    b.item(b.post({ by: onion, text: `Headline number ${i} about municipal ${['tramlines', 'pigeons', 'zoning'][i % 3]} budgets` })));
  return { feed: [...items, ...extra] };
}

test('keeps at most COUNT posts, newest first, in the shape the page renders', () => {
  const demo = buildDemo(feed(80));
  assert.equal(demo.posts.length, COUNT);
  const times = demo.posts.map((p) => p.created_at);
  assert.deepEqual(times, [...times].sort().reverse());
  const p = demo.posts[0];
  for (const key of ['uri', 'url', 'author', 'created_at', 'text', 'embed', 'counts', 'seen']) assert.ok(key in p, key);
  assert.equal(p.author.handle, 'theonion.com');
  assert.match(p.url, /^https:\/\/bsky\.app\/profile\//);
});

test('leaves out reposts, replies and the sensitive subjects', () => {
  const repost = b.item(b.post({ by: onion, text: 'a repost that must not appear' }), b.repostBy(onion, '2026-10-09T07:00:00.000Z'));
  const reply = b.item(b.post({ by: onion, text: 'a reply that must not appear', record: { reply: { parent: { uri: 'at://x/y/z' }, root: { uri: 'at://x/y/z' } } } }));
  const dark = b.item(b.post({ by: onion, text: 'Man executed over a parking dispute' }));
  const demo = buildDemo(feed(10, [repost, reply, dark]));
  const texts = demo.posts.map((p) => p.text).join('\n');
  assert.doesNotMatch(texts, /must not appear/);
  assert.doesNotMatch(texts, /executed/);
});

test('a different random pick gives a different sample, and a thin feed is refused', () => {
  const a = buildDemo(feed(80), { random: () => 0.1 });
  const c = buildDemo(feed(80), { random: () => 0.9 });
  assert.notDeepEqual(a.posts.map((p) => p.uri), c.posts.map((p) => p.uri));
  assert.throws(() => buildDemo(feed(3)), /usable posts/);
});

test('every example search finds something in the sample', () => {
  const demo = buildDemo(feed(60));
  assert.ok(demo.chips.length >= 2);
  for (const chip of demo.chips) {
    const hits = demo.posts.filter((p) => {
      if (chip.startsWith('from:')) return p.author.handle.includes(chip.slice(5));
      if (chip === 'has:image') return p.embed && p.embed.images && p.embed.images.length;
      if (chip === 'has:link') return p.embed && p.embed.external;
      const needle = chip.replace(/"/g, '').toLowerCase();
      return p.text.toLowerCase().includes(needle);
    });
    assert.ok(hits.length > 0, `chip ${chip} matches nothing`);
  }
  assert.deepEqual(chipsFor(demo.posts), demo.chips);
});

test('a harmless headline on a link card with a sensitive description is left out too', () => {
  const card = b.item(b.post({ by: onion, text: 'Perfectly nice headline here',
    embed: b.external('https://example.com/a', 'Perfectly nice headline here', 'Administrators vowed that offenders would be punished') }));
  const demo = buildDemo(feed(10, [card]));
  assert.ok(!demo.posts.some((p) => p.text === 'Perfectly nice headline here'));
  for (const p of demo.posts) assert.doesNotMatch(shownText(p), /offenders|rapists?|sexual/i);
});
