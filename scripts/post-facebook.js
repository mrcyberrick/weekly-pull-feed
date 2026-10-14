///////////////////////////////////////////////////////////
// post-facebook.js - one Facebook Page photo post per week, linking to the shop's
// own "what's new" page, with a picture of three spotlight covers.
//
// Plan: comic-preorder docs/facebook-weekly-post.md (§ 3a image, § 3b landing and
// ranking limits, § 4.2 the run, § 5 runbook).
//
// WHAT ONE RUN DOES (exit 0 = posted, already posted, or dry run; exit 1 = alert):
//   1. Week: the builder's own rule (todayUTC / resolveTargetWeek / weekRange).
//   2. Rows: get_pull_feed_week, as the preflight reads it. None = the shipment
//      import has not run -> fail.
//   3. The landing page shows this week: the feed read THROUGH the site's Worker
//      (what rjbookstop.com/news/ renders) must have a lastBuildDate inside the week.
//   4. Count: <item>s in that feed (what a visitor will see).
//   5. Already posted? The Page's own recent posts are searched for this week's
//      marker (w=<monday>). Found -> exit 0, nothing posted. This is the dedupe;
//      there is no state file and the job never commits.
//   6. Picture: get_pull_feed_spotlight (3 covers, title order, no rank); download
//      the full-size covers; fill scripts/facebook-image.html; headless Chrome takes
//      a 1080x1350 screenshot. A cover that fails to download is dropped; none left
//      -> fail.
//   7. Post (unless DRY_RUN): multipart upload to /{page}/photos, then READ THE POST
//      BACK; only a permalink makes the run green (F96: acceptance is not delivery).
//   8. Log + $GITHUB_STEP_SUMMARY.
//
// SAFETY: the Page token is read only from FACEBOOK_PAGE_TOKEN, sent only in the
// Authorization header, and redacted from every message this script prints. POST is
// never retried (a retry could double-post; a rerun is covered by step 5).
//
// Usage: node scripts/post-facebook.js [--week=YYYY-MM-DD]
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY, TENANT_SLUG (default rjbookstop),
//        FACEBOOK_PAGE_ID, FACEBOOK_PAGE_TOKEN, FACEBOOK_GRAPH_VERSION,
//        LANDING_URL, FEED_CHECK_URL, STORE_NAME, STORE_TOWN, STORE_APP_URL,
//        DRY_RUN ('false' to post; anything else is a dry run), CHROME_BIN, OUT_DIR
///////////////////////////////////////////////////////////

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { resolveTargetWeek, weekRange, todayUTC, dominantOnSaleDate } = require('./build-pull-feed.js');
const { fetchRawWeek, readConfig } = require('./preflight-week.js');

const TEMPLATE = path.join(__dirname, 'facebook-image.html');
const FONTS = path.join(__dirname, '..', 'fonts');
const IMAGE_W = 1080;
const IMAGE_H = 1350;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Pure ────────────────────────────────────────────────────────────────────

function weekMarker(start) { return `w=${start}`; }

// "2026-10-14" -> { day: 'Wednesday', date: 'Oct 14' }. Parsed as UTC so the
// runner's timezone can never move the day.
function describeDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return { day: DAYS[d.getUTCDay()], date: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` };
}

// RSS lastBuildDate (RFC 822) -> YYYY-MM-DD (UTC), or null.
function feedBuildDate(rssXml) {
  const m = /<lastBuildDate>([^<]+)<\/lastBuildDate>/.exec(rssXml || '');
  if (!m) return null;
  const d = new Date(m[1].trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function countItems(rssXml) { return ((rssXml || '').match(/<item>/g) || []).length; }

// null when the landing page shows this week, else why not.
function freshnessProblem(built, start, end) {
  if (!built) return 'the feed behind the news page has no readable lastBuildDate';
  if (built < start || built > end) {
    return `the news page shows the issue built ${built}, not this week (${start} to ${end}): ` +
      `the Tuesday newsletter build has not published this week, or the site's Worker is serving an old copy`;
  }
  return null;
}

