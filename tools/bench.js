// How much CPU one timeline page costs: the free plan allows 10ms per
// invocation, cron included. Builds a realistic 100 item getTimeline response
// (replies carrying their parent and root, reposts, images, link cards,
// quotes), then times what a sync does with it: JSON.parse, pageRows, and the
// JSON.stringify that feeds json_each. Node's V8 is the same engine workerd runs.
//
//   node tools/bench.js

import * as b from '../test/fixtures/bsky.js';
import { pageRows } from '../src/worker/normalize.js';

const people = ['alice.bsky.social', 'bob.example.com', 'carol.bsky.social', 'dan.bsky.social'].map((h) => b.author(h));
const words = 'the quick brown fox jumps over a lazy dog while trains run late again and heat pumps hum'.split(' ');
const sentence = (n) => Array.from({ length: n }, (_, i) => words[(i * 7) % words.length]).join(' ');

function richPost(i) {
  const by = people[i % people.length];
  const kind = i % 5;
  const embed = kind === 0 ? b.images('A photo of ' + sentence(12), 'Another ' + sentence(8))
    : kind === 1 ? b.external(`https://example.com/a/${i}`, sentence(8), sentence(30))
    : kind === 2 ? b.quote(b.post({ by: people[(i + 1) % 4], text: sentence(40), embed: b.images(sentence(10)) }))
    : undefined;
  return b.post({
    by,
    text: sentence(45),
    embed,
    facets: [{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: `https://example.org/${i}` }] }],
  });
}

function page() {
  return {
    cursor: 'abc',
    startCursor: 'def',
    feed: Array.from({ length: 100 }, (_, i) => {
      const pv = richPost(i);
      if (i % 3 === 0) return b.item(pv, b.replyTo(richPost(i + 1000), richPost(i + 2000)));
      if (i % 7 === 0) return b.item(pv, b.repostBy(people[0], pv.indexedAt));
      return b.item(pv);
    }),
  };
}

const body = JSON.stringify(page());
console.log(`response size: ${(body.length / 1024).toFixed(0)} KB for 100 items`);

function once() {
  const t0 = performance.now();
  const data = JSON.parse(body);
  const t1 = performance.now();
  const rows = pageRows(data.feed, 'following', new Date().toISOString());
  const t2 = performance.now();
  JSON.stringify([...rows.posts.values()]);
  JSON.stringify([...rows.sightings.values()]);
  const t3 = performance.now();
  return [t1 - t0, t2 - t1, t3 - t2];
}

// A cold isolate is closer to a cron run than a warmed loop, so report the first
// run as well as the steady state.
const first = once();
for (let i = 0; i < 50; i++) once();
const runs = Array.from({ length: 50 }, once);
const avg = (k) => runs.reduce((s, r) => s + r[k], 0) / runs.length;
console.log(`first run:  parse ${first[0].toFixed(2)}ms, normalise ${first[1].toFixed(2)}ms, stringify ${first[2].toFixed(2)}ms`);
console.log(`warm:       parse ${avg(0).toFixed(2)}ms, normalise ${avg(1).toFixed(2)}ms, stringify ${avg(2).toFixed(2)}ms`);
console.log(`per item, cold: ${((first[0] + first[1] + first[2]) / 100).toFixed(3)}ms`);
