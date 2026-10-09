// Writes one page of feed items to D1.
//
// Cost model, because it is the whole game on the free plan: a page is four
// queries whatever its size. Two selects find what is already archived (reads
// only), then one INSERT ... SELECT FROM json_each each for the new posts and the
// new sightings. Nothing already archived is written again. A new post costs
// roughly six rows written (the row, its created_at index entry, the FTS shadow
// rows, and its sighting); a post seen again costs one or two rows read.
//
// What is "new" comes from the selects, not from meta.changes -- see store.js.

import { pageRows, sightingKey } from './normalize.js';

const POST_COLUMNS = [
  'uri', 'cid', 'author_did', 'author_handle', 'author_name', 'author_avatar', 'text', 'extra',
  'embed_json', 'created_at', 'indexed_at', 'reply_parent', 'flags', 'like_count', 'repost_count',
  'reply_count', 'first_seen_at',
];
const SIGHTING_COLUMNS = ['uri', 'feed', 'how', 'by_did', 'by_handle', 'appeared_at'];

function insertFromJson(table, columns, conflict) {
  const select = columns.map((c) => `json_extract(j.value, '$.${c}')`).join(', ');
  // `WHERE true` is required: without it SQLite parses ON CONFLICT as part of
  // the json_each join rather than the upsert clause.
  return `INSERT INTO ${table} (${columns.join(', ')})
          SELECT ${select} FROM json_each(?) AS j WHERE true
          ON CONFLICT(${conflict}) DO NOTHING`;
}

const INSERT_POSTS = insertFromJson('posts', POST_COLUMNS, 'uri');
const INSERT_SIGHTINGS = insertFromJson('sightings', SIGHTING_COLUMNS, 'uri, feed, how, by_did');

export async function ingestPage(store, items, feed, nowIso = new Date().toISOString()) {
  const { posts, sightings, primary, oldest } = pageRows(items, feed, nowIso);
  if (!posts.size) return { items: 0, newPosts: 0, newSightings: 0, newPrimary: 0, oldest };

  const uris = JSON.stringify([...posts.keys()]);
  const [knownPosts, knownSightings] = await Promise.all([
    store.all('SELECT uri FROM posts WHERE uri IN (SELECT value FROM json_each(?))', uris),
    store.all(
      'SELECT uri, how, by_did FROM sightings WHERE uri IN (SELECT value FROM json_each(?)) AND feed = ?',
      uris,
      feed
    ),
  ]);
  const havePost = new Set(knownPosts.map((r) => r.uri));
  const haveSighting = new Set(knownSightings.map((r) => sightingKey(r)));

  const newPosts = [...posts.values()].filter((p) => !havePost.has(p.uri));
  const newSightings = [];
  let newPrimary = 0;
  for (const [key, s] of sightings) {
    if (haveSighting.has(key)) continue;
    newSightings.push(s);
    if (primary.has(key)) newPrimary += 1;
  }

  await store.batch([
    newPosts.length && { sql: INSERT_POSTS, params: [JSON.stringify(newPosts)] },
    newSightings.length && { sql: INSERT_SIGHTINGS, params: [JSON.stringify(newSightings)] },
    newPosts.length && {
      // CAST both sides: a JS number can bind as REAL, and '5.0' is not a count.
      sql: "UPDATE state SET value = CAST(value AS INTEGER) + CAST(? AS INTEGER) WHERE key = 'posts_count'",
      params: [newPosts.length],
    },
  ]);

  return {
    items: primary.size,
    newPosts: newPosts.length,
    newSightings: newSightings.length,
    newPrimary,
    oldest,
  };
}
