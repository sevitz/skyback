// A small stand-in for the D1 binding over Node's built-in SQLite, which is
// compiled with FTS5 and the JSON functions, so the real migration and the real
// queries run unchanged. Only what skyback uses: prepare/bind/all/run, batch.
// meta.rows_written is SQLite's change count, close enough to exercise the
// budget guards; meta.rows_read is a rough row count.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const READS = /^\s*(select|with)\b/i;

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }

  exec() {
    const stmt = this.db.prepare(this.sql);
    if (READS.test(this.sql)) {
      const rows = stmt.all(...this.params).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { rows_read: rows.length, rows_written: 0, size_after: 4096 } };
    }
    const info = stmt.run(...this.params);
    return { results: [], success: true, meta: { rows_read: 0, rows_written: Number(info.changes), changes: Number(info.changes), size_after: 4096 } };
  }

  async all() {
    return this.exec();
  }

  async run() {
    return this.exec();
  }
}

export class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s.exec());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Test convenience, synchronous.
  q(sql, ...params) {
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r }));
  }
}

export function freshDb() {
  const d1 = new D1();
  d1.db.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return d1;
}
