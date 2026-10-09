import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postRow, pageRows, FLAG, postUrl } from '../src/worker/normalize.js';
import * as b from './fixtures/bsky.js';

const NOW = '2026-10-09T08:00:00.000Z';
const bob = b.author('bob.example.com', 'Bob Builder');

test('plain post: text, author, counts, url', () => {
  const pv = b.post({ by: bob, text: 'The new café near the station opened today' });
  const r = postRow(pv, NOW);
  assert.equal(r.uri, pv.uri);
  assert.equal(r.author_handle, 'bob.example.com');
  assert.equal(r.author_name, 'Bob Builder');
  assert.equal(r.text, 'The new café near the station opened today');
  assert.equal(r.flags, 0);
  assert.equal(r.like_count, 10);
  assert.equal(r.embed_json, null);
  assert.equal(r.first_seen_at, NOW);
  assert.match(postUrl(pv.uri), /^https:\/\/bsky\.app\/profile\/did:plc:bobexamplecom\/post\/3m/);
});

test('images, gallery and video: alt text is searchable and flags set', () => {
  const a = postRow(b.post({ embed: b.images('A tabby cat asleep on a radiator', 'Second photo') }), NOW);
  assert.equal(a.flags & FLAG.image, FLAG.image);
  assert.match(a.extra, /tabby cat asleep/);
  assert.equal(JSON.parse(a.embed_json).images.length, 2);

  const g = postRow(b.post({ embed: b.gallery('Mountain lake at dawn') }), NOW);
  assert.equal(g.flags & FLAG.image, FLAG.image);
  assert.match(g.extra, /Mountain lake/);
  assert.match(JSON.parse(g.embed_json).images[0].thumb, /^https:\/\/cdn\.bsky\.app/);

  const v = postRow(b.post({ embed: b.video('Timelapse of a sourdough rise') }), NOW);
  assert.equal(v.flags & FLAG.video, FLAG.video);
  assert.match(v.extra, /sourdough/);
});

test('link card and facets: title, description and full URL are searchable', () => {
  const pv = b.post({
    text: 'worth reading example.com/long...',
    embed: b.external('https://example.com/long/article-about-heat-pumps', 'Heat pumps explained', 'Why they work in cold climates'),
    facets: [
      { index: { byteStart: 13, byteEnd: 33 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/long/article-about-heat-pumps' }] },
      { index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'energy' }] },
    ],
  });
  const r = postRow(pv, NOW);
  assert.equal(r.flags & FLAG.link, FLAG.link);
  assert.match(r.extra, /Heat pumps explained/);
  assert.match(r.extra, /cold climates/);
  assert.match(r.extra, /#energy/);
  // The link appears in the facet and the card; it is stored once.
  assert.equal(r.extra.split('https://example.com/long/article-about-heat-pumps').length, 2);
});

test('quote posts and quote with media', () => {
  const inner = b.post({ by: bob, text: 'Original thought about trams', embed: b.images('A tram in Lisbon') });
  const q = postRow(b.post({ text: 'This!', embed: b.quote(inner) }), NOW);
  assert.equal(q.flags & FLAG.quote, FLAG.quote);
  assert.match(q.extra, /Original thought about trams/);
  assert.match(q.extra, /@bob\.example\.com/);
  assert.match(q.extra, /A tram in Lisbon/); // the quoted post's own alt text
  assert.equal(JSON.parse(q.embed_json).quote.handle, 'bob.example.com');

  const qm = postRow(b.post({ text: 'see', embed: b.quoteWithMedia(inner, b.images('My own photo of the depot')) }), NOW);
  assert.equal(qm.flags & (FLAG.quote | FLAG.image), FLAG.quote | FLAG.image);
  assert.match(qm.extra, /Original thought/);
  assert.match(qm.extra, /depot/);
});

test('a createdAt from the future is clamped to indexedAt', () => {
  const pv = b.post({ text: 'time traveller' });
  pv.record.createdAt = '2099-01-01T00:00:00Z';
  const r = postRow(pv, NOW);
  assert.equal(r.created_at, pv.indexedAt);
});

test('junk input does not throw', () => {
  const r = postRow({ uri: 'at://did:plc:x/app.bsky.feed.post/1', record: {}, author: {} }, NOW);
  assert.equal(r.author_did, 'did:plc:x');
  const rows = pageRows([null, {}, { post: { uri: 1 } }, { post: { $type: 'app.bsky.feed.defs#blockedPost', uri: 'x' } }], 'following', NOW);
  assert.equal(rows.posts.size, 0);
});

test('page rows: reposts, reply context, de-duplication', () => {
  const carol = b.author('carol.bsky.social', 'Carol');
  const parent = b.post({ by: bob, text: 'Parent post about bikes' });
  const reply = b.post({ by: carol, text: 'Agree about bikes', record: { reply: { parent: { uri: parent.uri, cid: parent.cid }, root: { uri: parent.uri, cid: parent.cid } } } });
  const original = b.post({ by: bob, text: 'Something reposted' });
  const items = [
    b.item(reply, b.replyTo(parent)),
    b.item(original, b.repostBy(carol, '2026-10-09T07:59:00.000Z')),
    b.item(original), // the same post, also there on its own
    b.item(parent),
  ];
  const r = pageRows(items, 'following', NOW);
  assert.equal(r.posts.size, 3);
  const how = [...r.sightings.values()].map((s) => `${s.how}:${s.by_handle}`).sort();
  assert.deepEqual(how, ['parent:', 'post:', 'post:', 'post:', 'repost:carol.bsky.social'].sort());
  assert.equal(r.primary.size, 4);
  assert.equal(postRow(reply, NOW).flags & FLAG.reply, FLAG.reply);
  assert.equal(postRow(reply, NOW).reply_parent, parent.uri);
  const repost = [...r.sightings.values()].find((s) => s.how === 'repost');
  assert.equal(repost.appeared_at, '2026-10-09T07:59:00.000Z');
});
