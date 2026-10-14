///////////////////////////////////////////////////////////
// preflight-week.js - the Monday early warning for the Tuesday newsletter.
//
// F135 (comic-preorder docs/f135-decouple-feed-publish.md section 4.5) and
// docs/weekly-newsletter-architecture.md W1.2 / D4.
//
// WHY: the Tuesday build needs one input it cannot create - the week's shipment
// rows, loaded by the weekly shipment import on Rick's laptop. If they are not
// there the build fails loudly (it never publishes a stale issue), but that is
// Tuesday evening, with the newsletter already due. This asks the same question on
// Monday morning, with a day and a half to run the import.
//
// WHAT: READ-ONLY. One anonymous RPC call (get_pull_feed_week, the same one the
// builder uses). No commit, no Pages build, no Brevo call, no write of any kind.
// It exits 1 with a plain instruction when this week has nothing to build.
//
// THE RULE IS THE BUILDER'S, NOT A COPY OF IT: week selection, the "no rows" test,
// the PostgREST-cap test and the "already on sale" test are all required from
// build-pull-feed.js (resolveTargetWeek, checkWeek, weekRange, todayUTC). So the
// preflight and the build cannot disagree about what a ready week is. The only
// thing this file words differently is the no-rows message: "run the import before
// Tuesday" is the useful instruction on a Monday, "re-run this workflow" is not.
//
// Usage (env: SUPABASE_URL, SUPABASE_ANON_KEY; optional TENANT_SLUG):
//   node scripts/preflight-week.js                    # the week containing today (UTC)
//   node scripts/preflight-week.js --week=2030-01-07  # any date inside the week to check
///////////////////////////////////////////////////////////

'use strict';

const { resolveTargetWeek, checkWeek, weekRange, todayUTC } = require('./build-pull-feed.js');

// Same wrong-environment guard as the builder: this feed is PRODUCTION data only.
const PRODUCTION_REF = 'plgegklqtdjxeglvyjte';

// Pure. Returns null when the week is ready, else the reason it is not.
function preflightProblem({ rawRows, explicit, today, start, end }) {
  const problem = checkWeek({ rawRows, explicit, today, start, end });
  if (problem && !rawRows.length) {
    return `No shipment rows for the week ${start} -> ${end}. Run the weekly shipment import before ` +
      `Tuesday 21:00 UTC. Without those rows the Tuesday newsletter build fails and nothing is sent.`;
  }
  return problem;
}

// One RPC call, shaped exactly like the builder's (the sb_publishable_ anon key goes
// in `apikey` ONLY - it is not a JWT, so it must not be sent as a Bearer token).
async function fetchRawWeek({ supabaseUrl, anonKey, slug, start }, fetchImpl = fetch) {
  const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/get_pull_feed_week`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ p_slug: slug, p_week_start: start }),
  });
  if (!res.ok) throw new Error(`get_pull_feed_week failed: HTTP ${res.status} ${await res.text()}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('get_pull_feed_week returned something other than a list.');
  return raw;
}

function readConfig(env) {
  const need = name => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const supabaseUrl = need('SUPABASE_URL').replace(/\/+$/, '');
  if (!supabaseUrl.includes(PRODUCTION_REF)) {
    throw new Error('SUPABASE_URL does not point at the production Supabase project');
  }
  return { supabaseUrl, anonKey: need('SUPABASE_ANON_KEY'), slug: env.TENANT_SLUG || 'rjbookstop' };
}

// Returns the process exit code. All I/O is injected so every outcome can be forced
// in a test without a network or a clock.
async function run({
  argv = [], env = process.env, fetchImpl = fetch, now = new Date(),
  log = console.log, error = console.error,
} = {}) {
  try {
    const weekArg = (argv.find(a => a.startsWith('--week=')) || '').replace('--week=', '') || null;
    const today = todayUTC(now);
    const { refDate, explicit } = resolveTargetWeek({ weekArg, today });
    const { start, end } = weekRange(refDate);
    log(`Preflight: week ${start} -> ${end}` +
      (explicit ? ' (named explicitly)' : ` (the week containing the run date ${today})`));

    const cfg = readConfig(env);
    const rawRows = await fetchRawWeek({ ...cfg, start }, fetchImpl);
    const problem = preflightProblem({ rawRows, explicit, today, start, end });
    if (problem) {
      error(`::error title=Newsletter preflight FAILED::${problem}`);
      error(`FAILED: ${problem}`);
      return 1;
    }
    const spread = {};
    for (const r of rawRows) spread[r.on_sale_date] = (spread[r.on_sale_date] || 0) + 1;
    log(`OK: ${rawRows.length} shipment row(s) for ${start} -> ${end} ` +
      `(${Object.keys(spread).sort().map(d => `${d}x${spread[d]}`).join(', ')}). ` +
      `Tuesday's build has what it needs.`);
    return 0;
  } catch (err) {
    error(`::error title=Newsletter preflight could not run::${err.message}`);
    error(`FATAL: ${err.message}`);
    return 1;
  }
}

module.exports = { preflightProblem, fetchRawWeek, readConfig, run };

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).then(code => process.exit(code));
}
