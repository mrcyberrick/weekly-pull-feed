///////////////////////////////////////////////////////////
// build-pull-feed.js — Weekly Pull Feed builder + publisher
//
// F135. HOME: mrcyberrick/weekly-pull-feed (this repo). It runs inside the send
// workflow (.github/workflows/send-newsletter.yml) immediately BEFORE the Brevo
// send, builds THIS run's week from the database, and publishes it in one commit.
//
// It used to live in the private scripts repo and ran at the end of import.js's
// shipment step, so the newsletter existed only as a side effect of an operator
// running a data import on a laptop with the right .env line uncommented. That
// failed in both directions: the wrong week was mailed (2026-08-11) and no week
// was mailed (2026-09-29). See technical-reference.md F135 in comic-preorder.
//
// DATA: it holds no Supabase key that matters. It reads one week of shipment
// through the anon-callable RPC get_pull_feed_week(p_slug, p_week_start)
// (docs/sql/2026-10-01-f135-pull-feed-week-rpc.sql in comic-preorder), which
// returns only title, cover_url, series_name and on_sale_date. The Supabase anon
// key is public by design. GitHub writes use the workflow's own GITHUB_TOKEN.
//
// Publishes three artifacts to this repo:
//   newsletter.html        — browser / GitHub Pages version
//   newsletter-email.html  — Brevo htmlContent (sent by send-newsletter.yml; the
//                            send script's fail-closed stale guard reads the
//                            <!-- pull-feed-generated: YYYY-MM-DD --> stamp)
//   rss.xml                — RSS 2.0 feed consumed by rjbookstop.com
//
// WHICH WEEK: the Mon–Sun week containing the run date, never "the latest week
// in the database". The newsletter previews the upcoming shipment, and a run on
// Tuesday evening is in that same calendar week. A run whose week has no rows
// FAILS LOUDLY (the shipment import has not happened yet) instead of publishing
// last week; a run whose rows have all already gone on sale fails too, unless a
// week is named explicitly. See resolveTargetWeek() and checkWeek().
//
// The three template builders below the marker were originally extracted
// VERBATIM from CODE.GS (only their upload tails replaced with `return
// html/xml`) so output stayed byte-compatible with the Apps Script pipeline
// across the cutover. CODE.GS IS RETIRED (2026-07-26) and THIS FILE IS NOW
// CANONICAL: edit the template builders directly here.
//
// Usage (env: SUPABASE_URL, SUPABASE_ANON_KEY; plus GITHUB_TOKEN to publish):
//   node scripts/build-pull-feed.js --local                      # render to pull-feed-out/, no uploads
//   node scripts/build-pull-feed.js --publish                    # this run's week -> commit on $GITHUB_REF_NAME
//   node scripts/build-pull-feed.js --publish --week=2026-09-30  # explicit week (any date inside it)
//   node scripts/build-pull-feed.js --publish --branch=scratch   # rehearse off main
//
// Idempotency: the whole publish is ONE Git Data API commit (blobs → tree →
// commit → ref), built on base_tree so untouched paths are inherited;
// thumbnails MD5-keyed and cache-skipped against a single tree snapshot;
// expired-thumbnail purge expressed as `sha: null` entries in the same tree.
// Thumbnails are kept for THUMB_RETENTION_DAYS past their last appearance so
// newsletters already sitting in inboxes keep rendering — see the constant.
// A same-week re-run re-uploads nothing and purges nothing; in practice it still
// makes one artifact-only commit, because rss.xml stamps <pubDate>/<lastBuildDate>
// with the build time.
///////////////////////////////////////////////////////////

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Configuration — read from the environment, lazily ───────────────────────
// Nothing is read at module load, so the pure helpers below can be required and
// unit-tested with no environment at all. Nothing here is a secret that matters:
// the Supabase anon key is public by design (the RPC's own projection is the
// boundary) and GITHUB_TOKEN is the workflow's own short-lived token.
const PRODUCTION_REF = 'plgegklqtdjxeglvyjte';

function config({ publish = false } = {}) {
  const need = name => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const cfg = {
    supabaseUrl: need('SUPABASE_URL').replace(/\/+$/, ''),
    anonKey: need('SUPABASE_ANON_KEY'),
    token: publish ? need('GITHUB_TOKEN') : null,
    slug: process.env.TENANT_SLUG || 'rjbookstop',
    repo: process.env.GITHUB_REPOSITORY || `${GITHUB_USERNAME}/${REPO}`,
  };
  // Wrong-environment guard — the pull feed publishes PRODUCTION data only.
  if (!cfg.supabaseUrl.includes(PRODUCTION_REF)) {
    throw new Error('SUPABASE_URL does not point at the production Supabase project');
  }
  return cfg;
}

// ── Publish-surface config (must match CODE.GS exactly) ─────────────────────
const GITHUB_USERNAME = 'mrcyberrick';
const REPO = 'weekly-pull-feed';
const DEFAULT_IMAGE = `https://mrcyberrick.github.io/weekly-pull-feed/images/default.webp`;
const NEWSLETTER_TITLE = 'Weekly Previews';
const NEWSLETTER_COLUMNS = 3;

// ── S1x: the cover grid shows ONE cover per series ──────────────────────────
// The grid used to render every shipment row, variants included. Measured on a
// REAL send (Brevo campaign 32, 2026-09-16): 77 covers, 101,494 bytes = 99.1 KB.
// That tripped the send script's own 95 KB guard and sat ~3 KB under Gmail's
// ~102 KB clip threshold, and Gmail is a large share of recipients. A clipped email
// hides the footer AND the open-tracking pixel, so it under-reports opens too.
//
// Deduping by series is the cut that costs nothing. That same week's 77 rows
// carry only 42 distinct series — 26 of them ship multiple covers (4x Superman
// Unlimited, 4x Wonder Woman, 4x Savage Sword Of Conan). Every title stays
// represented.
//
// The obvious alternative, truncating at N, was rejected: rows are sorted A-Z
// by title, so a fixed cap would cut the SAME back half of the alphabet every
// single week — X-Men and Wonder Woman would never appear again.
//
// It also makes the grid match the link semantics S6 introduced: one cover, one
// series, one subscribe link. Four Wonder Woman covers all pointed at the same
// subscribe search, which is three wasted clicks and three wasted tracked links.
//
// A row with no series_name is a one-shot or special with no next issue (see
// seriesUrlFor) — each is genuinely distinct, so all of them are kept.
const NEWSLETTER_MAX_COVERS = 60;

function gridRowsFor(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const series = row[2];
    if (!series) { out.push(row); continue; }   // one-shot — always keep
    if (seen.has(series)) continue;
    seen.add(series);
    out.push(row);
  }
  // Backstop for an unusually large week; dedupe alone handles a normal one.
  return out.slice(0, NEWSLETTER_MAX_COVERS);
}

// ── S6: a cover click SUBSCRIBES to that series ─────────────────────────────
// Until 2026-09-08 every cover linked to its own image file on
// media.lunardistribution.com / images.penguinrandomhouse.com — the
// overwhelming majority of clicks left the ecosystem entirely and landed on a
// bare JPEG with no store, no app, no signup and no way back.
//
// S1 pointed them at catalog.html instead. That was measured WRONG the same
// day: catalog.html hard-scopes to the current catalog_month (:634), and this
// newsletter's titles were solicited two to three months ago — of the
// 2026-09-07 week's 68 arriving titles, 55 sit in 2026-07, 9 in 2026-06 and 4
// have no catalog row, so **0 of 68 could ever appear there**. The newsletter
// is weekly_shipment (what ARRIVES) and the catalog is what you can ORDER NOW;
// they are disjoint by design. arrivals.html is no good either — it renders the
// same week the email already shows, so the click returns the reader to the
// covers they just looked at.
//
// Subscribing is the one action that fits. Nothing here can be ordered (every
// title is past its FOC and already on the truck), but "get it for me every
// month from now on" is exactly right, and it is the app's core loop. It also
// works for the very reason the catalog did not: searchSeries()
// (subscriptions.html:836) queries catalog with NO catalog_month filter — its
// own comment reads "standard covers only across all catalog months" — so a
// June or July series is findable today.
//
// `ref`/`series` are inert to the client today: app.js:115 is the only
// URLSearchParams call in the whole web app and it reads `?t=` alone, so
// unknown params cannot disturb TenantContext or any page's init. S6b is what
// makes `series` actually prefill the search.
const APP_BASE_URL = 'https://rjbookstop.pulllist.app';

// Returns an href-ready string (separator `&amp;`, matching MAPS_URL — the only
// other multi-param URL in these templates and one proven in production sends),
// or NULL when the title has no series.
//
// NULL is not a fallback, it is the correct answer: measured on the 2026-09-07
// week, the 10 titles without a series_name are one-shots and specials — Star
// Trek 60th Anniversary Special, Deviations, an ashcan promo, a Magic one-shot.
// There is no next issue to subscribe to, so the cover renders UNLINKED rather
// than sending the reader somewhere useless. (Rick's call, 2026-09-08.)
//
// Deliberately no `d=`/distributor param: the page's search dedupes by
// series_name||distributor and shows both if a series exists under each, so the
// reader picks. Adding one would mean new filter logic for a case that may
// never occur.
function seriesUrlFor(seriesName) {
  if (!seriesName) return null;
  return `${APP_BASE_URL}/subscriptions.html?ref=newsletter`
       + `&amp;series=${encodeURIComponent(seriesName)}`;
}

// S3 — the non-cover app links (title bar, hero, CTA button). Same `ref` as the
// covers, because both surfaces ARE the newsletter funnel; `p` names the
// placement so the click report distinguishes "clicked the big red button" from
// "clicked the logo", which are very different signals about the copy.
// Points at the front door, not the catalog: a newcomer needs Create Account,
// which is on the front door (verified 2026-09-08 against the served bytes).
function appUrl(placement) {
  return `${APP_BASE_URL}/?ref=newsletter&amp;p=${placement}`;
}

