// F135 / weekly-newsletter-architecture W1.2 - the Monday preflight.
//
// A guard is only evidence if it has been seen to FAIL, so each red path is asserted
// next to its green twin. Credential-free and network-free: the RPC call is an injected
// fake fetch, the clock is injected, and a "run" is just a function returning an exit code.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkWeek } = require('../scripts/build-pull-feed.js');
const { preflightProblem, run } = require('../scripts/preflight-week.js');

const PROD = 'https://plgegklqtdjxeglvyjte.supabase.co';
const ENV = { SUPABASE_URL: PROD, SUPABASE_ANON_KEY: 'sb_publishable_test' };
const MONDAY = new Date('2026-10-12T13:00:00Z');  // the cron's own moment: Monday 13:00 UTC
const WEDNESDAY = new Date('2026-10-14T12:00:00Z');

const rows = (...pairs) =>
  pairs.flatMap(([date, n]) => Array.from({ length: n }, () => ({ on_sale_date: date, title: 't' })));

// A fake fetch that records every call and answers with `body` (or a status).
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { impl, calls };
}

async function runWith({ body, status, env = ENV, argv = [], now = MONDAY }) {
  const f = fakeFetch(body, { status });
  const out = [], err = [];
  const code = await run({ argv, env, fetchImpl: f.impl, now, log: s => out.push(s), error: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), calls: f.calls };
}

// ── the pure decision ────────────────────────────────────────────────────────

const WEEK = { start: '2026-10-12', end: '2026-10-18' };

test('RED: no rows - the message says what to DO on a Monday, not "re-run this workflow"', () => {
  const p = preflightProblem({ rawRows: [], explicit: false, today: '2026-10-12', ...WEEK });
  assert.match(p, /No shipment rows for the week 2026-10-12 -> 2026-10-18/);
  assert.match(p, /Run the weekly shipment import before Tuesday 21:00 UTC/);
  assert.doesNotMatch(p, /re-run this workflow/);
});

test('GREEN: rows landing this week pass', () => {
  assert.equal(preflightProblem({ rawRows: rows(['2026-10-14', 119]), explicit: false, today: '2026-10-12', ...WEEK }), null);
});

test('RED: a response at PostgREST\'s 1000-row cap is refused - and it is the BUILDER\'s own wording', () => {
  const rawRows = rows(['2026-10-14', 1000]);
  const args = { rawRows, explicit: false, today: '2026-10-12', ...WEEK };
  assert.match(preflightProblem(args), /1000 rows/);
  // Identical text, so the preflight cannot drift from the guard it is warning about.
  assert.equal(preflightProblem(args), checkWeek(args));
});

test('RED: every row already on sale, no week named - refused; GREEN when the week is named', () => {
  const past = rows(['2026-10-07', 10]);
  assert.match(preflightProblem({ rawRows: past, explicit: false, today: '2026-10-12', ...WEEK }), /already on sale/);
  assert.equal(preflightProblem({ rawRows: past, explicit: true, today: '2026-10-12', ...WEEK }), null);
});

// ── the whole run ────────────────────────────────────────────────────────────

test('RED: an empty week exits 1 with a GitHub error annotation', async () => {
  const r = await runWith({ body: [] });
  assert.equal(r.code, 1);
  assert.match(r.err, /::error title=Newsletter preflight FAILED::/);
  assert.match(r.err, /No shipment rows for the week 2026-10-12 -> 2026-10-18/);
});

test('GREEN: a loaded week exits 0 and reports the count and the spread', async () => {
  const r = await runWith({ body: rows(['2026-10-14', 118], ['2026-10-13', 1]) });
  assert.equal(r.code, 0);
  assert.match(r.out, /OK: 119 shipment row\(s\) for 2026-10-12 -> 2026-10-18 \(2026-10-13x1, 2026-10-14x118\)/);
  assert.equal(r.err, '');
});

test('it asks for the Monday of the run date\'s week, not the run date itself', async () => {
  const r = await runWith({ body: rows(['2026-10-14', 3]), now: WEDNESDAY });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.calls[0].opts.body).p_week_start, '2026-10-12');
  assert.equal(JSON.parse(r.calls[0].opts.body).p_slug, 'rjbookstop');
});

test('a named week is checked instead (the dispatch input): a far-future week has no rows -> RED', async () => {
  const r = await runWith({ body: [], argv: ['--week=2030-01-09'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /2030-01-07 -> 2030-01-13/);
  assert.equal(JSON.parse(r.calls[0].opts.body).p_week_start, '2030-01-07');
});

test('READ-ONLY: exactly one call, to the read RPC, with no Authorization header', async () => {
  const r = await runWith({ body: rows(['2026-10-14', 2]) });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, `${PROD}/rest/v1/rpc/get_pull_feed_week`);
  assert.equal(r.calls[0].opts.method, 'POST');
  assert.deepEqual(Object.keys(r.calls[0].opts.headers).sort(), ['Accept', 'Content-Type', 'apikey']);
});

test('RED: a database error is a failure, never a pass', async () => {
  const r = await runWith({ body: 'boom', status: 500 });
  assert.equal(r.code, 1);
  assert.match(r.err, /get_pull_feed_week failed: HTTP 500/);
});

test('RED: a non-list response is a failure', async () => {
  const r = await runWith({ body: { message: 'oops' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /something other than a list/);
});

test('RED: a non-production SUPABASE_URL is refused before any request is made', async () => {
  const r = await runWith({ body: rows(['2026-10-14', 2]), env: { ...ENV, SUPABASE_URL: 'https://puoaiyezsreowpwxzxhj.supabase.co' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /production Supabase project/);
  assert.equal(r.calls.length, 0);
});

test('RED: missing configuration is a failure, not a silent pass', async () => {
  for (const missing of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    const env = { ...ENV }; delete env[missing];
    const r = await runWith({ body: rows(['2026-10-14', 2]), env });
    assert.equal(r.code, 1, missing);
    assert.match(r.err, new RegExp(`${missing} is not set`));
    assert.equal(r.calls.length, 0);
  }
});

test('RED: a malformed --week is rejected, not ignored', async () => {
  const r = await runWith({ body: rows(['2026-10-14', 2]), argv: ['--week=next-wednesday'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /YYYY-MM-DD/);
  assert.equal(r.calls.length, 0);
});
