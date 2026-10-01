// F135 — the guards that replace "an operator remembered the right .env line".
//
// Every guard below is asserted BOTH ways: it passes the good input and it FAILS
// the bad one. A check that has never been seen to fail is decoration (CLAUDE.md,
// comic-preorder, "a verification step that cannot fail is not a verification
// step"), so the failing cases are the point of this file, not an afterthought.
//
// Credential-free: build-pull-feed.js reads its environment lazily, so requiring
// it needs none. The two I/O tests use a throwaway local HTTP server.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { resolveTargetWeek, checkWeek, dominantOnSaleDate, weekRange } = require('../scripts/build-pull-feed.js');
const { checkStamp, readStamp } = require('../scripts/check-stamp.js');
const { extractAssetUrls, waitForUrls } = require('../scripts/wait-for-thumbs.js');

const rows = (...pairs) =>
  pairs.flatMap(([date, n]) => Array.from({ length: n }, () => ({ on_sale_date: date })));

// ── which week ───────────────────────────────────────────────────────────────

test('no week named: the run date itself, flagged NOT explicit', () => {
  assert.deepEqual(resolveTargetWeek({ today: '2026-10-06' }), { refDate: '2026-10-06', explicit: false });
});

test('a named week is explicit and passed through untouched', () => {
  assert.deepEqual(resolveTargetWeek({ weekArg: '2026-09-30', today: '2026-10-06' }), { refDate: '2026-09-30', explicit: true });
});

test('a malformed --week is rejected, not silently ignored', () => {
  assert.throws(() => resolveTargetWeek({ weekArg: 'next-wednesday' }), /YYYY-MM-DD/);
  assert.throws(() => resolveTargetWeek({ weekArg: '2026-9-30' }), /YYYY-MM-DD/);
});

test('weekRange is Monday to Sunday, and Sunday belongs to the week it ends', () => {
  assert.deepEqual(weekRange('2026-10-06'), { start: '2026-10-05', end: '2026-10-11' }); // the Tuesday cron
  assert.deepEqual(weekRange('2026-10-05'), { start: '2026-10-05', end: '2026-10-11' }); // a Monday
  assert.deepEqual(weekRange('2026-10-04'), { start: '2026-09-28', end: '2026-10-04' }); // a Sunday
});

// ── checkWeek: three reds, then the greens ──────────────────────────────────

const W = { start: '2026-10-05', end: '2026-10-11' };

test('RED 1: no rows for the week - the shipment import has not run (case b)', () => {
  const problem = checkWeek({ rawRows: [], explicit: false, today: '2026-10-06', ...W });
  assert.ok(problem, 'an empty week must be refused');
  assert.match(problem, /has not run/);
  assert.match(problem, /Refusing to publish a different week/);
});

test('RED 1b: an explicit week with no rows is refused too', () => {
  assert.ok(checkWeek({ rawRows: [], explicit: true, today: '2026-10-06', ...W }));
});

test('RED 2: a response at PostgREST\'s 1000-row cap is refused as possibly truncated', () => {
  const problem = checkWeek({ rawRows: rows(['2026-10-07', 1000]), explicit: false, today: '2026-10-06', ...W });
  assert.match(problem, /response cap/);
});

test('RED 3: every row already on sale, no week named - refuses to preview a past week', () => {
  // The exact shape of Thursday 2026-10-01: 71 rows on 09-30, the run's own week 09-28..10-04.
  const problem = checkWeek({
    rawRows: rows(['2026-09-30', 71]), explicit: false, today: '2026-10-01',
    start: '2026-09-28', end: '2026-10-04',
  });
  assert.match(problem, /already on sale/);
  assert.match(problem, /explicit week/);
});

test('GREEN: the Tuesday cron - rows land tomorrow', () => {
  assert.equal(checkWeek({ rawRows: rows(['2026-10-07', 70]), explicit: false, today: '2026-10-06', ...W }), null);
});

test('GREEN: rows landing TODAY are not "already on sale" (a Tuesday-shipping week)', () => {
  assert.equal(checkWeek({ rawRows: rows(['2026-10-06', 5]), explicit: false, today: '2026-10-06', ...W }), null);
});

test('GREEN: a named past week is allowed - that is the deliberate override', () => {
  assert.equal(checkWeek({
    rawRows: rows(['2026-09-30', 71]), explicit: true, today: '2026-10-01',
    start: '2026-09-28', end: '2026-10-04',
  }), null);
});

test('GREEN: one early-landing straggler does not make the week "past"', () => {
  // 70 rows tomorrow plus 1 from Monday: the LATEST is still ahead, so it publishes.
  assert.equal(checkWeek({ rawRows: rows(['2026-10-07', 70], ['2026-10-05', 1]), explicit: false, today: '2026-10-06', ...W }), null);
});

// ── the masthead date (ported from import.js's resolveFeedWeek, so the two agree) ──

test('dominantOnSaleDate: the real 2026-08-07 shipment picks the upcoming week, not the straggler', () => {
  assert.equal(dominantOnSaleDate(rows(['2026-08-12', 51], ['2026-07-29', 1])), '2026-08-12');
});