// ── Thumbnail retention ─────────────────────────────────────────────────────
// A thumbnail is NOT deleted the moment it stops being in this week's feed.
// It survives this many days past the last publish that referenced it.
//
// Why: the newsletter is an EMAIL. It sits in subscribers' inboxes long after
// the week it announced, and its <img> tags point at this repo's thumbs/. The
// original purge deleted every unreferenced thumb on the very next publish, so
// the moment a new week went out, last week's email turned into a grid of
// broken images in every inbox that still had it. The feed was correct; the
// mail people had already received rotted behind it.
//
// 14 days with a weekly cadence keeps roughly the last two or three issues
// alive — the previous newsletter is always intact, with a full cycle of slack
// for a late or skipped import. Raising this only costs repo size (~20KB per
// thumbnail, ~50 per week); it can never break a live feed, because anything
// the CURRENT week references is retained regardless of its age.
const THUMB_RETENTION_DAYS = 14;

// Last-seen ledger: { "<md5>": "YYYY-MM-DD" }, committed alongside the feed in
// the same single commit. Needed because thumbnails are content-addressed —
// `thumbs/<md5>.webp` carries no date, so without this there is nothing to age
// a file against. Kept at the repo root beside the artifacts it governs.
const RETENTION_FILE = 'thumb-retention.json';

// GAS shim — the generated template functions call Logger.log.
const Logger = { log: (...a) => console.log(...a) };

function ghHeaders() {
  return {
    Authorization: 'token ' + config({ publish: true }).token,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'build-pull-feed',
  };
}

// ── Week + data ──────────────────────────────────────────────────────────────
// Mon-Sun calendar week containing refDate — same rule as the app's
// DateUtils.weekRange() (canonical "This Week" definition).
function weekRange(refDate) {
  const d = refDate ? new Date(refDate + 'T12:00:00') : new Date();
  const daysSinceMon = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - daysSinceMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: fmt(monday), end: fmt(sunday) };
}

// ── Which week, and does the data justify publishing it? ────────────────────
// F135. These three are PURE (no I/O, injectable "today") so every failure mode
// can be forced red in a unit test and in a negative-control run — a guard that
// has never been seen to fail is not evidence (CLAUDE.md, comic-preorder).

// UTC calendar date. The pull-feed-generated stamp is UTC, so the "is the stamp
// today" check and this must use the same clock.
function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// The week this run builds. No --week: the Mon-Sun week containing the run date
// (a Tuesday-evening run is in the same week as the Wednesday it previews).
// --week=DATE: any date inside the wanted week — an explicit, deliberate choice.
// Deliberately NOT "the latest week in weekly_shipment" (the old fallback): that
// is last week the moment the weekly import is late, and publishing it is the
// 2026-08-11 incident from the other side. Deliberately not Wednesday-anchored
// either (CLAUDE.md § Key Business Logic: "Wednesday is not special").
function resolveTargetWeek({ weekArg = null, today = todayUTC() } = {}) {
  if (weekArg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekArg)) {
      throw new Error(`--week must be YYYY-MM-DD, got "${weekArg}"`);
    }
    return { refDate: weekArg, explicit: true };
  }
  return { refDate: today, explicit: false };
}

// The date the books actually land, for the masthead and the email: the DOMINANT
// on_sale_date in the week's rows, tie-broken to the LATEST. This is the rule
// import.js's resolveFeedWeek() used for the same purpose (see F135 § 1 and the
// 2026-08-11 earliest-wins incident it was fixed after): a week is one shipment
// plus noise, so the biggest cluster IS the week. Ported, not invented, so a
// workflow build and an import-time build agree (gate V3).
function dominantOnSaleDate(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    if (!r || !r.on_sale_date) continue;
    counts.set(r.on_sale_date, (counts.get(r.on_sale_date) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null;
  for (const [date, n] of counts) {
    if (!best || n > best.n || (n === best.n && date > best.date)) best = { date, n };
  }
  return best.date;
}

// Returns null when the week is publishable, else the reason it is not. Three
// distinct failures, each worded so the operator knows what to DO:
//   1. no rows        — the weekly shipment import has not run (F135 case b).
//   2. >= 1000 rows   — PostgREST's response cap; a truncated week must not
//                       publish as if it were whole (F82's lesson).
//   3. all past       — every row is already on sale and no week was named, so
//                       this would preview books already on the shelf.
function checkWeek({ rawRows, explicit, today, start, end }) {
  if (!rawRows.length) {
    return `No shipment rows for the week ${start} -> ${end}. The weekly shipment import has not run for this week - ` +
      `run it, then re-run this workflow. Refusing to publish a different week instead.`;
  }
  if (rawRows.length >= 1000) {
    return `get_pull_feed_week returned ${rawRows.length} rows, which is PostgREST's response cap - the week may be truncated. Refusing to publish it.`;
  }
  if (!explicit) {
    const latest = rawRows.map(r => r.on_sale_date).filter(Boolean).sort().pop();
    if (latest && latest < today) {
      return `Every row for ${start} -> ${end} is already on sale (latest ${latest}, today ${today}). ` +
        `Refusing to preview a past week - pass an explicit week if that is really what you want.`;
    }
  }
  return null;
}

// Fetch the week's shipment through the RPC and shape it exactly like the
// retired sheet: row[0] = image URL (cover_url), row[1] = title,
// row[2] = series_name, or null for a one-shot/special with no series (S6).
// Appended deliberately rather than reordered: three builders index this tuple
// positionally (buildNewsletterHtml, buildEmailHtml, buildRssXml) plus the
// thumbnail hash set and purge planner, and every one of them reads [0]/[1]
// only — so adding a third slot cannot disturb them, while reordering would
// break the browser page and the feed silently. Dedup by URL
// (CsvImporter behavior), sort A-Z by title (buildNewsletter behavior).
async function fetchWeekRows(refDate, explicit = true, today = todayUTC()) {
  const { start, end } = weekRange(refDate);
  console.log(`📅 Target week: ${start} → ${end}` +
    (explicit ? ' (named explicitly)' : ` (the week containing the run date ${today})`));

  const c = config();
  // The new-style sb_publishable_ anon key goes in `apikey` ONLY — it is not a
  // JWT, so it must not be sent as a Bearer token.
  const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/get_pull_feed_week`, {
    method: 'POST',
    headers: { apikey: c.anonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ p_slug: c.slug, p_week_start: start }),
  });
  if (!res.ok) {
    throw new Error(`get_pull_feed_week failed: HTTP ${res.status} ${await res.text()}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('get_pull_feed_week returned something other than a list.');

  const problem = checkWeek({ rawRows: raw, explicit, today, start, end });
  if (problem) throw new Error(problem);

  // Print the spread the date was chosen from. The earliest-wins bug of
  // 2026-08-11 was invisible for a full cycle because nothing ever said which
  // week the publish aimed at or what it chose between.
  const spread = {};
  for (const r of raw) spread[r.on_sale_date] = (spread[r.on_sale_date] || 0) + 1;
  const onSaleDate = dominantOnSaleDate(raw);
  console.log(`📌 ${raw.length} shipment row(s); on-sale date ${onSaleDate} (from ` +
    Object.keys(spread).sort().map(d => `${d}×${spread[d]}`).join(', ') + ')');

  const seen = new Set();
  const rows = [];
  let skipped = 0;
  for (const r of raw) {
    if (!r.cover_url || !r.title) { skipped++; continue; }
    const url = normalizeCoverUrl(r.cover_url);
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push([url, r.title, r.series_name || null]);
  }
  rows.sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));

  console.log(`📦 ${rows.length} unique titles from weekly_shipment` +
    (skipped ? ` (${skipped} rows without title/cover skipped)` : ''));
  // The email reports the SHIPMENT count, not rows.length. They are not the
  // same number: rows.length is taken after dropping rows with no title/cover
  // AND after deduping by normalized cover URL - and that dedupe is silent, so
  // a divergence would never announce itself. Measured across the 14 most
  // recent weeks, 2026-09-16 back to 2026-06-17: 0 skipped, 0 collapsed, every
  // week matched exactly. That is history, not a guarantee - so the count is
  // correct by construction, and any gap is reported loudly rather than
  // shipped quietly as a wrong number in front of customers.
  const collapsed = raw.length - skipped - rows.length;
  if (skipped || collapsed) {
    console.warn(
      `⚠️  shipment ${raw.length} but ${rows.length} renderable ` +
      `(${skipped} missing title/cover, ${collapsed} sharing a cover image). ` +
      `The email will report ${raw.length} titles arriving and show fewer covers.`);
  }

  // onSaleDate travels with the rows so the masthead can show the date the
  // books actually land, rather than the date this script happened to run.
  return { rows, onSaleDate, shipmentCount: raw.length, weekStart: start };
}

// Parity shim: import.js writes PRH covers as …/cover/{id}; the retired
// CsvImporter (and therefore the live feed's GUIDs and every cached
// thumbnail MD5) uses …/cover/d/{id}. Both forms serve the identical image
// (verified 2026-07-09), so we normalize to /d/ here to keep feed GUIDs
// stable and reuse the existing thumbs cache. If import.js ever
// standardizes on /d/, this becomes a no-op.
function normalizeCoverUrl(url) {
  return url.replace(
    /^https:\/\/images\.penguinrandomhouse\.com\/cover\/(?!d\/)/,
    'https://images.penguinrandomhouse.com/cover/d/'
  );
}

