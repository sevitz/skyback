// skyback page script. Served as /app.js, imported by the Worker as text (see the
// [[rules]] block in wrangler.toml), so it is never bundled or transpiled: plain
// browser JavaScript only.
//
// Every piece of post content is untrusted and goes into the page with
// textContent, never innerHTML. Highlight markers from the server are the
// control characters \u0001 (start) and \u0002 (end), split here into <mark>s.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  // /demo is the same page with the owner controls removed from the HTML. It makes
  // no /api calls: the sample posts ride in the page and are searched here.
  var DEMO = document.body.getAttribute('data-demo') === '1';
  var q = $('q'), feedSel = $('feed'), posted = $('posted'), sort = $('sort');
  var results = $('results'), summary = $('summary'), more = $('more'), notices = $('notices');
  var nextOffset = null, seq = 0, timer = null, searchingBack = false, stopBack = false;

  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' };
    if (opts.body) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      // A lapsed identity is a 401 for JSON; a reload goes through the portal
      // and comes straight back signed in.
      if (res.status === 401) { location.reload(); throw new Error('Signing in again'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function safeHref(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
  }

  function marked(parent, text) {
    var parts = String(text || '').split(/(\u0001[^\u0002]*\u0002)/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (p.charAt(0) === '\u0001') parent.appendChild(el('mark', null, p.slice(1, -1)));
      else parent.appendChild(document.createTextNode(p.replace(/[\u0001\u0002]/g, '')));
    }
    return parent;
  }

  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 86400 * 300 ? 'numeric' : undefined });
  }

  function fullDate(iso) {
    var t = Date.parse(iso);
    return t ? new Date(t).toLocaleString() : '';
  }

  function avatar(src, cls) {
    var h = safeHref(src);
    if (!h) return el('span', 'noimg');
    var img = el('img', cls);
    img.src = h;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    return img;
  }

  function seenLine(seen) {
    var bits = [];
    var feeds = {};
    for (var i = 0; i < seen.length; i++) {
      var s = seen[i];
      if (s.how === 'repost' && s.by) bits.push('Reposted by @' + s.by);
      if (s.how === 'parent' || s.how === 'root') bits.push('Shown above a reply');
      feeds[s.feed_name] = true;
    }
    var names = Object.keys(feeds);
    if (names.length && !(names.length === 1 && names[0] === 'Following')) bits.push('In ' + names.join(', '));
    var unique = [];
    for (var j = 0; j < bits.length; j++) if (unique.indexOf(bits[j]) < 0) unique.push(bits[j]);
    return unique.join(' · ');
  }

  function card(r) {
    var c = el('article', 'card');
    var seen = seenLine(r.seen || []);
    if (seen) c.appendChild(el('div', 'seen', seen));

    var who = el('div', 'who');
    var profile = el('a');
    profile.href = r.author.url;
    profile.target = '_blank';
    profile.rel = 'noopener';
    profile.appendChild(avatar(r.author.avatar));
    who.appendChild(profile);
    var names = el('div', 'names');
    var nameLink = el('a');
    nameLink.href = r.author.url;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener';
    nameLink.appendChild(el('span', 'name', r.author.name || r.author.handle));
    nameLink.appendChild(el('span', 'handle', '@' + r.author.handle));
    names.appendChild(nameLink);
    who.appendChild(names);
    var when = el('span', 'when', ago(r.created_at));
    when.title = fullDate(r.created_at);
    who.appendChild(when);
    c.appendChild(who);

    if (r.text) c.appendChild(marked(el('div', 'text'), r.text));

    var e = r.embed || {};
    var imgs = (e.images || []).slice();
    if (e.video && e.video.thumb) imgs.push({ thumb: e.video.thumb, alt: e.video.alt || 'Video' });
    if (imgs.length) {
      var strip = el('div', 'thumbs');
      for (var i = 0; i < imgs.length; i++) {
        var h = safeHref(imgs[i].thumb);
        if (!h) continue;
        var img = el('img');
        img.src = h;
        img.alt = imgs[i].alt || '';
        img.title = imgs[i].alt || '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        strip.appendChild(img);
      }
      if (strip.childNodes.length) c.appendChild(strip);
    }
    if (e.external && safeHref(e.external.uri)) {
      var lc = el('a', 'linkcard');
      lc.href = e.external.uri;
      lc.target = '_blank';
      lc.rel = 'noopener noreferrer';
      if (e.external.title) lc.appendChild(el('div', 't', e.external.title));
      if (e.external.description) lc.appendChild(el('div', 'd', e.external.description));
      lc.appendChild(el('div', 'u', e.external.uri.replace(/^https?:\/\//, '').slice(0, 80)));
      c.appendChild(lc);
    }
    if (e.quote) {
      var qa = el('a', 'quote');
      var parts = String(e.quote.uri || '').split('/');
      qa.href = 'https://bsky.app/profile/' + (e.quote.did || parts[2] || '') + '/post/' + (parts[parts.length - 1] || '');
      qa.target = '_blank';
      qa.rel = 'noopener';
      qa.appendChild(el('div', 'qh', (e.quote.name || e.quote.handle || 'Quoted post') + (e.quote.handle ? ' @' + e.quote.handle : '')));
      if (e.quote.text) qa.appendChild(el('div', 'q', e.quote.text));
      c.appendChild(qa);
    }
    if (e.card && e.card.title) {
      var fc = el('div', 'linkcard');
      fc.appendChild(el('div', 't', e.card.title));
      if (e.card.description) fc.appendChild(el('div', 'd', e.card.description));
      c.appendChild(fc);
    }
    // The matched alt text, link or quote, shown only when the post text itself
    // has no highlight, so it explains a match you could not otherwise see.
    if (r.extra && String(r.text || '').indexOf('\u0001') < 0) c.appendChild(marked(el('div', 'extra'), r.extra));

    var foot = el('div', 'foot');
    var counts = r.counts || {};
    if (counts.replies) foot.appendChild(el('span', null, counts.replies + ' replies'));
    if (counts.reposts) foot.appendChild(el('span', null, counts.reposts + ' reposts'));
    if (counts.likes) foot.appendChild(el('span', null, counts.likes + ' likes'));
    var open = el('a', null, 'Open in Bluesky');
    open.href = r.url;
    open.target = '_blank';
    open.rel = 'noopener';
    foot.appendChild(open);
    c.appendChild(foot);
    return c;
  }

  function params(offset) {
    var p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (feedSel && feedSel.value) p.set('feed', feedSel.value);
    if (posted && posted.value) p.set('posted', posted.value);
    if (sort && sort.value !== 'best') p.set('sort', sort.value);
    if (offset) p.set('offset', String(offset));
    return p;
  }

  function runSearch(append) {
    if (DEMO) return runDemoSearch();
    var mine = ++seq;
    var p = params(append ? nextOffset : 0);
    if (!append) {
      var shown = params(0).toString();
      history.replaceState(null, '', shown ? '?' + shown : location.pathname);
      summary.textContent = 'Searching…';
    }
    more.disabled = true;
    return api('/api/search?' + p.toString()).then(function (data) {
      if (mine !== seq) return null;
      if (!append) results.textContent = '';
      for (var i = 0; i < data.results.length; i++) results.appendChild(card(data.results[i]));
      nextOffset = data.next_offset;
      more.hidden = !data.more;
      more.disabled = false;
      var n = results.childNodes.length;
      if (!n) {
        summary.textContent = '';
        results.appendChild(el('div', 'empty', q.value.trim() ? 'Nothing matched. Try fewer or shorter words.' : 'Nothing archived yet.'));
      } else {
        summary.textContent = (q.value.trim() ? (data.more ? 'Top ' : '') + n + ' match' + (n === 1 ? '' : 'es') : 'Newest posts') + (data.more ? ', more below' : '');
      }
      return { n: n, more: !!data.more };
    }).catch(function (err) {
      if (mine !== seq) return null;
      summary.textContent = '';
      results.textContent = '';
      results.appendChild(el('div', 'empty', err.message));
      more.hidden = true;
      return null;
    });
  }

  // ---- demo search (browser side, over the sample posts in the page) ----

  function fold(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function esc(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function parseDemo(input) {
    var out = { words: [], phrases: [], not: [], from: [], has: [], since: null, until: null };
    var re = /(-?)"([^"]+)"|(\S+)/g, m;
    while ((m = re.exec(input))) {
      if (m[2]) { (m[1] ? out.not : out.phrases).push(fold(m[2])); continue; }
      var t = fold(m[3]);
      if (t.indexOf('from:') === 0 && t.length > 5) out.from.push(t.slice(5).replace(/^@/, ''));
      else if (t.indexOf('has:') === 0 && t.length > 4) out.has.push(t.slice(4));
      else if (/^(since|until):/.test(t)) {
        // A real calendar date or nothing: a bad one is dropped, not searched for.
        var day = t.slice(t.indexOf(':') + 1);
        var ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day + 'T00:00:00Z') : NaN;
        if (!isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day) out[t.slice(0, 5)] = day;
      }
      else if (t.charAt(0) === '-' && t.length > 1) out.not.push(t.slice(1));
      else out.words.push(t);
    }
    return out;
  }

  function wordRe(w) {
    return new RegExp('(^|[^a-z0-9])' + esc(w) + (w.length >= 4 ? '' : '(?![a-z0-9])'), 'i');
  }

  function demoBlob(r) {
    var e = r.embed || {};
    var bits = [r.text, r.extra];
    (e.images || []).forEach(function (i) { bits.push(i.alt); });
    if (e.external) bits.push(e.external.title, e.external.description);
    if (e.quote) bits.push(e.quote.text);
    return fold(bits.join(' \n '));
  }

  function demoHas(r, what) {
    var e = r.embed || {};
    if (what === 'image') return !!((e.images && e.images.length) || e.video);
    if (what === 'link') return !!e.external;
    return false;
  }

  function demoHighlight(text, terms) {
    if (!terms.length) return text;
    var re = new RegExp('(?<![A-Za-z0-9])(' + terms.map(function (t) {
      return t.indexOf(' ') > -1 || t.length < 4 ? esc(t) : esc(t) + '[\\p{L}\\p{N}]*';
    }).join('|') + ')', 'giu');
    return String(text || '').replace(re, '\u0001$1\u0002');
  }

  function runDemoSearch() {
    var posts = (window.__demoPosts || []).slice();
    var f = parseDemo(q.value.trim());
    var terms = f.words.concat(f.phrases);
    var hits = posts.filter(function (r) {
      var blob = demoBlob(r);
      for (var i = 0; i < f.words.length; i++) if (!wordRe(f.words[i]).test(blob)) return false;
      for (var j = 0; j < f.phrases.length; j++) if (blob.indexOf(f.phrases[j]) < 0) return false;
      for (var k = 0; k < f.not.length; k++) if (wordRe(f.not[k]).test(blob)) return false;
      for (var a = 0; a < f.from.length; a++) {
        if (fold(r.author.handle + ' ' + r.author.name).indexOf(f.from[a]) < 0) return false;
      }
      for (var h = 0; h < f.has.length; h++) if (!demoHas(r, f.has[h])) return false;
      if (f.since && r.created_at < f.since) return false;
      if (f.until && r.created_at >= new Date(Date.parse(f.until + 'T00:00:00Z') + 86400000).toISOString()) return false;
      return true;
    });
    hits.sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); });
    history.replaceState(null, '', q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : location.pathname);
    results.textContent = '';
    more.hidden = true;
    hits.forEach(function (r) {
      var shown = {};
      for (var key in r) shown[key] = r[key];
      shown.text = demoHighlight(r.text, terms);
      var hlExtra = demoHighlight(r.extra, terms);
      shown.extra = hlExtra.indexOf('\u0001') > -1 ? hlExtra : '';
      results.appendChild(card(shown));
    });
    var n = hits.length;
    if (!n) {
      summary.textContent = '';
      results.appendChild(el('div', 'empty', q.value.trim() ? 'Nothing matched. Try fewer or shorter words.' : 'No sample posts loaded.'));
    } else {
      summary.textContent = q.value.trim() ? n + ' match' + (n === 1 ? '' : 'es') : 'Newest posts';
    }
    return Promise.resolve({ n: n, more: false });
  }

  function initDemo() {
    var node = $('demo-data');
    var data = {};
    try { data = JSON.parse(node ? node.textContent : '{}'); } catch (e) { data = {}; }
    window.__demoPosts = Array.isArray(data.posts) ? data.posts : [];
    var chips = $('chips');
    (data.chips || []).forEach(function (text) {
      var b = el('button', null, text);
      b.type = 'button';
      b.addEventListener('click', function () { q.value = text; runSearch(false); });
      chips.appendChild(b);
    });
    runSearch(false);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch(false); }, 300);
  }

  // ---- status ----

  function fmtBytes(b) {
    if (!b) return '';
    return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function notice(text, bad) {
    notices.appendChild(el('div', 'notice' + (bad ? ' bad' : ''), text));
  }

  function loadStatus() {
    return api('/api/status').then(function (s) {
      notices.textContent = '';
      var bits = [];
      bits.push(s.posts.toLocaleString() + ' posts');
      if (s.oldest) bits.push('since ' + new Date(s.oldest).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
      if (s.last_ok_at) bits.push('synced ' + ago(s.last_ok_at));
      if (searchingBack) bits.push('searching back');
      $('status').textContent = bits.join(' · ');
      var tip = ['D1 today: ' + s.usage.rows_written.toLocaleString() + ' of ' + s.usage.write_budget.toLocaleString() +
        ' writes, ' + s.usage.rows_read.toLocaleString() + ' of ' + s.usage.read_budget.toLocaleString() + ' reads'];
      if (s.db_bytes) tip.push('database ' + fmtBytes(s.db_bytes));
      if (s.account) tip.push('@' + s.account);
      $('status').title = tip.join(' · ');

      var last = s.last_run;
      if (!s.posts && !last) notice('Nothing archived yet. Press Sync now.');
      if (last && last.error) notice('Last sync failed: ' + last.error, true);
      else if (last && last.paused && last.paused.indexOf('budget') >= 0) notice('Paused: ' + last.paused);
      if (s.usage.rows_written > s.usage.write_budget * 0.8) notice('Close to today\'s D1 write budget. Syncing pauses at the limit until midnight UTC.');
      if (s.db_bytes && s.db_bytes > 400 * 1048576) notice('The database is ' + fmtBytes(s.db_bytes) + ' of the free plan\'s 500 MB. Set RETENTION_DAYS to keep it in bounds.');
      if (s.gaps) notice('A stretch of your timeline is still being caught up.');
      return s;
    }).catch(function (err) {
      $('status').textContent = 'Status unavailable: ' + err.message;
    });
  }

  // ---- feeds ----

  function fillFeedSelect(feeds) {
    var current = feedSel.value || new URLSearchParams(location.search).get('feed') || '';
    feedSel.textContent = '';
    var all = el('option', null, 'All');
    all.value = '';
    feedSel.appendChild(all);
    for (var i = 0; i < feeds.length; i++) {
      var f = feeds[i];
      if (!(f.kind === 'timeline' || f.enabled || f.last_synced_at)) continue;
      var o = el('option', null, f.name);
      o.value = f.uri;
      feedSel.appendChild(o);
    }
    feedSel.value = current;
    if (feedSel.value !== current) feedSel.value = '';
  }

  function feedRow(f) {
    var row = el('div', 'feed' + (f.saved || f.kind === 'timeline' ? '' : ' unsaved'));
    var box = el('input');
    box.type = 'checkbox';
    box.checked = !!f.enabled;
    box.disabled = f.kind === 'timeline';
    box.setAttribute('aria-label', 'Archive ' + f.name);
    box.addEventListener('change', function () {
      box.disabled = true;
      api('/api/feeds/toggle', { method: 'POST', body: { uri: f.uri, enabled: box.checked } })
        .then(function () { f.enabled = box.checked ? 1 : 0; box.disabled = false; return loadFeeds(); })
        .catch(function (err) { box.checked = !box.checked; box.disabled = false; $('feeds-note').textContent = err.message; });
    });
    row.appendChild(box);
    row.appendChild(avatar(f.avatar));
    var info = el('div');
    info.appendChild(el('div', 'name', f.name));
    var meta = f.kind === 'timeline' ? 'Your home timeline, always on'
      : f.last_error ? 'Last fetch failed: ' + f.last_error
      : f.last_synced_at ? 'Checked ' + ago(f.last_synced_at) + (f.last_new != null ? ', ' + f.last_new + ' new' : '')
      : f.enabled ? 'Waiting for the next sync' : (f.kind === 'list' ? 'List' : 'Feed');
    info.appendChild(el('div', 'meta' + (f.last_error ? ' bad' : ''), meta));
    row.appendChild(info);
    if (f.kind !== 'timeline' && f.enabled) {
      var now = el('button', null, 'Fetch now');
      now.type = 'button';
      now.addEventListener('click', function () {
        now.disabled = true;
        now.textContent = 'Fetching…';
        api('/api/feeds/fetch', { method: 'POST', body: { uri: f.uri } })
          .then(function (r) {
            var res = (r.feeds || [])[0];
            $('feeds-note').textContent = r.paused ? r.paused : r.error ? r.error : res && res.error ? res.error : (res ? res.new_items + ' new from ' + f.name : 'Done');
            return Promise.all([loadFeeds(), loadStatus()]);
          })
          .catch(function (err) { $('feeds-note').textContent = err.message; })
          .then(function () { now.disabled = false; now.textContent = 'Fetch now'; });
      });
      row.appendChild(now);
    } else row.appendChild(el('span'));
    return row;
  }

  function loadFeeds() {
    return api('/api/feeds').then(function (data) {
      var list = $('feeds-list');
      list.textContent = '';
      for (var i = 0; i < data.feeds.length; i++) list.appendChild(feedRow(data.feeds[i]));
      fillFeedSelect(data.feeds);
      $('feeds-note').textContent = data.reloaded_at ? 'Saved feeds loaded ' + ago(data.reloaded_at) : '';
      return data;
    });
  }

  function reloadFeeds() {
    var b = $('reload-feeds');
    b.disabled = true;
    $('feeds-note').textContent = 'Reading your saved feeds from Bluesky…';
    return api('/api/feeds/refresh', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.error || 'Could not reload');
        return loadFeeds();
      })
      .catch(function (err) { $('feeds-note').textContent = err.message; })
      .then(function () { b.disabled = false; });
  }

  // ---- catch up on open ----

  // The cron is a daily safety net, so when the page opens and the last good sync
  // is more than 15 minutes old it catches up by itself, once.
  function catchUpOnOpen(s) {
    if (!s) return;
    var last = s.last_ok_at ? Date.parse(s.last_ok_at) : 0;
    if (last && Date.now() - last < 15 * 60000) return;
    $('status').textContent = 'Syncing…';
    $('sync-now').disabled = true;
    api('/api/sync', { method: 'POST' })
      .catch(function () {})
      .then(function () { $('sync-now').disabled = false; return loadStatus(); })
      .then(function () { runSearch(false); });
  }

  // ---- search further back ----

  var BACK_DAYS = 7;

  function dayLabel(iso) {
    var t = Date.parse(iso);
    return t ? new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  }

  // Walks back through the timeline a day (24 hours) at a time with the current
  // search, re-running it after each day, and stops after BACK_DAYS to ask. The
  // server does a small step per request (see backfillStep in sync.js); this
  // loop owns the day counter, Stop and the pause.
  function wireBackfill() {
    var btn = $('back-btn'), box = $('backfill'), text = $('bf-text'), barWrap = $('bf-barwrap');
    var bar = $('bf-bar'), acts = $('bf-actions'), syncBtn = $('sync-now');
    var baseline = null;
    var edge = null;

    function show(msg, kind, progress) {
      box.hidden = false;
      box.className = 'bf' + (kind === 'prompt' ? ' prompt' : '');
      text.textContent = msg;
      barWrap.hidden = progress === undefined;
      if (progress !== undefined) bar.style.width = Math.round(progress * 100) + '%';
      acts.textContent = '';
    }

    function action(label, fn) {
      var b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      acts.appendChild(b);
      return b;
    }

    function idle() {
      searchingBack = false;
      btn.disabled = false;
      syncBtn.disabled = false;
    }

    function finish(msg) {
      idle();
      show(msg);
      loadStatus();
    }

    function backTo() { return edge ? ' back to ' + dayLabel(edge) : ''; }

    function matchText(res) {
      if (!res) return '';
      var m = res.n + ' match' + (res.n === 1 ? '' : 'es');
      if (baseline !== null && !res.more && res.n >= baseline) m += ' (' + (res.n - baseline) + ' new)';
      return m;
    }

    function line(n, m) {
      return 'Searching day ' + n + ' of ' + BACK_DAYS + (edge ? ': ' + dayLabel(edge) : '') + '. ' + (m ? m + ' so far.' : '');
    }

    function begin() {
      if (searchingBack) return;
      if (!q.value.trim()) { show('Type a word first.'); return; }
      searchingBack = true;
      stopBack = false;
      btn.disabled = true;
      syncBtn.disabled = true;
      show('Starting…');
      loadStatus();
      runSearch(false).then(function (res) {
        baseline = res && !res.more ? res.n : null;
        day(1, matchText(res));
      });
    }

    function day(n, m) {
      if (stopBack) return finish('Stopped. Searched' + backTo() + '.' + (m ? ' ' + m + '.' : ''));
      show(line(n, m), 'run', (n - 1) / BACK_DAYS);
      action('Stop', function () { stopBack = true; this.disabled = true; this.textContent = 'Stopping…'; });
      steps(n, m, null, 0);
    }

    function steps(n, m, target, busy) {
      if (stopBack) return finish('Stopped. Searched' + backTo() + '.' + (m ? ' ' + m + '.' : ''));
      api('/api/backfill/step', { method: 'POST', body: target ? { target: target } : {} }).then(function (r) {
        if (r.paused) {
          if (r.busy && busy < 3) { setTimeout(function () { steps(n, m, target, busy + 1); }, 3000); return; }
          finish(r.busy ? 'Another sync is running. Try again in a minute.' : 'Paused: ' + r.paused + '.');
          return;
        }
        if (!r.ok) { finish('Search further back failed: ' + r.error); return; }
        if (r.edge) edge = r.edge;
        if (r.ended || r.reached) { endOfDay(n, r.ended); return; }
        text.textContent = line(n, m);
        steps(n, m, target || r.target, 0);
      }).catch(function (err) { finish('Search further back stopped: ' + err.message); });
    }

    function endOfDay(n, ended) {
      runSearch(false).then(function (res) {
        var m = matchText(res);
        if (ended) { finish('Reached the start of what Bluesky will show' + backTo() + '. ' + m + '.'); return; }
        if (stopBack) { finish('Stopped. Searched' + backTo() + '. ' + m + '.'); return; }
        if (n >= BACK_DAYS) { ask(m); return; }
        loadStatus();
        day(n + 1, m);
      });
    }

    function ask(m) {
      idle();
      show('Searched' + backTo() + '. ' + m + '.', 'prompt');
      action('Search ' + BACK_DAYS + ' more days', begin);
      action('Stop here', function () { box.hidden = true; });
      loadStatus();
    }

    btn.addEventListener('click', begin);
  }

  // ---- owner wiring ----

  function wireOwner() {
    $('feeds-btn').addEventListener('click', function () {
      var panel = $('feeds-panel');
      panel.hidden = !panel.hidden;
      $('feeds-btn').setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) {
        loadFeeds().then(function (data) {
          if (!data.reloaded_at) reloadFeeds();
        }).catch(function (err) { $('feeds-note').textContent = err.message; });
      }
    });
    $('reload-feeds').addEventListener('click', reloadFeeds);

    $('sync-now').addEventListener('click', function () {
      var b = $('sync-now');
      b.disabled = true;
      b.textContent = 'Syncing…';
      api('/api/sync', { method: 'POST' })
        .then(function (r) {
          b.textContent = r.error ? 'Sync failed' : r.paused ? 'Paused' : 'Synced';
          return loadStatus().then(function () { runSearch(false); });
        })
        .catch(function (err) { b.textContent = 'Sync failed'; notice(err.message, true); })
        .then(function () { setTimeout(function () { b.disabled = false; b.textContent = 'Sync now'; }, 2000); });
    });
    wireBackfill();
  }

  // ---- wiring ----

  $('search').addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); runSearch(false); });
  q.addEventListener('input', function () { stopBack = true; schedule(); });
  if (feedSel) feedSel.addEventListener('change', function () { runSearch(false); });
  if (posted) posted.addEventListener('change', function () { runSearch(false); });
  if (sort) sort.addEventListener('change', function () { runSearch(false); });
  more.addEventListener('click', function () { runSearch(true); });

  var start = new URLSearchParams(location.search);
  q.value = start.get('q') || '';
  if (DEMO) {
    initDemo();
    return;
  }
  posted.value = start.get('posted') || '';
  sort.value = start.get('sort') === 'new' ? 'new' : 'best';
  wireOwner();
  loadStatus().then(function (s) { catchUpOnOpen(s); });
  loadFeeds().catch(function () {}).then(function () { runSearch(false); });
})();