function alreadyPosted(posts, start) {
  return (posts || []).some(p => (p.message || '').includes(weekMarker(start)));
}

function withParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// The post text (plan § 4.4, approved by Rick 2026-10-14). Never contains a quantity
// other than the week's title count.
function buildMessage({ onSale, count, store, landingUrl, appUrl, start }) {
  const { day, date } = describeDate(onSale);
  return [
    `New comics this ${day}, ${date}! ${count} new arrivals at ${store}.`,
    '',
    `See every new title: ${withParams(landingUrl, { ref: 'facebook', w: start })}`,
    '',
    `Reserve yours online: ${withParams(appUrl, { ref: 'facebook' })}`,
  ].join('\n');
}

// "TRANSFORMERS #37 CVR A JASON HOWARD" -> "TRANSFORMERS #37"; the full title stays
// in the alt text. Cover-credit suffixes are noise on a small caption.
function shortTitle(title) {
  const t = String(title || '').replace(/\s+(CVR|COVER)\b.*$/i, '').replace(/\s*\((CVR|COVER)[^)]*\).*$/i, '').trim();
  return t || String(title || '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(template, { day, date, itemCount, covers, shop, town, fontAnton, fontArchivo }) {
  if (!covers.length) throw new Error('renderHtml: no covers');
  const figures = covers.map(c =>
    `    <figure><img src="${c.dataUri}" alt="${escapeHtml(c.title)}"><figcaption>${escapeHtml(shortTitle(c.title))}</figcaption></figure>`
  ).join('\n');
  const html = template
    .split('{{FONT_ANTON}}').join(fontAnton)
    .split('{{FONT_ARCHIVO}}').join(fontArchivo)
    .split('{{COVER_COUNT}}').join(String(covers.length))
    .split('{{DAY}}').join(escapeHtml(day))
    .split('{{DATE}}').join(escapeHtml(date))
    .split('{{ITEM_COUNT}}').join(String(itemCount))
    .split('{{COVERS}}').join(figures)
    .split('{{SHOP_NAME}}').join(escapeHtml(shop))
    .split('{{SHOP_TOWN}}').join(escapeHtml(town));
  const left = html.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`renderHtml: placeholder ${left[0]} was not filled`);
  return html;
}

// PNG width/height from the IHDR chunk; null if not a PNG.
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function makeRedactor(secret) {
  return s => (secret ? String(s).split(secret).join('[redacted]') : String(s));
}

// ── Config ──────────────────────────────────────────────────────────────────

function readFbConfig(env) {
  const dryRun = env.DRY_RUN !== 'false';
  const cfg = {
    dryRun,
    pageId: env.FACEBOOK_PAGE_ID || '',
    token: env.FACEBOOK_PAGE_TOKEN || '',
    graph: `https://graph.facebook.com/${env.FACEBOOK_GRAPH_VERSION || 'v25.0'}`,
    landingUrl: env.LANDING_URL || 'https://rjbookstop.com/news/',
    feedCheckUrl: env.FEED_CHECK_URL || 'https://rss-feed.rjbookstop.com/rss.xml',
    store: env.STORE_NAME || "Ray & Judy's Book Stop",
    town: env.STORE_TOWN || 'Rockaway, NJ',
    appUrl: env.STORE_APP_URL || 'https://rjbookstop.pulllist.app/',
  };
  if (!dryRun && (!cfg.pageId || !cfg.token)) {
    throw new Error('FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN must be set to post (DRY_RUN=false)');
  }
  return cfg;
}

// ── I/O helpers (all take fetchImpl so tests never touch the network) ──────