// ── Thumbnail helpers ───────────────────────────────────────────────────────
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function canonicalThumbUrl(imageUrl) {
  return `https://${GITHUB_USERNAME}.github.io/${REPO}/thumbs/${md5(imageUrl)}.webp`;
}

// ── GitHub Git Data API ─────────────────────────────────────────────────────
// The publish is ONE commit: blobs → one tree → one commit → one ref update.
//
// It used to be one Contents API commit per file — ~30 commits in ~30 seconds
// for a typical week. Every one of those pushes triggered a GitHub Pages
// deploy, and the deploys had no ordering guarantee between them: on
// 2026-07-25 a deployment of a MID-BURST commit landed 76 seconds AFTER the
// tip had already been deployed, so the live site served a tree captured
// partway through the thumbnail sequence and the last 10 thumbnails 404'd in
// a newsletter that had already gone out. One commit removes the race
// outright rather than narrowing it. See technical-reference.md F98 / F100.
async function gh(method, apiPath, body) {
  const res = await fetch(
    `https://api.github.com/repos/${config({ publish: true }).repo}${apiPath}`,
    {
      method,
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${apiPath} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// One snapshot of the branch we are about to commit on top of: its tip commit,
// its tree, and every thumbnail already published. Taking this ONCE (instead
// of a per-file existence probe) is what makes the cache check and the orphan
// purge agree with each other by construction.
async function readPublishState(branch) {
  const ref = await gh('GET', `/git/ref/heads/${branch}`);
  const commitSha = ref.object.sha;
  const commit = await gh('GET', `/git/commits/${commitSha}`);
  const tree = await gh('GET', `/git/trees/${commit.tree.sha}?recursive=1`);

  // A truncated tree would silently under-report published thumbs, which
  // would re-upload everything and purge nothing. Refuse rather than guess.
  if (tree.truncated) {
    throw new Error('GitHub returned a truncated tree listing - too many files to publish safely this way.');
  }

  const thumbs = new Map(); // md5 hash → tree path
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    const m = entry.path.match(/^thumbs\/([0-9a-f]{32})\.webp$/);
    if (m) thumbs.set(m[1], entry.path);
  }

  // Last-seen ledger for the retention window. Read from the SAME tree
  // snapshot as `thumbs` above, so the two cannot disagree about what is
  // published.
  //
  // Fails SAFE and loudly: an absent or unparseable ledger yields {}, which
  // planPurge() reads as "every unreferenced thumb was seen today" — nothing
  // is deleted this run and every clock restarts. The opposite default would
  // let one bad read wipe every thumbnail in the repo.
  let retention = {};
  const ledger = tree.tree.find(e => e.type === 'blob' && e.path === RETENTION_FILE);
  if (ledger) {
    try {
      const blob = await gh('GET', `/git/blobs/${ledger.sha}`);
      const parsed = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) retention = parsed;
      else throw new Error('not a JSON object');
    } catch (e) {
      Logger.log(`WARNING: ${RETENTION_FILE} unreadable (${e.message}) - retaining every thumbnail this run.`);
    }
  } else {
    Logger.log(`No ${RETENTION_FILE} yet - seeding it this run; nothing will be purged.`);
  }

  return { branch, commitSha, treeSha: commit.tree.sha, thumbs, retention, fileCount: tree.tree.length };
}

// Cache check → wsrv.nl resize (300px WebP q80, ≤100KB validation) → stage a
// blob. Returns the public thumb URL, or DEFAULT_IMAGE on any failure —
// identical semantics to the Contents API version it replaces, except that
// nothing is committed here: staged blobs are collected and land in the
// single tree commit at the end.
async function resolveThumb(imageUrl, state, staged) {
  if (!imageUrl) return DEFAULT_IMAGE;
  const hash = md5(imageUrl);
  const webpPath = 'thumbs/' + hash + '.webp';

  if (state.thumbs.has(hash)) {
    Logger.log('CACHED (skipping upload): ' + hash);
    return canonicalThumbUrl(imageUrl);
  }
  if (staged.has(webpPath)) {
    // Two rows resolving to the same cover within one run.
    return canonicalThumbUrl(imageUrl);
  }

  const resizedUrl = `https://wsrv.nl/?url=${encodeURIComponent(imageUrl)}&w=300&h=300&fit=inside&we&output=webp&q=80`;
  try {
    const imgResponse = await fetch(resizedUrl);
    if (!imgResponse.ok) {
      Logger.log('WSRV FETCH FAILED for: ' + imageUrl + ' (hash: ' + hash + ')');
      return DEFAULT_IMAGE;
    }
    const bytes = Buffer.from(await imgResponse.arrayBuffer());
    const sizeKB = bytes.length / 1024;
    Logger.log('WSRV returned ' + sizeKB.toFixed(1) + 'KB for: ' + hash);
    if (sizeKB > 100) {
      Logger.log('SIZE REJECTED (' + sizeKB.toFixed(1) + 'KB exceeds 100KB limit): ' + hash);
      return DEFAULT_IMAGE;
    }
    const blob = await gh('POST', '/git/blobs', {
      content: bytes.toString('base64'),
      encoding: 'base64',
    });
    staged.set(webpPath, blob.sha);
    Logger.log('STAGED: ' + webpPath);
  } catch (e) {
    Logger.log('ERROR in resolveThumb for ' + imageUrl + ': ' + e.message);
    return DEFAULT_IMAGE;
  }
  return canonicalThumbUrl(imageUrl);
}

// Local date parts, never toISOString() — a UTC-shifted stamp would age every
// thumbnail by a day in one direction or the other. Project-wide rule; see
// CLAUDE.md § Local Date Pattern and technical-reference.md F28.
function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Noon anchors on both sides so a DST boundary between the two dates cannot
// round the difference to the wrong day.
function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO + 'T12:00:00');
  const b = new Date(toISO + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

// Decide what to delete and rebuild the last-seen ledger, in one pass.
//
// Hashes both sides from the SAME normalized row[0] that resolveThumb()
// hashes (normalizeCoverUrl is applied once, in fetchWeekRows), so a live
// thumbnail can never be selected for purging.
//
// This used to delete every published thumb the current week did not
// reference. It now deletes only those unreferenced for longer than
// THUMB_RETENTION_DAYS, so the previous newsletter keeps working in inboxes.
//
// Returns { orphans, manifest, retained } — the caller commits `manifest`
// as RETENTION_FILE in the same tree as the deletions it justifies.
function planPurge(rows, state, today) {
  const activeHashes = new Set(rows.filter(r => r[0]).map(r => md5(r[0])));
  const previous = state.retention || {};
  const manifest = {};
  const orphans = [];
  const retained = [];

  // Everything this week references — cached or newly staged — is seen today.
  for (const hash of activeHashes) manifest[hash] = today;

  for (const [hash, treePath] of state.thumbs) {
    if (activeHashes.has(hash)) continue; // already stamped above

    // No ledger entry means this thumb predates retention tracking (or was
    // added by hand). Start its clock now rather than deleting a file we
    // cannot date — the failure direction here must be "keep too long".
    const lastSeen = previous[hash] || today;

    if (daysBetween(lastSeen, today) > THUMB_RETENTION_DAYS) {
      orphans.push(treePath); // deliberately left out of the new manifest
    } else {
      manifest[hash] = lastSeen; // preserve the ORIGINAL date, do not refresh
      retained.push(treePath);
    }
  }

  return { orphans, manifest, retained };
}

// Post-condition on the commit we just made: every thumb the newsletter
// references must exist in the published tree, every purged path must be
// gone, and all three artifacts must be present. This is the check that
// would have caught F98 at publish time instead of in a customer's inbox —
// though it proves the tree is correct, NOT that Pages has served it.
async function verifyPublishedTree(commitSha, expected) {
  const commit = await gh('GET', `/git/commits/${commitSha}`);
  const tree = await gh('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error('Cannot verify publish: tree listing truncated.');

  const present = new Set(tree.tree.filter(e => e.type === 'blob').map(e => e.path));
  const missing = [...expected.paths].filter(p => !present.has(p));
  const survived = expected.purged.filter(p => present.has(p));

  if (missing.length) {
    throw new Error(`Publish verification FAILED - ${missing.length} expected file(s) absent from the committed tree: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  }
  if (survived.length) {
    throw new Error(`Publish verification FAILED - ${survived.length} purged thumbnail(s) still present: ${survived.slice(0, 5).join(', ')}`);
  }
  Logger.log(`VERIFIED: ${expected.paths.size} referenced file(s) present, ${expected.purged.length} orphan(s) gone.`);
}

// ── Orchestration ────────────────────────────────────────────────────────────
async function buildThumbMap(rows, { publish, state, staged }) {
  const thumbMap = new Map();
  for (const row of rows) {
    const imageUrl = row[0];
    if (!imageUrl || thumbMap.has(imageUrl)) continue;
    thumbMap.set(
      imageUrl,
      publish ? await resolveThumb(imageUrl, state, staged) : canonicalThumbUrl(imageUrl)
    );
  }
  Logger.log('Thumbnail map built for ' + thumbMap.size + ' unique URLs.');
  return thumbMap;
}

// `branch` exists so the whole publish can be rehearsed against a scratch
// branch and its resulting tree diffed against a known-good publish before
// main is ever touched.
// Hand the result to the workflow's next steps (the Pages check, the thumbnail
// wait). A no-op outside Actions. `commit` is empty when nothing was committed.
function writeOutputs({ commit = '', titles = 0, weekStart = '' } = {}) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\ntitles=${titles}\nweek_start=${weekStart}\n`);
}

async function publishPullFeed({ refDate = todayUTC(), explicit = false, branch = 'main' } = {}) {
  console.log('--- PULL FEED PUBLISH ---');
  // fetchWeekRows runs checkWeek(): no rows / truncated / already-shipped all
  // throw HERE, before any GitHub call, so a bad week can never reach the repo.
  const { rows, onSaleDate, shipmentCount, weekStart } = await fetchWeekRows(refDate, explicit);
  if (!rows.length) throw new Error('No renderable shipment rows for the target week (every row lacks a title or cover) - refusing to publish an empty feed.');

  const state = await readPublishState(branch);
  console.log(`📍 ${branch} @ ${state.commitSha.slice(0, 8)} — ${state.fileCount} file(s), ${state.thumbs.size} thumbnail(s) already published`);

  const staged = new Map(); // tree path → blob sha
  const thumbMap = await buildThumbMap(rows, { publish: true, state, staged });
  const { orphans, manifest, retained } = planPurge(rows, state, todayLocalDate());
  Logger.log(
    `PURGE PLAN: ${orphans.length} thumbnail(s) past the ${THUMB_RETENTION_DAYS}-day window, ` +
    `${retained.length} older thumbnail(s) RETAINED so prior newsletters keep rendering.`
  );

  const artifacts = {
    'newsletter.html': buildNewsletterHtml(rows, thumbMap, { onSaleDate, shipmentCount }),
    'newsletter-email.html': buildEmailHtml(rows, thumbMap, { onSaleDate, shipmentCount }),
    'rss.xml': buildRssXml(rows, thumbMap),
    // Committed with the deletions it justifies, in the same tree — so the
    // ledger can never describe a purge that did not happen, or vice versa.
    [RETENTION_FILE]: JSON.stringify(manifest, null, 2) + '\n',
  };

  // base_tree means untouched paths (index.html, images/, scripts/, .github/,
  // and every cached thumbnail) are INHERITED rather than re-enumerated, so
  // this cannot strand a file it does not know about. Deletions are the
  // explicit `sha: null` entries.
  const treeEntries = [
    ...[...staged].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })),
    ...Object.entries(artifacts).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    ...orphans.map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
  ];

  const newTree = await gh('POST', '/git/trees', { base_tree: state.treeSha, tree: treeEntries });

  // Skip the commit entirely if nothing changed. Note this rarely fires:
  // rss.xml stamps the build time, so back-to-back runs differ by those
  // timestamps even when the newsletters are byte-identical.
  if (newTree.sha === state.treeSha) {
    console.log(`✅ Pull feed already current: ${rows.length} titles, byte-identical output — no commit made.`);
    writeOutputs({ commit: '', titles: rows.length, weekStart });
    return { titles: rows.length, commit: null, thumbsAdded: 0, thumbsPurged: 0, branch };
  }

  const summary =
    `Publish weekly pull feed: ${rows.length} titles` +
    (staged.size ? `, +${staged.size} thumbnail(s)` : '') +
    (orphans.length ? `, -${orphans.length} expired thumb(s)` : '');

  const commit = await gh('POST', '/git/commits', {
    message: `${summary}\n\nSingle-commit publish (newsletter.html, newsletter-email.html,\nrss.xml, ${RETENTION_FILE} and all thumbnail changes together) so this\nimport triggers exactly one Pages deploy. See technical-reference.md F98.\n\nThumbnails unreferenced for up to ${THUMB_RETENTION_DAYS} days are RETAINED so\nalready-delivered newsletters keep rendering in subscribers' inboxes.`,
    tree: newTree.sha,
    parents: [state.commitSha],
  });

  // Confirm the ref moved rather than assuming the PATCH took effect - but
  // read the answer from the PATCH's own response. An immediate follow-up GET
  // on the ref can still be served the PRE-update sha from a replica, which
  // reads exactly like a failed update and aborts a publish that in fact
  // succeeded (observed 2026-07-26 during the V2 rehearsal).
  const updated = await gh('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha });
  const movedTo = updated.object && updated.object.sha;
  if (movedTo !== commit.sha) {
    throw new Error(`Ref update did not take: ${branch} is at ${String(movedTo).slice(0, 8)}, expected ${commit.sha.slice(0, 8)}.`);
  }

  await verifyPublishedTree(commit.sha, {
    paths: new Set([...staged.keys(), ...Object.keys(artifacts), ...[...state.thumbs.values()].filter(p => !orphans.includes(p))]),
    purged: orphans,
  });

  console.log(`✅ Pull feed published: ${rows.length} titles → ${config({ publish: true }).repo}@${branch} in ONE commit ${commit.sha.slice(0, 8)}`);
  console.log(
    `   +${staged.size} thumbnail(s), -${orphans.length} expired, ` +
    `${retained.length} retained for prior issues, ${Object.keys(artifacts).length} artifacts`
  );
  writeOutputs({ commit: commit.sha, titles: rows.length, weekStart });
  return { titles: rows.length, commit: commit.sha, thumbsAdded: staged.size, thumbsPurged: orphans.length, branch };
}

async function buildLocal({ refDate = todayUTC(), explicit = false } = {}) {
  console.log('--- PULL FEED LOCAL BUILD (no uploads) ---');
  const { rows, onSaleDate, shipmentCount } = await fetchWeekRows(refDate, explicit);
  if (!rows.length) { console.warn('⚠️  No renderable shipment rows for the target week - nothing to build.'); return; }

  const thumbMap = await buildThumbMap(rows, { publish: false });
  const outDir = path.join(__dirname, 'pull-feed-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'newsletter.html'), buildNewsletterHtml(rows, thumbMap, { onSaleDate, shipmentCount }));
  fs.writeFileSync(path.join(outDir, 'newsletter-email.html'), buildEmailHtml(rows, thumbMap, { onSaleDate, shipmentCount }));
  fs.writeFileSync(path.join(outDir, 'rss.xml'), buildRssXml(rows, thumbMap));
  console.log(`✅ Wrote 3 artifacts for ${rows.length} titles → ${outDir}`);
  console.log('   (thumb URLs are canonical; --publish is what uploads any missing thumbs)');
}

module.exports = {
  publishPullFeed,
  // F135 week selection + guards: pure, exported so each failure can be forced
  // in test/week-guard.test.mjs.
  resolveTargetWeek, checkWeek, dominantOnSaleDate, weekRange, todayUTC,
  // Exported for the retention regression suite (test/thumb-retention.test.mjs).
  // planPurge is pure — the whole point of extracting it is that the delete
  // decision can be asserted without a publish, which is how the earlier
  // delete-everything-unreferenced behaviour went a year unnoticed: it was only
  // observable by reading a commit message after the fact.
  planPurge, md5, todayLocalDate, daysBetween, THUMB_RETENTION_DAYS, RETENTION_FILE,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const weekArg = (args.find(a => a.startsWith('--week=')) || '').replace('--week=', '') || null;
  // In Actions the commit goes on the branch the run is on (the schedule always
  // runs on main; a rehearsal dispatched with --ref <scratch> publishes there).
  const branchArg = (args.find(a => a.startsWith('--branch=')) || '').replace('--branch=', '')
    || process.env.GITHUB_REF_NAME || 'main';
  const mode = args.includes('--publish') ? 'publish' : 'local';

  let target;
  try { target = resolveTargetWeek({ weekArg }); }
  catch (err) { console.error('FATAL:', err.message); process.exit(1); }

  if (mode === 'publish' && branchArg !== 'main') {
    console.log(`⚠️  Publishing to branch "${branchArg}" - main is untouched.`);
  }

  (mode === 'publish'
    ? publishPullFeed({ ...target, branch: branchArg })
    : buildLocal(target))
    .catch(err => { console.error('FATAL:', err.message); process.exit(1); });
}

///////////////////////////////////////////////////////////
// TEMPLATE BUILDERS — originally extracted verbatim from CODE.GS (upload
// tails replaced with `return`). CODE.GS was formally retired 2026-07-26,
// so this is the canonical copy now: hand-edit freely, there is no
// assembler step and no upstream source to regenerate from.
///////////////////////////////////////////////////////////

function buildNewsletterHtml(rows, thumbMap, meta = {}) {
  // shipmentCount is the real weekly_shipment row count; rows.length is
  // only what survived filtering and cover-URL dedupe. Customer-facing
  // copy must quote the former. The fallback covers a caller that omits it.
  const { onSaleDate, shipmentCount = rows.length } = meta;
  const HERO_IMAGE = `https://${GITHUB_USERNAME}.github.io/${REPO}/images/hero.jpg`;
  // Founding tenant front door, matching buildEmailHtml. The apex renders a
  // dead end for prospects ("Your shop can set one up for you"); the tenant
  // front door renders "Create one →" and opens native signup.
  const PREORDER_URL = "https://rjbookstop.pulllist.app";

  // Build thumbnail rows — identical logic to prior version
  let tableRows = "";
  const grid = gridRowsFor(rows);
  for (let i = 0; i < grid.length; i += NEWSLETTER_COLUMNS) {
    tableRows += `<tr>`;
    for (let c = 0; c < NEWSLETTER_COLUMNS; c++) {
      const row = grid[i + c];
      if (!row || !row[0]) {
        tableRows += `<td class="col" style="width:33%;padding:8px;text-align:center;vertical-align:top;"></td>`;
        continue;
      }
      const originalUrl = row[0] || "";
      const thumb       = thumbMap.get(originalUrl) || DEFAULT_IMAGE;
      const title       = row[1] || "";
      // originalUrl still keys the thumbnail map; only the wrapper changes (S6).
      // No series => NO anchor at all. A <div> carries the identical display
      // and colour, so the cell lays out the same whether or not it links.
      const linkUrl     = seriesUrlFor(row[2]);
      const openTag     = linkUrl
        ? `<a href="${linkUrl}" target="_blank" rel="noopener noreferrer"
             style="text-decoration:none;display:block;">`
        : `<div style="display:block;">`;
      const closeTag    = linkUrl ? '</a>' : '</div>';
      tableRows += `
        <td class="col" style="width:33%;padding:8px;text-align:center;vertical-align:top;">
          ${openTag}
            <img src="${thumb}"
                 alt="${title}"
                 title="${title}"
                 width="170"
                 style="display:block;margin:0 auto;max-width:100%;height:auto;
                        border-radius:4px;border:0;">
            <p style="margin:6px 0 0;font-size:11px;line-height:1.5;
                      color:#9a9390;font-family:'IBM Plex Sans',Arial,sans-serif;">
              ${title}
            </p>
          ${closeTag}
        </td>`;
    }
    tableRows += `</tr>`;
  }

  // The date on the masthead is the week the books LAND, not the day this
  // script ran. Measured on the 2026-09-16 send: the feed was built Friday
  // 09-11 and the masthead read "September 11" on an email whose subject said
  // September 15 and whose body said "on sale Wednesday" (the 16th) - three
  // different dates, and the one shown was the least useful of them.
  // Parsed as local parts, never new Date(iso) - that parses as UTC and would
  // render the previous day west of Greenwich (F28).
  const pubDate = onSaleDate
    ? (([y, m, d]) => new Date(+y, +m - 1, +d))(onSaleDate.split('-'))
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${NEWSLETTER_TITLE}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
        rel="stylesheet">
  <style>
    /*
     * MOBILE OVERRIDE
     * On screens under 480px each .col cell expands to full width,
     * stacking the 3-column layout into a single column.
     */
    @media only screen and (max-width: 480px) {
      .col {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      .col img {
        width: 80% !important;
        max-width: 280px !important;
      }
      .promo-feat {
        display: block !important;
        width: 100% !important;
        border-left: none !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
    }

    /* Promo collapse / expand */
    #promo-section {
      transition: max-height 0.45s cubic-bezier(.4,0,.2,1), opacity 0.35s ease;
      max-height: 700px;
      overflow: hidden;
    }
    #promo-section.dismissed {
      max-height: 0 !important;
      opacity: 0;
    }

    /* Re-open tab */
    #promo-tab {
      display: none;
      cursor: pointer;
      background: #e8321c;
      color: #f0ece4;
      font-family: 'Bebas Neue', sans-serif;
      font-size: 15px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      text-align: center;
      padding: 10px 20px;
      border: none;
      width: 100%;
      max-width: 640px;
      transition: background 0.18s ease;
    }
    #promo-tab:hover   { background: #ff4a30; }
    #promo-tab.visible { display: block; }

    /* Dismiss hover */
    #promo-close { transition: all 0.18s ease; }
    #promo-close:hover {
      background: rgba(255,74,48,0.25) !important;
      border-color: rgba(240,236,228,0.45) !important;
    }

    .feat-icon-wrap { transition: transform 0.18s ease; }
    .feat-item:hover .feat-icon-wrap { transform: scale(1.1); }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#0f0f0f;
             font-family:'IBM Plex Sans',Arial,sans-serif;
             font-size:16px;line-height:1.6;color:#f0ece4;">

  <!-- Re-open tab: hidden until promo is dismissed -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:#0f0f0f;">
    <tr>
      <td align="center">
        <button id="promo-tab" onclick="reopenPromo()">
          &#9650;&nbsp; Start Your Pull List &mdash; Free
        </button>
      </td>
    </tr>
  </table>

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:#0f0f0f;">
    <tr>
      <td align="center" style="padding:20px 10px;">

        <!-- Inner content table: 640px max width -->
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"
               style="max-width:640px;width:100%;
                      background-color:#181818;
                      border:1px solid #2e2e2e;
                      border-radius:8px;
                      overflow:hidden;
                      box-shadow:0 4px 24px rgba(0,0,0,0.5);">

          <!-- ═══ TITLE BAR ═══ -->
          <!-- bg-elevated (#222) lifts off bg-card (#181818) body -->
          <tr>
            <td style="background-color:#222222;
                       border-bottom:1px solid #2e2e2e;
                       text-align:center;
                       padding:20px 24px;">
              <div style="font-family:'Bebas Neue',sans-serif;
                          font-size:28px;letter-spacing:0.12em;
                          text-transform:uppercase;color:#f0ece4;line-height:1.15;">
                PULL<span style="color:#e8321c;">LIST</span>
                <br>${NEWSLETTER_TITLE}
              </div>
              <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                          font-size:11px;color:#5a5755;
                          letter-spacing:0.1em;text-transform:uppercase;
                          margin-top:5px;">
                Ray &amp; Judy&rsquo;s Book Stop &nbsp;&middot;&nbsp; ${pubDate}
              </div>
            </td>
          </tr>

          <!-- ═══ HERO IMAGE — links to the founding tenant front door ═══ -->
          <tr>
            <td style="line-height:0;font-size:0;padding:0;
                       border-bottom:1px solid #2e2e2e;">
              <a href="${appUrl('hero')}" target="_blank" rel="noopener noreferrer"
                 style="display:block;line-height:0;font-size:0;border:0;">
                <img src="${HERO_IMAGE}"
                     alt="${NEWSLETTER_TITLE}"
                     width="640"
                     style="display:block;width:100%;max-width:640px;
                            height:auto;border:0;">
              </a>
            </td>
          </tr>

          <!-- ══════════════════════════════════════════════════ -->
          <!-- ═══  PULL LIST PROMO — newsletter.html only   ═══ -->
          <!-- ══════════════════════════════════════════════════ -->
          <tr>
            <td id="promo-section"
                style="background-color:#181818;
                       border-bottom:1px solid #2e2e2e;
                       padding:0;">

              <!-- Promo label bar -->
              <table role="presentation" width="100%" cellpadding="0"
                     cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#e8321c;padding:12px 28px;">
                    <table role="presentation" width="100%" cellpadding="0"
                           cellspacing="0" border="0">
                      <tr>
                        <td style="vertical-align:middle;">
                          <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                      font-size:10px;font-weight:600;
                                      color:rgba(240,236,228,0.7);
                                      letter-spacing:0.2em;text-transform:uppercase;
                                      margin-bottom:3px;">
                            From the shop
                          </div>
                          <div style="font-family:'Bebas Neue',sans-serif;
                                      font-size:22px;letter-spacing:0.1em;
                                      color:#f0ece4;line-height:1;
                                      text-transform:uppercase;">
                            PULLLIST &nbsp;&middot;&nbsp;
                            <span style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                         font-size:15px;font-weight:500;
                                         letter-spacing:0.01em;text-transform:none;">
                              Never miss an issue again
                            </span>
                          </div>
                        </td>
                        <td style="text-align:right;vertical-align:middle;
                                   padding-left:16px;">
                          <button id="promo-close"
                                  onclick="dismissPromo()"
                                  style="background:rgba(0,0,0,0.2);
                                         border:1px solid rgba(240,236,228,0.3);
                                         color:#f0ece4;
                                         font-family:'IBM Plex Sans',Arial,sans-serif;
                                         font-size:11px;font-weight:600;
                                         letter-spacing:0.1em;text-transform:uppercase;
                                         padding:6px 14px;border-radius:4px;
                                         cursor:pointer;white-space:nowrap;">
                            Dismiss &#x2715;
                          </button>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Feature columns -->
              <table role="presentation" width="100%" cellpadding="0"
                     cellspacing="0" border="0">
                <tr>
                  <td style="padding:22px 24px 20px;">
                    <table role="presentation" width="100%" cellpadding="0"
                           cellspacing="0" border="0">
                      <tr>

                        <!-- LEFT: features 1–3 -->
                        <td class="promo-feat"
                            style="width:50%;vertical-align:top;padding-right:20px;">

                          <!-- Feature 1 -->
                          <table role="presentation" width="100%" cellpadding="0"
                                 cellspacing="0" border="0"
                                 style="margin-bottom:16px;" class="feat-item">
                            <tr>
                              <td style="width:36px;vertical-align:top;padding-right:12px;">
                                <div class="feat-icon-wrap"
                                     style="width:34px;height:34px;
                                            background:rgba(232,50,28,0.15);
                                            border:1px solid rgba(232,50,28,0.3);
                                            border-radius:4px;display:table-cell;
                                            text-align:center;vertical-align:middle;">
                                  <svg width="16" height="16" fill="none"
                                       stroke="#e8321c" stroke-width="2"
                                       viewBox="0 0 24 24" style="vertical-align:middle;">
                                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0
                                             002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2
                                             0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2
                                             2 4-4"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="vertical-align:top;">
                                <div style="font-family:'Bebas Neue',sans-serif;
                                            font-size:15px;letter-spacing:0.08em;
                                            color:#f0ece4;margin-bottom:3px;
                                            text-transform:uppercase;">
                                  Your list, always up to date
                                </div>
                                <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                            font-size:12px;color:#9a9390;line-height:1.5;">
                                  Browse the full monthly catalog and reserve what you
                                  want &mdash; any time, any device.
                                </div>
                              </td>
                            </tr>
                          </table>

                          <!-- Feature 2 -->
                          <table role="presentation" width="100%" cellpadding="0"
                                 cellspacing="0" border="0"
                                 style="margin-bottom:16px;" class="feat-item">
                            <tr>
                              <td style="width:36px;vertical-align:top;padding-right:12px;">
                                <div class="feat-icon-wrap"
                                     style="width:34px;height:34px;
                                            background:rgba(59,130,246,0.15);
                                            border:1px solid rgba(59,130,246,0.3);
                                            border-radius:4px;display:table-cell;
                                            text-align:center;vertical-align:middle;">
                                  <svg width="16" height="16" fill="none"
                                       stroke="#3b82f6" stroke-width="2"
                                       viewBox="0 0 24 24" style="vertical-align:middle;">
                                    <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118
                                             14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0
                                             10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0
                                             .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3
                                             0 11-6 0v-1m6 0H9"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="vertical-align:top;">
                                <div style="font-family:'Bebas Neue',sans-serif;
                                            font-size:15px;letter-spacing:0.08em;
                                            color:#f0ece4;margin-bottom:3px;
                                            text-transform:uppercase;">
                                  Auto-reserve your series
                                </div>
                                <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                            font-size:12px;color:#9a9390;line-height:1.5;">
                                  Subscribe once &mdash; automatically added to your
                                  pull list every month.
                                </div>
                              </td>
                            </tr>
                          </table>

                          <!-- Feature 3 -->
                          <table role="presentation" width="100%" cellpadding="0"
                                 cellspacing="0" border="0" class="feat-item">
                            <tr>
                              <td style="width:36px;vertical-align:top;padding-right:12px;">
                                <div class="feat-icon-wrap"
                                     style="width:34px;height:34px;
                                            background:rgba(34,197,94,0.15);
                                            border:1px solid rgba(34,197,94,0.3);
                                            border-radius:4px;display:table-cell;
                                            text-align:center;vertical-align:middle;">
                                  <svg width="16" height="16" fill="none"
                                       stroke="#22c55e" stroke-width="2"
                                       viewBox="0 0 24 24" style="vertical-align:middle;">
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                    <line x1="8"  y1="2" x2="8"  y2="6"/>
                                    <line x1="3"  y1="10" x2="21" y2="10"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="vertical-align:top;">
                                <div style="font-family:'Bebas Neue',sans-serif;
                                            font-size:15px;letter-spacing:0.08em;
                                            color:#f0ece4;margin-bottom:3px;
                                            text-transform:uppercase;">
                                  Know what&rsquo;s arriving
                                </div>
                                <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                            font-size:12px;color:#9a9390;line-height:1.5;">
                                  Reserved titles grouped by arrival date &mdash; always
                                  know what&rsquo;s coming Wednesday.
                                </div>
                              </td>
                            </tr>
                          </table>

                        </td>

                        <!-- RIGHT: features 4–5 + CTA -->
                        <!-- border-accent (#444) for stronger column rule -->
                        <td class="promo-feat"
                            style="width:50%;vertical-align:top;
                                   padding-left:20px;
                                   border-left:1px solid #444;">

                          <!-- Feature 4 -->
                          <table role="presentation" width="100%" cellpadding="0"
                                 cellspacing="0" border="0"
                                 style="margin-bottom:16px;" class="feat-item">
                            <tr>
                              <td style="width:36px;vertical-align:top;padding-right:12px;">
                                <div class="feat-icon-wrap"
                                     style="width:34px;height:34px;
                                            background:rgba(168,85,247,0.15);
                                            border:1px solid rgba(168,85,247,0.3);
                                            border-radius:4px;display:table-cell;
                                            text-align:center;vertical-align:middle;">
                                  <svg width="16" height="16" fill="none"
                                       stroke="#a855f7" stroke-width="2"
                                       viewBox="0 0 24 24" style="vertical-align:middle;">
                                    <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2
                                             2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2
                                             2v10a2 2 0 002 2z"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="vertical-align:top;">
                                <div style="font-family:'Bebas Neue',sans-serif;
                                            font-size:15px;letter-spacing:0.08em;
                                            color:#f0ece4;margin-bottom:3px;
                                            text-transform:uppercase;">
                                  Your list in your inbox
                                </div>
                                <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                            font-size:12px;color:#9a9390;line-height:1.5;">
                                  Email yourself a full confirmation &mdash; a personal
                                  record ready for pickup.
                                </div>
                              </td>
                            </tr>
                          </table>

                          <!-- Feature 5 -->
                          <table role="presentation" width="100%" cellpadding="0"
                                 cellspacing="0" border="0"
                                 style="margin-bottom:20px;" class="feat-item">
                            <tr>
                              <td style="width:36px;vertical-align:top;padding-right:12px;">
                                <div class="feat-icon-wrap"
                                     style="width:34px;height:34px;
                                            background:rgba(245,158,11,0.15);
                                            border:1px solid rgba(245,158,11,0.3);
                                            border-radius:4px;display:table-cell;
                                            text-align:center;vertical-align:middle;">
                                  <svg width="16" height="16" fill="none"
                                       stroke="#f59e0b" stroke-width="2"
                                       viewBox="0 0 24 24" style="vertical-align:middle;">
                                    <circle cx="11" cy="11" r="8"/>
                                    <path d="m21 21-4.35-4.35"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="vertical-align:top;">
                                <div style="font-family:'Bebas Neue',sans-serif;
                                            font-size:15px;letter-spacing:0.08em;
                                            color:#f0ece4;margin-bottom:3px;
                                            text-transform:uppercase;">
                                  Discover what you&rsquo;ll love
                                </div>
                                <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                            font-size:12px;color:#9a9390;line-height:1.5;">
                                  Personalized recommendations surface new titles
                                  from series you already enjoy.
                                </div>
                              </td>
                            </tr>
                          </table>

                          <!-- CTA block -->
                          <!-- bg-elevated lifts off promo bg-card -->
                          <div style="background:#222222;
                                      border:1px solid #2e2e2e;
                                      border-radius:8px;
                                      padding:16px;text-align:center;">
                            <div style="font-family:'Bebas Neue',sans-serif;
                                        font-size:16px;letter-spacing:0.1em;
                                        color:#f0ece4;text-transform:uppercase;
                                        margin-bottom:4px;">
                              Start Your Pull List &mdash; Free
                            </div>
                            <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                        font-size:11px;color:#9a9390;margin-bottom:10px;">
                              Takes about a minute &middot; set it up online,
                              pick up in store
                            </div>
                            <a href="${appUrl('web-cta')}" target="_blank"
                               rel="noopener noreferrer"
                               style="display:inline-block;background:#e8321c;
                                      border-radius:4px;padding:9px 20px;
                                      text-decoration:none;
                                      font-family:'IBM Plex Sans',Arial,sans-serif;
                                      font-size:12px;font-weight:600;
                                      color:#f0ece4;letter-spacing:0.04em;">
                              Create your free account
                            </a>
                            <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                                        font-size:11px;
                                        color:rgba(240,236,228,0.65);
                                        margin-top:9px;">
                              Or ask a staff member &middot; 973-586-9182
                              &middot; 40 W Main St, Rockaway&nbsp;NJ
                            </div>
                          </div>

                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
          <!-- ═══ END PROMO ═══ -->

          <!-- SECTION LABEL -->
          <!-- bg-elevated (#222) frames transition into the grid -->
          <tr>
            <td style="background-color:#222222;
                       border-top:1px solid #2e2e2e;
                       border-bottom:1px solid #2e2e2e;
                       padding:10px 16px;">
              <div style="font-family:'Bebas Neue',sans-serif;
                          font-size:13px;letter-spacing:0.18em;
                          text-transform:uppercase;color:#5a5755;">
                This Week&rsquo;s Releases
              </div>
              <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                          font-size:10px;color:#5a5755;margin-top:3px;">
                One cover per series &nbsp;&middot;&nbsp; ${shipmentCount} titles arriving
              </div>
            </td>
          </tr>

          <!-- THUMBNAIL GRID -->
          <!-- bg-card (#181818) — same card surface as promo section -->
          <tr>
            <td style="padding:12px;background-color:#181818;">
              <table role="presentation" width="100%" cellpadding="0"
                     cellspacing="0" border="0">
                ${tableRows}
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <!-- bg-elevated (#222) mirrors title bar for end-cap symmetry -->
          <tr>
            <td style="background-color:#222222;
                       border-top:1px solid #2e2e2e;
                       text-align:center;
                       padding:14px 20px;">
              <div style="font-family:'Bebas Neue',sans-serif;
                          font-size:14px;letter-spacing:0.1em;
                          color:#f0ece4;text-transform:uppercase;
                          margin-bottom:4px;">
                PULL<span style="color:#e8321c;">LIST</span>
                &nbsp;&middot;&nbsp; Ray &amp; Judy&rsquo;s Book Stop
              </div>
              <div style="font-family:'IBM Plex Sans',Arial,sans-serif;
                          font-size:11px;color:#5a5755;letter-spacing:0.04em;">
                ${NEWSLETTER_TITLE} &bull; ${pubDate}
                &nbsp;&middot;&nbsp; 973-586-9182
                &nbsp;&middot;&nbsp; 40 W Main St, Rockaway&nbsp;NJ
              </div>
            </td>
          </tr>

        </table>
        <!-- End inner content table -->

      </td>
    </tr>
  </table>
  <!-- End outer wrapper -->

  <script>
    function dismissPromo() {
      var s = document.getElementById('promo-section');
      var t = document.getElementById('promo-tab');
      s.classList.add('dismissed');
      setTimeout(function() {
        s.style.display = 'none';
        t.classList.add('visible');
      }, 450);
    }
    function reopenPromo() {
      var s = document.getElementById('promo-section');
      var t = document.getElementById('promo-tab');
      s.style.display = '';
      t.classList.remove('visible');
      setTimeout(function() { s.classList.remove('dismissed'); }, 10);
    }
  </script>

</body>
</html>`;

  return html;
}

function buildEmailHtml(rows, thumbMap, meta = {}) {
  // shipmentCount is the real weekly_shipment row count; rows.length is
  // only what survived filtering and cover-URL dedupe. Customer-facing
  // copy must quote the former. The fallback covers a caller that omits it.
  const { onSaleDate, shipmentCount = rows.length } = meta;
  const HERO_IMAGE   = `https://${GITHUB_USERNAME}.github.io/${REPO}/images/hero.jpg`;
  // Founding tenant's own front door, NOT the apex. Every newsletter
  // recipient is a Book Stop prospect, and the apex renders a dead end for
  // them ("Your shop can set one up for you") while the tenant front door
  // renders "Don't have an account? Create one →" and opens native signup.
  const PREORDER_URL = "https://rjbookstop.pulllist.app";
  const SHOP_PHONE   = "973-586-9182";
  const SHOP_ADDRESS = "40 W Main St, Rockaway&nbsp;NJ";
  const MAPS_URL     = "https://www.google.com/maps/search/?api=1&amp;query=40+W+Main+St+Rockaway+NJ";

  // The date on the masthead is the week the books LAND, not the day this
  // script ran. Measured on the 2026-09-16 send: the feed was built Friday
  // 09-11 and the masthead read "September 11" on an email whose subject said
  // September 15 and whose body said "on sale Wednesday" (the 16th) - three
  // different dates, and the one shown was the least useful of them.
  // Parsed as local parts, never new Date(iso) - that parses as UTC and would
  // render the previous day west of Greenwich (F28).
  const pubDate = onSaleDate
    ? (([y, m, d]) => new Date(+y, +m - 1, +d))(onSaleDate.split('-'))
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Machine-readable freshness stamp (YYYY-MM-DD) for the stale-content guard.
  // The Node send script reads this comment, computes age in days, and aborts
  // the send if content is older than its threshold — fail-closed so a week
  // with no prep never ships a stale duplicate.
  const stampISO = new Date().toISOString().slice(0, 10);

  // Build thumbnail rows — identical logic to uploadNewsletterTemplate
  let tableRows = "";
  const grid = gridRowsFor(rows);
  for (let i = 0; i < grid.length; i += NEWSLETTER_COLUMNS) {
    tableRows += `<tr>`;
    for (let c = 0; c < NEWSLETTER_COLUMNS; c++) {
      const row = grid[i + c];
      if (!row || !row[0]) {
        tableRows += `<td class="ml-col" style="width:33%;padding:8px;text-align:center;vertical-align:top;"></td>`;
        continue;
      }
      const originalUrl = row[0] || "";
      const thumb       = thumbMap.get(originalUrl) || DEFAULT_IMAGE;
      const title       = row[1] || "";
      // originalUrl still keys the thumbnail map; only the wrapper changes (S6).
      // No series => NO anchor at all. A <div> carries the identical display
      // and colour, so the cell lays out the same whether or not it links.
      const linkUrl     = seriesUrlFor(row[2]);
      const openTag     = linkUrl
        ? `<a href="${linkUrl}" target="_blank" rel="noopener noreferrer"
             style="text-decoration:none;display:block;color:#9a9390;">`
        : `<div style="display:block;color:#9a9390;">`;
      const closeTag    = linkUrl ? '</a>' : '</div>';
      tableRows += `
        <td class="ml-col" style="width:33%;padding:8px;text-align:center;
                                   vertical-align:top;">
          ${openTag}
            <img src="${thumb}"
                 alt="${title}"
                 title="${title}"
                 width="170"
                 style="display:block;margin:0 auto;max-width:100%;
                        height:auto;border-radius:4px;border:0;outline:none;">
            <p style="margin:6px 0 0;font-size:11px;line-height:1.5;
                      color:#9a9390;
                      font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;">
              ${title}
            </p>
          ${closeTag}
        </td>`;
    }
    tableRows += `</tr>`;
  }

  // Mobile media query embedded inside the body content.
  const mobileStyles = `
<style type="text/css">
  @media only screen and (max-width: 480px) {
    .ml-col {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
    }
    .ml-col img {
      width: 80% !important;
      max-width: 280px !important;
    }
    .ml-hero img {
      width: 100% !important;
      height: auto !important;
    }
  }
</style>`;

  const html = `${mobileStyles}
<!-- pull-feed-generated: ${stampISO} -->

<!-- Preheader — the inbox preview line shown next to the subject in Gmail /
     Apple Mail. Hidden in the rendered email. Without it, clients scrape
     whatever body copy comes first, which is not a deliberate message. The
     zero-width spaces stop that copy bleeding in after this text. -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;
            font-size:1px;line-height:1px;color:#0f0f0f;">
  ${shipmentCount} new titles on sale Wednesday &mdash; stop in before your favorites are gone
  &#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;
</div>

<!-- Weekly Pull Feed Newsletter — Brevo htmlContent block -->

<!-- Outer wrapper: #0f0f0f page tone with padding — the 600px card floats on it,
     matching newsletter.html's page/card separation -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;
              background-color:#0f0f0f;">
  <tr>
    <td align="center" style="padding:24px 12px;">

      <!-- Inner content table: 600px card, bordered to separate from page background.
           (Border restored for Brevo — the MailerLite double-border issue no longer applies.) -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;width:100%;
                    border-collapse:collapse;
                    border:1px solid #2e2e2e;
                    mso-table-lspace:0pt;mso-table-rspace:0pt;
                    background-color:#181818;">

        <!-- TITLE BAR — links to preorder app -->
        <tr>
          <td style="background-color:#222222;
                     border-bottom:3px solid #e8321c;
                     text-align:center;
                     padding:20px 24px;
                     mso-padding-alt:20px 24px;">
            <a href="${appUrl('header')}" target="_blank" rel="noopener noreferrer"
               style="text-decoration:none;color:#f0ece4;display:block;">
              <div style="font-family:'Bebas Neue','Arial Narrow','Trebuchet MS',Arial,sans-serif;
                          font-size:26px;
                          letter-spacing:4px;
                          text-transform:uppercase;
                          color:#f0ece4;
                          line-height:1.15;
                          mso-line-height-rule:exactly;">
                <!--[if mso]>
                <span style="font-family:Arial,sans-serif;font-size:26px;
                             letter-spacing:4px;color:#f0ece4;">
                  PULLLIST<br>${NEWSLETTER_TITLE}
                </span>
                <![endif]-->
                <!--[if !mso]><!-->
                PULL<span style="color:#e8321c;">LIST</span>
                <br>${NEWSLETTER_TITLE}
                <!--<![endif]-->
              </div>
              <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                          font-size:11px;
                          color:#5a5755;
                          letter-spacing:2px;
                          text-transform:uppercase;
                          margin-top:6px;
                          mso-line-height-rule:exactly;">
                Ray &amp; Judy&rsquo;s Book Stop &nbsp;&middot;&nbsp; ${pubDate}
              </div>
            </a>
          </td>
        </tr>

        <!-- HERO IMAGE — links to preorder app -->
        <tr>
          <td class="ml-hero"
              style="line-height:0;font-size:0;padding:0;
                     border-bottom:1px solid #2e2e2e;
                     mso-line-height-rule:exactly;">
            <a href="${appUrl('hero')}" target="_blank" rel="noopener noreferrer"
               style="display:block;line-height:0;font-size:0;border:0;">
              <!--[if mso]>
              <table role="presentation" width="600" cellpadding="0"
                     cellspacing="0" border="0">
              <tr><td width="600">
              <![endif]-->
              <img src="${HERO_IMAGE}"
                   alt="${NEWSLETTER_TITLE}"
                   width="600"
                   style="display:block;width:100%;max-width:600px;
                          height:auto;border:0;outline:none;
                          -ms-interpolation-mode:bicubic;">
              <!--[if mso]></td></tr></table><![endif]-->
            </a>
          </td>
        </tr>

        <!-- ═══ PULL LIST PROMO — condensed email edition ═══ -->

        <!-- Promo label bar — dark elevated (#222) with a thin red accent rule.
             Red is reserved for the single CTA banner below (one-red-element design). -->
        <tr>
          <td style="background-color:#222222;
                     border-top:2px solid #e8321c;
                     padding:14px 24px;
                     mso-padding-alt:14px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;">
              <tr>
                <td style="vertical-align:middle;white-space:nowrap;">
                  <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                              font-size:10px;font-weight:600;
                              color:#8a8582;
                              letter-spacing:3px;text-transform:uppercase;
                              margin-bottom:4px;
                              mso-line-height-rule:exactly;">
                    From the shop
                  </div>
                  <div style="font-family:'Bebas Neue','Arial Narrow','Trebuchet MS',Arial,sans-serif;
                              font-size:20px;letter-spacing:2px;
                              color:#f0ece4;line-height:1;
                              text-transform:uppercase;
                              mso-line-height-rule:exactly;">
                    PULL<span style="color:#e8321c;">LIST</span>
                  </div>
                </td>
                <td style="vertical-align:middle;text-align:right;padding-left:16px;">
                  <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                              font-size:14px;font-weight:500;
                              color:#9a9390;line-height:1.3;
                              mso-line-height-rule:exactly;">
                    Never miss an issue again
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Promo body: 3 features + CTA button -->
        <tr>
          <td style="background-color:#181818;
                     border-bottom:1px solid #2e2e2e;
                     padding:20px 24px 22px;
                     mso-padding-alt:20px 24px 22px;">

            <!-- Feature lines — Set A copy, centered as a block, text left-aligned within.
                 Dedicated check cells give crisp vertical alignment.
                 (Text marks, not SVG icons — Gmail/Outlook strip <svg>.) -->
            <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;margin:0 auto 18px;">
              <tr>
                <td style="width:22px;vertical-align:top;padding:0 0 9px;
                           font-family:Arial,Helvetica,sans-serif;
                           font-size:14px;font-weight:bold;color:#e8321c;
                           line-height:1.4;mso-line-height-rule:exactly;">&#10003;</td>
                <td style="padding:0 0 9px;
                           font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                           font-size:14px;color:#f0ece4;
                           line-height:1.4;mso-line-height-rule:exactly;">Free &mdash; takes about a minute</td>
              </tr>
              <tr>
                <td style="width:22px;vertical-align:top;padding:0 0 9px;
                           font-family:Arial,Helvetica,sans-serif;
                           font-size:14px;font-weight:bold;color:#e8321c;
                           line-height:1.4;mso-line-height-rule:exactly;">&#10003;</td>
                <td style="padding:0 0 9px;
                           font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                           font-size:14px;color:#f0ece4;
                           line-height:1.4;mso-line-height-rule:exactly;">We hold your books behind the counter</td>
              </tr>
              <tr>
                <td style="width:22px;vertical-align:top;padding:0;
                           font-family:Arial,Helvetica,sans-serif;
                           font-size:14px;font-weight:bold;color:#e8321c;
                           line-height:1.4;mso-line-height-rule:exactly;">&#10003;</td>
                <td style="padding:0;
                           font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                           font-size:14px;color:#f0ece4;
                           line-height:1.4;mso-line-height-rule:exactly;">Know what arrives Wednesday</td>
              </tr>
            </table>

            <!-- Pill CTA button — centered, auto-width, fully clickable.
                 border-radius renders in all modern clients; desktop Outlook
                 (Word engine) degrades gracefully to square corners, link intact. -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"
                   style="border-collapse:separate;margin:0 auto;">
              <tr>
                <td align="center" bgcolor="#e8321c"
                    style="border-radius:26px;
                           mso-padding-alt:15px 40px;">
                  <a href="${appUrl('cta')}" target="_blank" rel="noopener noreferrer"
                     style="display:inline-block;
                            padding:15px 40px;
                            font-family:'Bebas Neue','Arial Narrow','Trebuchet MS',Arial,sans-serif;
                            font-size:17px;
                            letter-spacing:2px;
                            text-transform:uppercase;
                            color:#f0ece4;
                            text-decoration:none;
                            text-align:center;
                            line-height:1;
                            border-radius:26px;
                            mso-line-height-rule:exactly;">
                    Start Your Pull List &mdash; Free
                  </a>
                </td>
              </tr>
            </table>

            <!-- CTA subtext -->
            <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                        font-size:11px;color:#9a9390;
                        text-align:center;margin-top:12px;
                        mso-line-height-rule:exactly;">
              New here? Set it up online, pick up in store.<br>
              ${SHOP_PHONE}
              &nbsp;&middot;&nbsp; ${SHOP_ADDRESS}
            </div>

          </td>
        </tr>
        <!-- ═══ END PROMO ═══ -->

        <!-- SECTION LABEL -->
        <tr>
          <td style="background-color:#222222;
                     border-bottom:1px solid #2e2e2e;
                     padding:10px 16px;
                     mso-padding-alt:10px 16px;">
            <div style="font-family:'Bebas Neue','Arial Narrow','Trebuchet MS',Arial,sans-serif;
                        font-size:13px;
                        letter-spacing:3px;
                        text-transform:uppercase;
                        color:#5a5755;
                        mso-line-height-rule:exactly;">
              This Week&rsquo;s Releases
            </div>
            <!-- The grid shows ONE cover per series (gridRowsFor), so it is
                 shorter than the title count in the preheader. Say so, rather
                 than leave a reader wondering where the rest went. -->
            <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                        font-size:10px;color:#5a5755;margin-top:3px;
                        mso-line-height-rule:exactly;">
              One cover per series &nbsp;&middot;&nbsp; ${shipmentCount} titles arriving
            </div>
          </td>
        </tr>

        <!-- THUMBNAIL GRID -->
        <tr>
          <td style="padding:12px;
                     background-color:#181818;
                     border-bottom:1px solid #2e2e2e;
                     mso-padding-alt:12px;">
            <table role="presentation" width="100%" cellpadding="0"
                   cellspacing="0" border="0"
                   style="border-collapse:collapse;
                          mso-table-lspace:0pt;mso-table-rspace:0pt;">
              ${tableRows}
            </table>
          </td>
        </tr>

        <!-- FOOTER — linked phone/address + native Brevo unsubscribe -->
        <tr>
          <td style="background-color:#222222;
                     text-align:center;
                     padding:14px 20px 16px;
                     mso-padding-alt:14px 20px 16px;">
            <div style="font-family:'Bebas Neue','Arial Narrow','Trebuchet MS',Arial,sans-serif;
                        font-size:14px;
                        letter-spacing:3px;
                        text-transform:uppercase;
                        color:#f0ece4;
                        margin-bottom:4px;
                        mso-line-height-rule:exactly;">
              <!--[if mso]>
              <span style="font-family:Arial,sans-serif;font-size:14px;
                           letter-spacing:3px;color:#f0ece4;">
                PULLLIST &middot; Ray &amp; Judy's Book Stop
              </span>
              <![endif]-->
              <!--[if !mso]><!-->
              PULL<span style="color:#e8321c;">LIST</span>
              &nbsp;&middot;&nbsp; Ray &amp; Judy&rsquo;s Book Stop
              <!--<![endif]-->
            </div>
            <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                        font-size:11px;
                        color:#5a5755;
                        letter-spacing:1px;
                        mso-line-height-rule:exactly;">
              ${NEWSLETTER_TITLE} &bull; ${pubDate}
              &nbsp;&middot;&nbsp;
              <a href="tel:+19735869182"
                 style="color:#5a5755;text-decoration:none;">${SHOP_PHONE}</a>
              &nbsp;&middot;&nbsp;
              <a href="${MAPS_URL}" target="_blank" rel="noopener noreferrer"
                 style="color:#5a5755;text-decoration:underline;">${SHOP_ADDRESS}</a>
            </div>
            <div style="font-family:'IBM Plex Sans',Arial,Helvetica,sans-serif;
                        font-size:11px;
                        color:#5a5755;
                        margin-top:8px;
                        mso-line-height-rule:exactly;">
              You&rsquo;re receiving this because you signed up for weekly pull list previews.
              &nbsp;
              <a href="{{ unsubscribe }}"
                 style="color:#9a9390;text-decoration:underline;">Unsubscribe</a>
            </div>
          </td>
        </tr>

      </table>
      <!-- End inner content table -->

    </td>
  </tr>
</table>
<!-- End outer wrapper -->`;

  return html;
}

function buildRssXml(rows, thumbMap) {
  Logger.log("--- BUILDING RSS FEED ---");

  // FEED_URL must exactly match the canonical public URL where rss.xml
  // is served — this is what the <atom:link rel="self"> tag references.
  const FEED_URL = `https://${GITHUB_USERNAME}.github.io/${REPO}/rss.xml`;
  const SITE_URL = `https://${GITHUB_USERNAME}.github.io/${REPO}/newsletter.html`;
  const HERO_IMAGE = `https://${GITHUB_USERNAME}.github.io/${REPO}/images/hero.jpg`;

  // RFC-822 date format required by RSS spec
  const pubDate = new Date().toUTCString();

  // Build individual RSS items
  let items = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;

    const originalUrl = row[0];
    const title = row[1] || "Untitled";

    // Compressed thumbnail for display in description block
    const thumbUrl = thumbMap.get(originalUrl) || DEFAULT_IMAGE;

    // Escape any special XML characters in the title
    const safeTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    // Flipboard requires 300+ characters in <description> for good layout.
    const descriptionText = `${safeTitle} is part of this week\'s pull list. `
      + `This release is now available and featured in the ${NEWSLETTER_TITLE}. `
      + `Click the cover image above to view the full-size image from the publisher. `
      + `This item was included in the weekly shipment and is ready for pickup or delivery.`;

    // Derive category from URL — Lunar URLs contain lunardistribution.com,
    // PRH URLs contain penguinrandomhouse.com
    const category = originalUrl.includes('lunardistribution.com') ? 'Comics' : 'Books';

    items += `
    <item>
      <title>${safeTitle}</title>

      <!-- Link points to the original full-size RAW image URL -->
      <link>${originalUrl}</link>

      <!-- GUID uniquely identifies this item across feed updates. -->
      <guid isPermaLink="true">${originalUrl}</guid>

      <!-- pubDate: RFC-822 format required by RSS spec and Flipboard -->
      <pubDate>${pubDate}</pubDate>

      <!-- dc:creator: required by Flipboard for each item -->
      <dc:creator>${NEWSLETTER_TITLE}</dc:creator>

      <!-- category: helps Flipboard content recommendation systems -->
      <category>${category}</category>

      <!-- enclosure: points to the ORIGINAL full-size image URL. -->
      <enclosure url="${originalUrl}" type="image/jpeg" length="0"/>

      <!-- description: thumbnail img + descriptive text -->
      <description><![CDATA[
        <a href="${originalUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${thumbUrl}"
               alt="${safeTitle}"
               title="${safeTitle}"
               width="300"
               height="300"
               border="0">
        </a>
        <p>${descriptionText}</p>
      ]]></description>
    </item>`;
  }

  // Assemble the full RSS 2.0 document
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:media="http://search.yahoo.com/mrss/">

  <channel>
    <title>${NEWSLETTER_TITLE}</title>
    <link>${SITE_URL}</link>
    <description>Weekly pull list of new releases with thumbnails and links to full-size cover images.</description>
    <language>en-us</language>
    <pubDate>${pubDate}</pubDate>
    <lastBuildDate>${pubDate}</lastBuildDate>
    <ttl>10080</ttl><!-- 10080 minutes = 1 week; hints to readers how often to check -->

    <!-- Canonical self-reference: required by Atom namespace -->
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>

    <!-- Feed thumbnail shown in RSS reader channel listings -->
    <image>
      <url>${HERO_IMAGE}</url>
      <title>${NEWSLETTER_TITLE}</title>
      <link>${SITE_URL}</link>
      <width>144</width>
      <height>144</height>
    </image>
    ${items}
  </channel>

</rss>`;

  return xml;
}
