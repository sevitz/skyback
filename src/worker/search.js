// Search over the archive, and the status line.
//
// The search box takes plain words, and a little syntax borrowed from Bluesky's
// own search so it feels familiar:
//
//   words            every word must appear; words of 3+ letters also match as
//                    prefixes, so "remem" finds "remember" -- you are usually
//                    half remembering
//   "exact phrase"   in that order
//   -word            must not appear
//   a OR b           either
//   from:handle      by that person (handle or display name, prefix match)
//   has:image        also video, link, quote, media, reply; -has: to exclude
//   since:2026-10-01 until:2026-10-08   by the post's own date
//
// Words are matched against the post text, image alt text, link card titles and
// descriptions, the quoted post, full link URLs and hashtags. Accents fold, so
// "cafe" finds "Café".
//
// Every user word is quoted before it reaches FTS5, so no input can be an FTS
// syntax error or reach a column filter it did not ask for.

import { FLAG, postUrl } from './normalize.js';

const PAGE = 25;
const MAX_OFFSET = 500;
const HAS = {
  image: FLAG.image,
  images: FLAG.image,
  video: FLAG.video,
  link: FLAG.link,
  links: FLAG.link,
  quote: FLAG.quote,
  reply: FLAG.reply,
  media: FLAG.image | FLAG.video,
};
const WORDISH = /[\p{L}\p{N}]/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function phrase(text, prefix) {
  const t = String(text).trim();
  if (!t || !WORDISH.test(t)) return null;
  return `"${t.replace(/"/g, '""')}"${prefix ? '*' : ''}`;
}

function wordPrefix(word) {
  // Prefix-match words long enough for it to help rather than flood.
  return word.replace(/[^\p{L}\p{N}]/gu, '').length >= 3;
}

function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

export function parseQuery(input) {
  const out = { terms: [], negatives: [], from: [], has: [], notHas: [], since: null, until: null };
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || '').slice(0, 500)))) {
    if (m[2] !== undefined) {
      const p = phrase(m[2], false);
      if (!p) continue;
      if (m[1]) out.negatives.push(p);
      else out.terms.push(p);
      continue;
    }
    const raw = m[3];
    if (raw === 'OR') {
      if (out.terms.length && out.terms[out.terms.length - 1] !== 'OR') out.terms.push('OR');
      continue;
    }
    const neg = raw.startsWith('-') && raw.length > 1;
    const word = neg ? raw.slice(1) : raw;
    const op = word.match(/^(from|has|since|until):(.+)$/i);
    if (op) {
      const key = op[1].toLowerCase();
      const value = op[2];
      if (key === 'from' && !neg) {
        const handle = value.replace(/^@/, '');
        if (phrase(handle, true)) out.from.push(handle);
        continue;
      }
      if (key === 'has' && HAS[value.toLowerCase()]) {
        (neg ? out.notHas : out.has).push(HAS[value.toLowerCase()]);
        continue;
      }
      if ((key === 'since' || key === 'until') && !neg && DATE.test(value)) {
        out[key] = value;
        continue;
      }
      // Anything else that looks like an operator is searched as words.
    }
    const p = phrase(word, wordPrefix(word));
    if (!p) continue;
    if (neg) out.negatives.push(p);
    else out.terms.push(p);
  }
  while (out.terms[out.terms.length - 1] === 'OR') out.terms.pop();
  return out;
}

// The FTS5 MATCH expression for a parsed query, or null when there are no words
// (a filters-only search). Throws a plain message for an exclusions-only query,
// which FTS5 cannot express.
export function ftsExpression(q) {
  let expr = q.terms.length ? q.terms.join(' ') : '';
  if (expr && q.terms.includes('OR')) expr = `(${expr})`;
  if (q.from.length) {
    const who = q.from.map((h) => `{author_handle author_name} : ${phrase(h, true)}`).join(' OR ');
    expr = expr ? `${expr} AND (${who})` : `(${who})`;
  }
  if (q.negatives.length) {
    if (!expr) throw new Error('Add a word to search for alongside the ones to leave out.');
    expr += q.negatives.map((n) => ` NOT ${n}`).join('');
  }
  return expr || null;
}

