// Rebuilds the public demo's sample posts: a random selection of recent posts from
// a public Bluesky account (The Onion), written to src/worker/ui/demo-data.json.
//
//   npm run refresh-demo                 fetch the live feed, pick a fresh sample
//   node tools/refresh-demo.js FILE.json use a saved getAuthorFeed response instead
//
// It calls Bluesky's public, unauthenticated API for a public account: nothing of
// yours is sent and no credentials are used. Review the diff and commit the result.
// To drop a post (or the whole demo) for any reason, delete it from the JSON or
// re-run; the Worker only ever serves what is in that file.

import { readFileSync, writeFileSync } from 'node:fs';
import { postRow, postUrl } from '../src/worker/normalize.js';

export const ACTOR = 'theonion.com';
export const COUNT = 30;
const OUT = new URL('../src/worker/ui/demo-data.json', import.meta.url);
const API = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${ACTOR}&filter=posts_no_replies&limit=100`;

// Satire about sex offences, death and violence reads very differently on its own
// as a demo page. These are left out of the sample; politics are not filtered, so
// look over the diff before committing a new sample.
const EXCLUDE = /\b(sex|sexual|sexually|offenders?|rape[sd]?|abuse[sd]?|kill(?:s|ed|ing)?|murder\w*|suicide|dies|died|dead|death|shoot\w*|massacre|terror\w*|bomb\w*|execut\w*|assault\w*|rapists?|osama|bin laden|hitler|nazis?|shit\w*|fuck\w*|porn\w*|firing squad|autopsy|corpses?|body-dumping|cadaver|lynch\w*|guns?|gunmen|gunman)\b/i;

const STOP = new Set(['theonion', 'about', 'after', 'before', 'could', 'every', 'their', 'there', 'these', 'those', 'which', 'while', 'would', 'where', 'being', 'should', 'under', 'today', 'again']);

function shuffle(list, random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Everything a card can show: the post, its link card and quoted post, and image
// descriptions. A harmless headline can sit on a link card that is not.
export function shownText(r) {
  const e = r.embed || {};
  return [r.text, r.extra, e.external && e.external.title, e.external && e.external.description,
    e.quote && e.quote.text, ...((e.images || []).map((i) => i.alt))].filter(Boolean).join(' \n ');
}

// Same shape the page's card() gets from /api/search, so the demo renders exactly
// like the real thing. Reposts and replies are left out.
export function toResult(pv, nowIso) {
  const r = postRow(pv, nowIso);
  let embed = null;
  try {
    embed = r.embed_json ? JSON.parse(r.embed_json) : null;
  } catch {
    embed = null;
  }
  return {
    uri: r.uri,
    url: postUrl(r.uri),
    author: {
      did: r.author_did,
      handle: r.author_handle,
      name: r.author_name,
      avatar: r.author_avatar,
      url: `https://bsky.app/profile/${r.author_did}`,
    },
    created_at: r.created_at,
    text: r.text,
    extra: r.extra,
    embed,
    flags: r.flags,
    counts: { likes: r.like_count, reposts: r.repost_count, replies: r.reply_count },
    seen: [],
  };
}

// Example searches built from words that really occur in the sample, so none of
// them can come back empty.
export function chipsFor(posts) {
  const chips = [];
  const counts = new Map();
  for (const p of posts) {
    for (const w of new Set(String(p.text).toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[a-z]{6,}/g) || [])) {
      if (!STOP.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const rare = [...counts.entries()]
    .filter(([w, n]) => n === 1 && w.length >= 8)
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, 1)
    .map(([w]) => w);
  chips.push(...rare);
  const withTwo = posts.find((p) => /[A-Za-z]{4,} [A-Za-z]{4,}/.test(p.text));
  if (withTwo) chips.push(`"${withTwo.text.match(/[A-Za-z]{4,} [A-Za-z]{4,}/)[0].toLowerCase()}"`);
  chips.push(`from:${ACTOR}`);
  if (posts.some((p) => p.embed && p.embed.images && p.embed.images.length)) chips.push('has:image');
  else if (posts.some((p) => p.embed && p.embed.external)) chips.push('has:link');
  return [...new Set(chips)].slice(0, 5);
}

export function buildDemo(feedJson, { count = COUNT, random = Math.random, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const items = Array.isArray(feedJson && feedJson.feed) ? feedJson.feed : [];
  const originals = items
    .filter((it) => it && it.post && !it.reason && !(it.post.record && it.post.record.reply))
    .map((it) => toResult(it.post, nowIso))
    .filter((r) => r.text && !EXCLUDE.test(shownText(r)));
  if (originals.length < 5) throw new Error(`only ${originals.length} usable posts in the feed response`);
  const posts = shuffle(originals, random).slice(0, count).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return {
    source: `https://bsky.app/profile/${ACTOR}`,
    generated_at: nowIso,
    posts,
    chips: chipsFor(posts),
  };
}

async function main() {
  const file = process.argv[2];
  let feed;
  if (file) feed = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const res = await fetch(API, { headers: { accept: 'application/json', 'user-agent': 'skyback-demo-refresh (+https://github.com/sevitz/skyback)' } });
    if (!res.ok) throw new Error(`Bluesky said ${res.status}`);
    feed = await res.json();
  }
  const demo = buildDemo(feed);
  writeFileSync(OUT, JSON.stringify(demo, null, 1) + '\n');
  console.log(`wrote ${demo.posts.length} posts from @${ACTOR}; chips: ${demo.chips.join('  ')}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(String((err && err.message) || err));
    process.exit(1);
  });
}