async function getText(url, fetchImpl, what) {
  const res = await fetchImpl(url, { headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res.text();
}

async function fetchSpotlight({ supabaseUrl, anonKey, slug, start }, fetchImpl) {
  const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/get_pull_feed_spotlight`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ p_slug: slug, p_week_start: start }),
  });
  if (!res.ok) throw new Error(`get_pull_feed_spotlight failed: HTTP ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('get_pull_feed_spotlight returned something other than a list');
  return rows.filter(r => r && r.cover_url).slice(0, 3);
}

async function downloadCover(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`too small (${buf.length} bytes)`);
  if (buf.length > 15 * 1024 * 1024) throw new Error(`too large (${buf.length} bytes)`);
  return `data:${type};base64,${buf.toString('base64')}`;
}

async function graph(fetchImpl, cfg, method, pathAndQuery, body) {
  const res = await fetchImpl(`${cfg.graph}/${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}` },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !json || json.error) {
    const e = (json && json.error) || {};
    throw new Error(`Graph API ${method} ${pathAndQuery.split('?')[0]}: HTTP ${res.status} ` +
      `${e.code ? `code ${e.code} ` : ''}${e.message || 'no error message'}`);
  }
  return json;
}

function defaultChrome() {
  if (process.platform === 'win32') {
    const c = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
    return c.find(p => fs.existsSync(p)) || c[0];
  }
  return 'google-chrome';
}

// Real renderer: headless Chrome screenshots the filled HTML. Returns the PNG bytes.
function chromeRender(html, { chromeBin, workDir }) {
  const htmlPath = path.join(workDir, 'facebook-image.render.html');
  const pngPath = path.join(workDir, 'facebook-image.render.png');
  fs.writeFileSync(htmlPath, html);
  if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
  execFileSync(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${IMAGE_W},${IMAGE_H}`,
    '--virtual-time-budget=5000', `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ], { stdio: 'pipe', timeout: 60000 });
  return fs.readFileSync(pngPath);
}

// ── The run ─────────────────────────────────────────────────────────────────