test('dominantOnSaleDate: neither an early straggler nor a far-future title ever wins', () => {
  assert.equal(dominantOnSaleDate(rows(['2026-08-12', 51], ['2026-05-06', 1])), '2026-08-12');
  assert.equal(dominantOnSaleDate(rows(['2026-08-12', 51], ['2026-11-04', 1])), '2026-08-12');
});

test('dominantOnSaleDate: an even tie resolves forward; a genuine majority still wins', () => {
  assert.equal(dominantOnSaleDate(rows(['2026-08-05', 30], ['2026-08-12', 30])), '2026-08-12');
  assert.equal(dominantOnSaleDate(rows(['2026-08-05', 40], ['2026-08-12', 9])), '2026-08-05');
  assert.equal(dominantOnSaleDate(rows(['2026-08-12', 9], ['2026-08-05', 40])), '2026-08-05');
});

test('dominantOnSaleDate: the real 09-22 ad-hoc Tuesday does not displace the Wednesday', () => {
  // Production, week 09-21..09-27: 88 rows on 09-23 plus 2 ad-hoc PRH rows on 09-22.
  assert.equal(dominantOnSaleDate(rows(['2026-09-23', 88], ['2026-09-22', 2])), '2026-09-23');
});

test('dominantOnSaleDate: undated rows are ignored; none at all is null', () => {
  assert.equal(dominantOnSaleDate([...rows(['2026-08-12', 3]), { on_sale_date: null }, {}]), '2026-08-12');
  assert.equal(dominantOnSaleDate([]), null);
  assert.equal(dominantOnSaleDate(null), null);
});

test('the retired earliest-wins rule would fail this - proving the port bites', () => {
  const shipment = rows(['2026-08-12', 51], ['2026-07-29', 1]);
  const earliestWins = shipment.map(r => r.on_sale_date).filter(Boolean).sort()[0];
  assert.notEqual(dominantOnSaleDate(shipment), earliestWins);
});

// ── the stamp check ──────────────────────────────────────────────────────────

test('stamp: today passes, yesterday FAILS, missing FAILS', () => {
  const html = d => `<html><!-- pull-feed-generated: ${d} --><body>x</body></html>`;
  assert.equal(checkStamp(html('2026-10-06'), '2026-10-06'), null);
  assert.match(checkStamp(html('2026-10-05'), '2026-10-06'), /not today/);
  assert.match(checkStamp('<html>no stamp here</html>', '2026-10-06'), /no pull-feed-generated stamp/);
  assert.equal(readStamp(html('2026-10-06')), '2026-10-06');
});

test('stamp CLI: exits 0 for a file stamped today, exits 1 for a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f135-stamp-'));
  const today = new Date().toISOString().slice(0, 10);
  const fresh = join(dir, 'fresh.html'), stale = join(dir, 'stale.html');
  writeFileSync(fresh, `<!-- pull-feed-generated: ${today} -->`);
  writeFileSync(stale, '<!-- pull-feed-generated: 2020-01-01 -->');
  const script = join(import.meta.dirname, '..', 'scripts', 'check-stamp.js');
  assert.equal(spawnSync(process.execPath, [script, fresh]).status, 0);
  const bad = spawnSync(process.execPath, [script, stale], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Refusing to send/);
});

// ── the served-thumbnails wait ───────────────────────────────────────────────

test('extractAssetUrls: thumbnails and images only, de-duplicated; other links ignored', () => {
  const html = `
    <img src="https://mrcyberrick.github.io/weekly-pull-feed/thumbs/${'a'.repeat(32)}.webp">
    <img src="https://mrcyberrick.github.io/weekly-pull-feed/thumbs/${'a'.repeat(32)}.webp">
    <img src="https://mrcyberrick.github.io/weekly-pull-feed/images/hero.jpg">
    <a href="https://rjbookstop.pulllist.app/subscriptions.html?ref=newsletter">x</a>
    <a href="https://mrcyberrick.github.io/weekly-pull-feed/newsletter.html">browser version</a>`;
  assert.deepEqual(extractAssetUrls(html), [
    `https://mrcyberrick.github.io/weekly-pull-feed/thumbs/${'a'.repeat(32)}.webp`,
    'https://mrcyberrick.github.io/weekly-pull-feed/images/hero.jpg',
  ]);
});

function server(handler) {
  return new Promise(resolve => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}

test('thumbnail wait: RED - an image that never serves fails the wait', async () => {
  const { s, port } = await server((req, res) => { res.statusCode = req.url === '/ok' ? 200 : 404; res.end(); });
  try {
    const result = await waitForUrls([`http://127.0.0.1:${port}/ok`, `http://127.0.0.1:${port}/missing`],
      { timeoutMs: 400, intervalMs: 50, log: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].status, 404);
    assert.match(result.failed[0].url, /missing$/);
  } finally { s.close(); }
});

test('thumbnail wait: GREEN - an image that 404s at first, then serves, is waited for', async () => {
  // This is the Pages-deploy gap: the commit is in, the site has not caught up yet.
  let hits = 0;
  const { s, port } = await server((req, res) => { res.statusCode = ++hits <= 3 ? 404 : 200; res.end(); });
  try {
    const result = await waitForUrls([`http://127.0.0.1:${port}/late.webp`],
      { timeoutMs: 3000, intervalMs: 50, log: () => {} });
    assert.equal(result.ok, true);
    assert.ok(hits > 3, 'it must have retried through the 404s');
  } finally { s.close(); }
});
