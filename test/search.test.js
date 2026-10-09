import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, ftsExpression } from '../src/worker/search.js';

const fts = (s) => ftsExpression(parseQuery(s));

test('words are quoted, longer ones prefix matched', () => {
  assert.equal(fts('heat pumps'), '"heat"* "pumps"*');
  assert.equal(fts('ok go'), '"ok" "go"');
});

test('phrases, exclusions and OR', () => {
  assert.equal(fts('"heat pump" -gas'), '"heat pump" NOT "gas"*');
  assert.equal(fts('trams OR buses'), '("trams"* OR "buses"*)');
  assert.equal(fts('OR trams OR'), '"trams"*');
});

test('from: becomes a column filter on handle and name', () => {
  assert.equal(fts('from:@alice.bsky.social trams'), '"trams"* AND ({author_handle author_name} : "alice.bsky.social"*)');
  assert.equal(fts('from:alice'), '({author_handle author_name} : "alice"*)');
});

test('filters are parsed out of the words', () => {
  const q = parseQuery('cats has:image -has:reply since:2026-10-01 until:2026-10-08');
  assert.deepEqual(q.has, [1]);
  assert.deepEqual(q.notHas, [16]);
  assert.equal(q.since, '2026-10-01');
  assert.equal(q.until, '2026-10-08');
  assert.equal(ftsExpression(q), '"cats"*');
  assert.equal(fts('has:image'), null);
});

test('hostile input cannot become FTS syntax', () => {
  assert.equal(fts('a" OR text:"b'), '("a""" OR "text:""b"*)');
  assert.equal(fts('NEAR(x y) *'), '"NEAR(x"* "y)"');
  assert.equal(fts('{text} : secret'), '"{text}"* "secret"*');
  assert.equal(fts('!!! ...'), null);
});

test('only exclusions is a friendly error', () => {
  assert.throws(() => fts('-gas'), /alongside/);
});

test('unknown operators are searched as words', () => {
  assert.equal(fts('lang:en'), '"lang:en"*');
  assert.equal(fts('since:yesterday'), '"since:yesterday"*');
});