export async function search(store, options = {}) {
  const q = parseQuery(options.q);
  const fts = ftsExpression(q);
  const where = [];
  const params = [];
  if (fts) {
    where.push('posts_fts MATCH ?');
    params.push(fts);
  }
  if (q.since) {
    where.push('p.created_at >= ?');
    params.push(q.since);
  }
  if (q.until) {
    where.push('p.created_at < ?');
    params.push(nextDay(q.until));
  }
  const days = parseInt(options.posted, 10);
  if (Number.isFinite(days) && days > 0) {
    where.push('p.created_at >= ?');
    params.push(new Date(Date.now() - days * 86400000).toISOString());
  }
  for (const bit of q.has) where.push(`(p.flags & ${bit}) != 0`);
  for (const bit of q.notHas) where.push(`(p.flags & ${bit}) = 0`);
  if (options.feed) {
    where.push('EXISTS (SELECT 1 FROM sightings s WHERE s.uri = p.uri AND s.feed = ?)');
    params.push(String(options.feed));
  }

  const offset = Math.min(MAX_OFFSET, Math.max(0, parseInt(options.offset, 10) || 0));
  const columns = `p.uri, p.author_did, p.author_handle, p.author_name, p.author_avatar, p.embed_json,
                   p.created_at, p.flags, p.like_count, p.repost_count, p.reply_count`;
  const sql = fts
    ? `SELECT ${columns},
              highlight(posts_fts, 0, char(1), char(2)) AS text_hl,
              snippet(posts_fts, 1, char(1), char(2), '…', 24) AS extra_hl
       FROM posts_fts JOIN posts p ON p.rowid = posts_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY ${options.sort === 'new' ? 'p.created_at DESC' : 'bm25(posts_fts, 8.0, 3.0, 2.0, 2.0)'}
       LIMIT ? OFFSET ?`
    : `SELECT ${columns}, p.text AS text_hl, '' AS extra_hl
       FROM posts p
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`;
  const rows = await store.all(sql, ...params, PAGE + 1, offset);
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);

  const seenRows = page.length
    ? await store.all(
        `SELECT s.uri, s.feed, s.how, s.by_handle, s.appeared_at, f.name AS feed_name
         FROM sightings s LEFT JOIN feeds f ON f.uri = s.feed
         WHERE s.uri IN (SELECT value FROM json_each(?))`,
        JSON.stringify(page.map((r) => r.uri))
      )
    : [];
  const seen = new Map();
  for (const s of seenRows) {
    if (!seen.has(s.uri)) seen.set(s.uri, []);
    seen.get(s.uri).push({
      feed: s.feed,
      feed_name: s.feed_name || (s.feed === 'following' ? 'Following' : 'a feed'),
      how: s.how,
      by: s.by_handle || null,
      at: s.appeared_at,
    });
  }

  return {
    results: page.map((r) => {
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
        text: r.text_hl || '',
        extra: r.extra_hl && r.extra_hl.includes('\u0001') ? r.extra_hl : '',
        embed,
        flags: r.flags,
        counts: { likes: r.like_count, reposts: r.repost_count, replies: r.reply_count },
        seen: seen.get(r.uri) || [],
      };
    }),
    more,
    next_offset: more ? offset + PAGE : null,
  };
}

// D1 reports the database size in each query's meta.
async function dbBytes(db) {
  try {
    const r = await db.prepare('SELECT 1').all();
    return (r.meta && Number(r.meta.size_after)) || null;
  } catch {
    return null;
  }
}

export async function status(store, cfg) {
  const st = await store.getState([
    'posts_count', 'last_run', 'last_ok_at', 'last_error', 'backfill', 'gaps', 'session', 'feeds_reloaded_at',
  ]);
  const parse = (v) => {
    try {
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  // MIN and MAX on an indexed column are one row each. Never COUNT(*) here: it
  // reads every row, on every page load. posts_count is kept by ingest instead.
  const range = await store.one('SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM posts');
  const usage = await store.usageToday();
  const session = parse(st.session);
  const backfill = parse(st.backfill);
  return {
    posts: Number(st.posts_count) || 0,
    oldest: range && range.oldest,
    newest: range && range.newest,
    last_run: parse(st.last_run),
    last_ok_at: st.last_ok_at,
    last_error: parse(st.last_error),
    backfill: backfill && {
      done: !!backfill.done,
      pages: backfill.pages || 0,
      oldest: backfill.oldest || null,
      reason: backfill.reason || null,
    },
    gaps: (parse(st.gaps) || []).length,
    account: session ? session.handle || session.did : null,
    db_bytes: await dbBytes(store.db),
    usage: {
      ...usage,
      write_budget: cfg.dailyWriteBudget,
      read_budget: cfg.dailyReadBudget,
    },
  };
}
