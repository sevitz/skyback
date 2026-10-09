// Every D1 call goes through Store, so every row read and written is counted.
//
// The account is on the Workers free plan: 5 million rows read and 100,000 rows
// written a day, shared by every app on it. Since 2026-09-01, going over either
// fails every D1 query on the account until midnight UTC -- auth and every
// other app included. skyback therefore keeps its own daily tally (the `usage`
// table, fed from each query's meta) and stops itself at DAILY_WRITE_BUDGET and
// DAILY_READ_BUDGET, well short of the account limits.
//
// Two D1 habits worth knowing here:
// - Each statement result carries meta.rows_read and meta.rows_written. That is
//   what is tallied. `.first()` returns no meta, so it is never used.
// - meta.changes is not a reliable "rows inserted" count once triggers are
//   involved (it was 6 for a two-row insert into a table with an FTS trigger, and
//   5 for a one-row upsert). Anything that needs to know what was new selects
//   first instead. See ingest.js.

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function clean(params) {
  return params.map((p) => (p === undefined ? null : p));
}

export class Store {
  constructor(db) {
    this.db = db;
    this.reads = 0;
    this.writes = 0;
  }

  tally(result) {
    const meta = result && result.meta;
    if (meta) {
      this.reads += Number(meta.rows_read) || 0;
      this.writes += Number(meta.rows_written) || 0;
    }
    return result;
  }

  async all(sql, ...params) {
    const result = await this.db.prepare(sql).bind(...clean(params)).all();
    this.tally(result);
    return result.results || [];
  }

  async one(sql, ...params) {
    const rows = await this.all(sql, ...params);
    return rows[0] || null;
  }

  async run(sql, ...params) {
    return this.tally(await this.db.prepare(sql).bind(...clean(params)).run());
  }

  // statements: [{ sql, params }]. One round trip, one transaction.
  async batch(statements) {
    const list = statements.filter(Boolean);
    if (!list.length) return [];
    const prepared = list.map((s) => this.db.prepare(s.sql).bind(...clean(s.params || [])));
    const results = await this.db.batch(prepared);
    for (const r of results) this.tally(r);
    return results;
  }

  // ---- state (key/value) ----

  async getState(keys) {
    const rows = await this.all(
      'SELECT key, value FROM state WHERE key IN (SELECT value FROM json_each(?))',
      JSON.stringify(keys)
    );
    const out = {};
    for (const k of keys) out[k] = null;
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  async getJson(key) {
    const s = await this.getState([key]);
    if (!s[key]) return null;
    try {
      return JSON.parse(s[key]);
    } catch {
      return null;
    }
  }

  setStatement(key, value) {
    const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    return {
      sql: `INSERT INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [key, text],
    };
  }

  async setState(entries) {
    return this.batch(Object.entries(entries).map(([k, v]) => this.setStatement(k, v)));
  }

  async deleteState(key) {
    return this.run('DELETE FROM state WHERE key = ?', key);
  }

  // ---- the lock: one sync at a time (cron and the page's buttons share it) ----

  async acquireLock(seconds) {
    const now = new Date();
    // The random tail makes two callers in the same millisecond still differ;
    // it sorts after the timestamp, so the expiry comparison is unaffected.
    const until = `${new Date(now.getTime() + seconds * 1000).toISOString()}#${Math.random().toString(36).slice(2, 8)}`;
    await this.run(
      `UPDATE state SET value = ?, updated_at = datetime('now')
       WHERE key = 'lock_until' AND (value = '' OR value < ?)`,
      until,
      now.toISOString()
    );
    const row = await this.one("SELECT value FROM state WHERE key = 'lock_until'");
    // The UPDATE only lands if nobody holds the lock, so reading our own value
    // back means we got it.
    this.lockValue = row && row.value === until ? until : null;
    return !!this.lockValue;
  }

  async releaseLock() {
    if (!this.lockValue) return;
    await this.run("UPDATE state SET value = '' WHERE key = 'lock_until' AND value = ?", this.lockValue);
    this.lockValue = null;
  }

  // ---- usage ----

  async usageToday() {
    const row = await this.one('SELECT rows_read, rows_written, runs FROM usage WHERE day = ?', utcDay());
    return {
      day: utcDay(),
      rows_read: row ? Number(row.rows_read) : 0,
      rows_written: row ? Number(row.rows_written) : 0,
      runs: row ? Number(row.runs) : 0,
    };
  }

  // Adds what this Store has counted so far to today's row, then resets the
  // counters. `run` is 1 for a sync run, 0 for a page request.
  async flushUsage(run = 0) {
    const reads = this.reads;
    const writes = this.writes;
    this.reads = 0;
    this.writes = 0;
    if (!reads && !writes && !run) return;
    await this.db
      .prepare(
        `INSERT INTO usage (day, rows_read, rows_written, runs) VALUES (?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           rows_read = rows_read + excluded.rows_read,
           rows_written = rows_written + excluded.rows_written,
           runs = runs + excluded.runs`
      )
      .bind(utcDay(), reads, writes + 1, run)
      .run();
  }
}