async function run({
  argv = [], env = process.env, fetchImpl = fetch, now = new Date(),
  render = chromeRender, log = console.log, error = console.error,
  outDir = env.OUT_DIR || path.join(os.tmpdir(), 'post-facebook'),
  summary = env.GITHUB_STEP_SUMMARY ? s => fs.appendFileSync(env.GITHUB_STEP_SUMMARY, s + '\n') : () => {},
} = {}) {
  const redact = makeRedactor(env.FACEBOOK_PAGE_TOKEN);
  const say = m => log(redact(m));
  const fail = m => {
    error(redact(`::error title=Facebook post FAILED::${m}`));
    error(redact(`FAILED: ${m}`));
    summary(redact(`**Facebook post FAILED:** ${m}`));
    return 1;
  };
  try {
    // 1. week
    const weekArg = (argv.find(a => a.startsWith('--week=')) || '').replace('--week=', '') || env.WEEK || null;
    const today = todayUTC(now);
    const { refDate } = resolveTargetWeek({ weekArg, today });
    const { start, end } = weekRange(refDate);
    const db = readConfig(env);
    const fb = readFbConfig(env);
    say(`Facebook post: week ${start} -> ${end}${fb.dryRun ? ' (DRY RUN: nothing will be posted)' : ''}`);

    // 2. rows
    const rawRows = await fetchRawWeek({ ...db, start }, fetchImpl);
    if (!rawRows.length) return fail(`no shipment rows for ${start} -> ${end}: the weekly shipment import has not run`);
    const onSale = dominantOnSaleDate(rawRows) || start;

    // 3 + 4. the landing page's feed
    const rss = await getText(fb.feedCheckUrl, fetchImpl, 'the news page feed (FEED_CHECK_URL)');
    const stale = freshnessProblem(feedBuildDate(rss), start, end);
    if (stale) return fail(stale);
    const count = countItems(rss);
    if (!count) return fail('the news page feed has no items');
    if (count !== rawRows.length) say(`::warning::the feed lists ${count} titles, the shipment has ${rawRows.length} rows (a difference is normal when rows share a cover)`);
    const message = buildMessage({ onSale, count, store: fb.store, landingUrl: fb.landingUrl, appUrl: fb.appUrl, start });

    // 5. already posted?
    if (fb.token && fb.pageId) {
      const since = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
      const posts = await graph(fetchImpl, fb, 'GET', `${fb.pageId}/posts?fields=id,message,created_time&limit=25&since=${since}`);
      if (alreadyPosted(posts.data, start)) {
        say(`Already posted for the week of ${start}; nothing to do.`);
        summary(`Facebook: already posted for the week of ${start}. Nothing posted.`);
        return 0;
      }
    } else {
      say('No Page id or token: skipping the already-posted check (dry run only).');
    }

    // 6. picture
    const picks = await fetchSpotlight({ ...db, start }, fetchImpl);
    const covers = [];
    for (const p of picks) {
      try { covers.push({ title: p.title, dataUri: await downloadCover(p.cover_url, fetchImpl) }); }
      catch (e) { say(`::warning::cover dropped (${p.title}): ${e.message}`); }
    }
    if (!covers.length) return fail('no spotlight cover could be downloaded');
    const font = f => `data:font/woff2;base64,${fs.readFileSync(path.join(FONTS, f)).toString('base64')}`;
    const { day, date } = describeDate(onSale);
    const html = renderHtml(fs.readFileSync(TEMPLATE, 'utf8'), {
      day, date, itemCount: count, covers, shop: fb.store, town: fb.town,
      fontAnton: font('anton-latin.woff2'), fontArchivo: font('archivo-latin-variable.woff2'),
    });
    fs.mkdirSync(outDir, { recursive: true });
    const png = render(html, { chromeBin: env.CHROME_BIN || defaultChrome(), workDir: outDir });
    const size = pngSize(png);
    if (!size || size.width !== IMAGE_W || size.height !== IMAGE_H) {
      return fail(`the picture is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, expected ${IMAGE_W}x${IMAGE_H}`);
    }
    if (png.length < 50 * 1024) return fail(`the picture is only ${png.length} bytes: it is probably blank`);
    const imagePath = path.join(outDir, `fb-${start}.png`);
    fs.writeFileSync(imagePath, png);
    say(`Spotlight: ${covers.map(c => c.title).join(' | ')}`);
    say(`Picture: ${imagePath} (${IMAGE_W}x${IMAGE_H}, ${Math.round(png.length / 1024)} KB)`);
    say(`Message:\n${message}`);

    if (fb.dryRun) {
      summary(`Facebook DRY RUN for the week of ${start}: ${count} titles, spotlight ${covers.map(c => c.title).join(' / ')}. Nothing posted; the picture is attached to this run.`);
      say('DRY RUN: nothing posted.');
      return 0;
    }

    // 7. post, then read it back
    const form = new FormData();
    form.append('message', message);
    form.append('published', 'true');
    form.append('source', new Blob([png], { type: 'image/png' }), `fb-${start}.png`);
    const created = await graph(fetchImpl, fb, 'POST', `${fb.pageId}/photos`, form);
    const postId = created.post_id || created.id;
    if (!postId) return fail('Facebook accepted the photo but returned no post id');
    const back = await graph(fetchImpl, fb, 'GET', `${postId}?fields=id,permalink_url,created_time`);
    if (!back.permalink_url) return fail(`post ${postId} was created but could not be read back with a permalink`);
    say(`Posted: ${back.permalink_url}`);
    summary(`Facebook: posted for the week of ${start} - ${back.permalink_url}`);
    return 0;
  } catch (err) {
    return fail(err.message);
  }
}

module.exports = {
  weekMarker, describeDate, feedBuildDate, countItems, freshnessProblem, alreadyPosted,
  buildMessage, shortTitle, escapeHtml, renderHtml, pngSize, makeRedactor, readFbConfig,
  fetchSpotlight, downloadCover, run, IMAGE_W, IMAGE_H,
};

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).then(code => process.exit(code));
}
