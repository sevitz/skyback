// Turns Bluesky feed items (app.bsky.feed.defs#feedViewPost) into skyback rows.
//
// Shapes follow the lexicons as shipped in @atproto/api: PostView, ReplyRef,
// ReasonRepost, and the embed views (images, gallery, video, external, record,
// recordWithMedia). Anything unrecognised is skipped rather than guessed at.
//
// This runs on every item of every page inside the free plan's 10ms CPU per
// invocation, so it stays plain: no regexes in loops, no deep clones.

export const FLAG = { image: 1, video: 2, link: 4, quote: 8, reply: 16 };

const MAX_TEXT = 3000;
const MAX_EXTRA = 4000;
const MAX_QUOTE = 600;
const MAX_DESC = 300;

function typeOf(v) {
  return (v && typeof v.$type === 'string' && v.$type) || '';
}

function endsWith(v, suffix) {
  return typeOf(v).endsWith(suffix);
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  return max && v.length > max ? v.slice(0, max) : v;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function https(v) {
  return typeof v === 'string' && v.startsWith('https://') ? v : null;
}

function iso(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function didFromUri(uri) {
  const m = typeof uri === 'string' ? uri.split('/') : [];
  return m.length > 2 ? m[2] : '';
}

export function rkeyFromUri(uri) {
  const m = typeof uri === 'string' ? uri.split('/') : [];
  return m[m.length - 1] || '';
}

export function postUrl(uri) {
  const did = didFromUri(uri);
  const rkey = rkeyFromUri(uri);
  return did && rkey ? `https://bsky.app/profile/${did}/post/${rkey}` : 'https://bsky.app';
}

export function isPostView(v) {
  if (!v || typeof v !== 'object') return false;
  const t = typeOf(v);
  if (t && !t.endsWith('#postView')) return false;
  return typeof v.uri === 'string' && v.record && typeof v.record === 'object' && v.author;
}

// Media and link card parts of an embed view. Shared by a post's own embed and
// the media half of recordWithMedia.
function media(view, out, parts) {
  if (!view) return;
  if (endsWith(view, 'embed.images#view') && Array.isArray(view.images)) {
    out.flags |= FLAG.image;
    out.embed.images = view.images.slice(0, 4).map((img) => ({ thumb: https(img.thumb), alt: str(img.alt, 300) }));
    for (const img of view.images) if (img.alt) parts.push(img.alt);
    return;
  }
  if (endsWith(view, 'embed.gallery#view') && Array.isArray(view.items)) {
    out.flags |= FLAG.image;
    const items = view.items.filter((i) => i && (i.thumbnail || i.fullsize));
    out.embed.images = items.slice(0, 4).map((img) => ({ thumb: https(img.thumbnail), alt: str(img.alt, 300) }));
    for (const img of items) if (img.alt) parts.push(img.alt);
    return;
  }
  if (endsWith(view, 'embed.video#view')) {
    out.flags |= FLAG.video;
    out.embed.video = { thumb: https(view.thumbnail), alt: str(view.alt, 300) };
    if (view.alt) parts.push(view.alt);
    return;
  }
  if (endsWith(view, 'embed.external#view') && view.external) {
    const e = view.external;
    out.flags |= FLAG.link;
    out.embed.external = {
      uri: str(e.uri, 1000),
      title: str(e.title, 300),
      description: str(e.description, MAX_DESC),
      thumb: https(e.thumb),
    };
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(str(e.description, 1000));
    if (e.uri) parts.push(e.uri);
  }
}

// The quoted part of a record or recordWithMedia embed.
function quoted(recordView, out, parts) {
  const r = recordView && recordView.record;
  if (!r) return;
  if (endsWith(r, '#viewRecord') || (r.value && r.author && typeof r.uri === 'string')) {
    const a = r.author || {};
    const text = str(r.value && r.value.text, MAX_QUOTE);
    out.flags |= FLAG.quote;
    out.embed.quote = {
      uri: r.uri,
      did: a.did || didFromUri(r.uri),
      handle: a.handle || '',
      name: str(a.displayName, 100),
      text,
    };
    if (a.handle) parts.push(`@${a.handle}`);
    if (a.displayName) parts.push(a.displayName);
    if (text) parts.push(str(r.value.text, 2000));
    // What the quoted post itself carried: searchable, not rendered.
    for (const inner of Array.isArray(r.embeds) ? r.embeds : []) {
      const sink = { flags: 0, embed: {} };
      media(inner, sink, parts);
      if (endsWith(inner, 'embed.recordWithMedia#view')) media(inner.media, sink, parts);
    }
    return;
  }
  // Feed generators, lists, starter packs and labelers embedded as cards.
  const title = r.displayName || r.name || (r.record && r.record.name) || '';
  if (title) {
    out.embed.card = { title: str(title, 200), description: str(r.description, MAX_DESC), uri: r.uri || '' };
    parts.push(title);
    if (r.description) parts.push(str(r.description, 1000));
  }
}

// One PostView to one posts row.
export function postRow(pv, nowIso) {
  const record = pv.record || {};
  const author = pv.author || {};
  const indexed = iso(pv.indexedAt) || nowIso;
  let created = iso(record.createdAt) || indexed;
  // createdAt is whatever the posting client claimed. A post "from next year"
  // would otherwise pin itself to the top of every newest-first list.
  if (created > new Date(Date.parse(indexed) + 86400000).toISOString()) created = indexed;

  const out = { flags: 0, embed: {} };
  const parts = [];
  const view = pv.embed;
  if (view) {
    if (endsWith(view, 'embed.record#view')) quoted(view, out, parts);
    else if (endsWith(view, 'embed.recordWithMedia#view')) {
      quoted(view.record, out, parts);
      media(view.media, out, parts);
    } else media(view, out, parts);
  }

  // Facets carry the full URL behind a shortened link, and hashtags.
  for (const facet of Array.isArray(record.facets) ? record.facets : []) {
    for (const f of Array.isArray(facet.features) ? facet.features : []) {
      if (typeof f.uri === 'string') {
        parts.push(f.uri);
        out.flags |= FLAG.link;
      } else if (typeof f.tag === 'string') parts.push(`#${f.tag}`);
    }
  }
  if (Array.isArray(record.tags)) for (const t of record.tags) if (typeof t === 'string') parts.push(`#${t}`);
  if (record.reply) out.flags |= FLAG.reply;

  // De-duplicate (a link often appears as both facet and card) and cap.
  const seen = new Set();
  let extra = '';
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (extra.length + p.length + 1 > MAX_EXTRA) break;
    extra = extra ? `${extra}\n${p}` : p;
  }

  return {
    uri: pv.uri,
    cid: pv.cid || null,
    author_did: author.did || didFromUri(pv.uri),
    author_handle: author.handle || '',
    author_name: str(author.displayName, 200),
    author_avatar: https(author.avatar),
    text: str(record.text, MAX_TEXT),
    extra,
    embed_json: Object.keys(out.embed).length ? JSON.stringify(out.embed) : null,
    created_at: created,
    indexed_at: indexed,
    reply_parent: (record.reply && record.reply.parent && record.reply.parent.uri) || null,
    flags: out.flags,
    like_count: num(pv.likeCount),
    repost_count: num(pv.repostCount),
    reply_count: num(pv.replyCount),
    first_seen_at: nowIso,
  };
}

export function sightingKey(s) {
  return `${s.uri}\u0000${s.how}\u0000${s.by_did}`;
}

// A page of feed items to the posts and sightings it implies, de-duplicated.
// `primary` holds the sighting keys of the items themselves (not the reply
// context shown above them), which is what "is there anything new" counts.
export function pageRows(items, feed, nowIso) {
  const posts = new Map();
  const sightings = new Map();
  const primary = new Set();
  let oldest = null;

  for (const item of Array.isArray(items) ? items : []) {
    const pv = item && item.post;
    if (!isPostView(pv)) continue;
    const reason = item.reason;
    const repost = endsWith(reason, '#reasonRepost') && reason.by;
    const appeared = iso(repost ? reason.indexedAt : pv.indexedAt) || nowIso;
    if (!oldest || appeared < oldest) oldest = appeared;

    if (!posts.has(pv.uri)) posts.set(pv.uri, postRow(pv, nowIso));
    const s = {
      uri: pv.uri,
      feed,
      how: repost ? 'repost' : 'post',
      by_did: repost ? reason.by.did || '' : '',
      by_handle: repost ? reason.by.handle || '' : '',
      appeared_at: appeared,
    };
    const key = sightingKey(s);
    sightings.set(key, s);
    primary.add(key);

    const reply = item.reply;
    if (reply) {
      for (const [ctx, how] of [[reply.parent, 'parent'], [reply.root, 'root']]) {
        if (!isPostView(ctx) || ctx.uri === pv.uri) continue;
        // A direct reply to the first post has the same root and parent.
        if (how === 'root' && isPostView(reply.parent) && reply.parent.uri === ctx.uri) continue;
        if (!posts.has(ctx.uri)) posts.set(ctx.uri, postRow(ctx, nowIso));
        const c = { uri: ctx.uri, feed, how, by_did: '', by_handle: '', appeared_at: appeared };
        const ck = sightingKey(c);
        if (!sightings.has(ck)) sightings.set(ck, c);
      }
    }
  }
  return { posts, sightings, primary, oldest };
}
