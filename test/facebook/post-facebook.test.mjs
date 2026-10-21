// Unit tests for scripts/post-facebook.js. Run: node --test test/facebook/
// Deliberately OUTSIDE test/*.test.mjs, so the newsletter's build job (which runs that
// glob before every Tuesday send) never depends on Facebook code.
// No network, no Chrome, no clock: every I/O is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fb = require('../../scripts/post-facebook.js');

const NOW = new Date('2026-10-14T12:00:00Z');        // a Wednesday
const START = '2026-10-12', END = '2026-10-18';
const TOKEN = 'EAAtest-SECRET-token-123';
const BASE_ENV = {
  SUPABASE_URL: 'https://plgegklqtdjxeglvyjte.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test',
  TENANT_SLUG: 'rjbookstop',
};

function fakePng(width = 1080, height = 1350, bytes = 80 * 1024) {
  const b = Buffer.alloc(bytes);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

// The feed as weekly-pull-feed builds it since a74692a8: each item dated the week's
// on-sale day at noon Eastern (16:00 GMT in EDT). itemDate null = items with no date.
function rss(buildDate, items = 3, itemDate = 'Wed, 14 Oct 2026 16:00:00 GMT') {
  const item = itemDate ? `<item><title>x</title><pubDate>${itemDate}</pubDate></item>` : '<item><title>x</title></item>';
  return `<rss><channel><pubDate>${buildDate}</pubDate><lastBuildDate>${buildDate}</lastBuildDate>${item.repeat(items)}</channel></rss>`;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A scriptable fake of every endpoint the job touches. Records each call.
function world(over = {}) {
  const calls = [];
  const s = {
    rows: [{ title: 'A', cover_url: 'u', series_name: 'A', on_sale_date: '2026-10-14' },
           { title: 'B', cover_url: 'u', series_name: 'B', on_sale_date: '2026-10-14' },
           { title: 'C', cover_url: 'u', series_name: 'C', on_sale_date: '2026-10-14' }],
    feed: rss('Wed, 14 Oct 2026 00:08:16 GMT'),
    feedStatus: 200,
    spotlight: [{ title: 'AMAZING SPIDER-MAN #1001', cover_url: 'https://img/1', series_name: 'ASM' },
                { title: 'TRANSFORMERS #37 CVR A', cover_url: 'https://img/2', series_name: 'TF' },
                { title: 'VENOM #1', cover_url: 'https://img/3', series_name: 'Venom' }],
    badCovers: new Set(),
    photoResponse: { id: 'photo1', post_id: 'page_123' },
    readBack: { id: 'page_123', permalink_url: 'https://facebook.com/page/posts/123' },
    readBackError: null,
    graphError: null,
    ...over,
  };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ method, url: u, auth: opts.headers && opts.headers.Authorization, body: opts.body });
    if (u.endsWith('/rpc/get_pull_feed_week')) return json(s.rows);
    if (u.endsWith('/rpc/get_pull_feed_spotlight')) return json(s.spotlight);
    if (u.startsWith('https://rss-feed.')) return new Response(s.feed, { status: s.feedStatus });
    if (u.startsWith('https://img/')) {
      if (s.badCovers.has(u)) return new Response('nope', { status: 404 });
      return new Response(Buffer.alloc(5000, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.startsWith('https://graph.facebook.com/')) {
      if (s.graphError) return json({ error: s.graphError }, 400);
      // Facebook refuses this app a read of the Page's posts (measured 2026-10-21),
      // so the fake refuses it too: a job that relied on it would fail here.
      if (method === 'GET' && /\/(posts|feed)\?/.test(u)) {
        return json({ error: { code: 100, error_subcode: 33, message: 'Unsupported get request.' } }, 400);
      }
      if (method === 'POST' && u.includes('/photos')) return json(s.photoResponse);
      if (method === 'GET') return s.readBackError ? json({ error: s.readBackError }, 400) : json(s.readBack);
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  return { s, calls, fetchImpl };
}

async function go(w, envOver = {}, renderImpl) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fbtest-'));
  const logs = [];
  const rendered = [];
  const code = await fb.run({
    env: { ...BASE_ENV, FEED_CHECK_URL: 'https://rss-feed.example/rss.xml', ...envOver },
    fetchImpl: w.fetchImpl,
    now: NOW,
    outDir: out,
    render: renderImpl || ((html) => { rendered.push(html); return fakePng(); }),
    log: m => logs.push(String(m)),
    error: m => logs.push(String(m)),
    summary: m => logs.push(String(m)),
  });
  return { code, logs: logs.join('\n'), rendered, out };
}

const POSTING = { DRY_RUN: 'false', FACEBOOK_PAGE_ID: '615', FACEBOOK_PAGE_TOKEN: TOKEN };
const photoPosts = calls => calls.filter(c => c.method === 'POST' && c.url.includes('/photos'));

// ── the run ──────────────────────────────────────────────────────────────

test('dry run with no token: renders, posts nothing, never calls Facebook', async () => {
  const w = world();
  const r = await go(w);
  assert.equal(r.code, 0);
  assert.equal(w.calls.filter(c => c.url.includes('graph.facebook.com')).length, 0);
  assert.equal(r.rendered.length, 1);
  assert.ok(fs.existsSync(path.join(r.out, `fb-${START}.png`)), 'the picture is saved for the run artifact');
  assert.match(r.logs, /DRY RUN: nothing posted/);
});

test('dry run is the default: DRY_RUN unset with a token still posts nothing', async () => {
  const w = world();
  const r = await go(w, { FACEBOOK_PAGE_ID: '615', FACEBOOK_PAGE_TOKEN: TOKEN });
  assert.equal(r.code, 0);
  assert.equal(photoPosts(w.calls).length, 0);
});

test('no shipment rows: fails, and nothing is rendered or posted', async () => {
  const w = world({ rows: [] });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /shipment import has not run/);
  assert.equal(r.rendered.length, 0);
  assert.equal(photoPosts(w.calls).length, 0);
});

test('news page still shows LAST week: fails before any Facebook call', async () => {
  const w = world({ feed: rss('Wed, 07 Oct 2026 00:20:00 GMT') });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /not this week/);
  assert.equal(w.calls.filter(c => c.url.includes('graph.facebook.com')).length, 0);
});

test('news page feed unreachable: fails', async () => {
  const w = world({ feedStatus: 502 });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /HTTP 502/);
});

test('already posted this week (cache hit): exit 0, no second post, no picture', async () => {
  const w = world();
  const r = await go(w, { ...POSTING, ALREADY_POSTED: 'true' });
  assert.equal(r.code, 0);
  assert.equal(photoPosts(w.calls).length, 0);
  assert.equal(r.rendered.length, 0);
  assert.match(r.logs, /Already posted/);
});

test('no cache hit: it posts, and never tries to read the Page\'s posts or feed', async () => {
  const w = world();
  const r = await go(w, { ...POSTING, ALREADY_POSTED: 'false' });
  assert.equal(r.code, 0);
  assert.equal(photoPosts(w.calls).length, 1);
  assert.equal(w.calls.filter(c => /\/(posts|feed)\?/.test(c.url)).length, 0);
});

test('a post is recorded for the cache the moment Facebook returns its id', async () => {
  const w = world();
  const r = await go(w, POSTING);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(r.out, `posted-${START}.txt`), 'utf8').trim(), 'page_123');
});

test('read-back refused: fails red, but the post is still recorded so a rerun cannot post twice', async () => {
  const w = world({ readBackError: { code: 100, error_subcode: 33, message: 'Unsupported get request.' } });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /posted as page_123, but it could not be read back/);
  assert.ok(fs.existsSync(path.join(r.out, `posted-${START}.txt`)), 'no record: a rerun would post again');
});

test('a dry run never writes a posted record', async () => {
  const w = world();
  const r = await go(w, { FACEBOOK_PAGE_ID: '615', FACEBOOK_PAGE_TOKEN: TOKEN });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(r.out, `posted-${START}.txt`)));
});

test('posting: exactly one photo upload with the token in the header, then a read-back', async () => {
  const w = world();
  const r = await go(w, POSTING);
  assert.equal(r.code, 0);
  const posts = photoPosts(w.calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, `Bearer ${TOKEN}`);
  assert.ok(!posts[0].url.includes(TOKEN), 'the token is never in a URL');
  const msg = posts[0].body.get('message');
  assert.match(msg, new RegExp(`w=${START}`));
  assert.match(msg, /ref=facebook/);
  assert.ok(posts[0].body.get('source'), 'the picture is uploaded as a file');
  assert.ok(w.calls.some(c => c.method === 'GET' && c.url.includes('page_123?fields=')), 'the post is read back');
  assert.match(r.logs, /Posted: https:\/\/facebook\.com\/page\/posts\/123/);
});

test('accepted but cannot be read back: fails (F96: acceptance is not delivery)', async () => {
  const w = world({ readBack: { id: 'page_123' } });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /could not be read back/);
});

test('Graph error: fails, prints Meta\'s message, and the token never appears in output', async () => {
  const w = world({ graphError: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /code 190/);
  assert.ok(!r.logs.includes(TOKEN), 'token leaked into the log');
  assert.match(r.logs, /\[redacted\]/);
});

test('posting without a token is refused up front', async () => {
  const w = world();
  const r = await go(w, { DRY_RUN: 'false', FACEBOOK_PAGE_ID: '615' });
  assert.equal(r.code, 1);
  assert.match(r.logs, /FACEBOOK_PAGE_TOKEN must be set/);
  assert.equal(w.calls.length, 0);
});

test('one cover fails to download: the picture uses the other two', async () => {
  const w = world({ badCovers: new Set(['https://img/2']) });
  const r = await go(w, POSTING);
  assert.equal(r.code, 0);
  assert.match(r.rendered[0], /repeat\(2, /);
  assert.equal((r.rendered[0].match(/<figure>/g) || []).length, 2);
  assert.match(r.logs, /cover dropped \(TRANSFORMERS #37 CVR A\)/);
});

test('no cover can be downloaded: fails, nothing posted', async () => {
  const w = world({ badCovers: new Set(['https://img/1', 'https://img/2', 'https://img/3']) });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.equal(photoPosts(w.calls).length, 0);
});

test('a picture of the wrong size fails', async () => {
  const w = world();
  const r = await go(w, POSTING, () => fakePng(800, 600));
  assert.equal(r.code, 1);
  assert.match(r.logs, /800x600/);
  assert.equal(photoPosts(w.calls).length, 0);
});

test('a near-empty picture fails as probably blank', async () => {
  const w = world();
  const r = await go(w, POSTING, () => fakePng(1080, 1350, 4000));
  assert.equal(r.code, 1);
  assert.match(r.logs, /probably blank/);
});

test('the picture keeps the lookup\'s title order and never states a rank', async () => {
  const w = world();
  const r = await go(w);
  const html = r.rendered[0];
  const order = ['AMAZING SPIDER-MAN #1001', 'TRANSFORMERS #37', 'VENOM #1'].map(t => html.indexOf(`<figcaption>${t}</figcaption>`));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], 'covers out of order');
  // what a viewer can read: no comments, no CSS (it embeds the fonts), no tags or attributes
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visible, /#1 pick|top pick|most ordered|best[- ]?sell|rank/i);
  assert.match(visible, /In the spotlight/);
});

// ── pure helpers ─────────────────────────────────────────────────────────

test('a PAST week re-published this week: built today, but its titles are last week\'s -> red, nothing posted', async () => {
  const w = world({ feed: rss('Wed, 14 Oct 2026 00:08:16 GMT', 3, 'Wed, 07 Oct 2026 16:00:00 GMT') });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /lists the titles for 2026-10-07, not this week/);
  assert.equal(w.calls.filter(c => c.url.includes('graph.facebook.com')).length, 0);
  assert.equal(r.rendered.length, 0);
});

test('feed items with no dates: red, nothing posted', async () => {
  const w = world({ feed: rss('Wed, 14 Oct 2026 00:08:16 GMT', 3, null) });
  const r = await go(w, POSTING);
  assert.equal(r.code, 1);
  assert.match(r.logs, /items carry no readable dates/);
});

test('an older-format feed (items dated with the build time) still passes', async () => {
  const w = world({ feed: rss('Tue, 13 Oct 2026 23:40:35 GMT', 3, 'Tue, 13 Oct 2026 23:40:35 GMT') });
  const r = await go(w, POSTING);
  assert.equal(r.code, 0);
  assert.equal(photoPosts(w.calls).length, 1);
});

test('feedItemsDate: the most common item date wins, ties to the later one', () => {
  const feed = items => `<rss>${items.map(d => `<item><pubDate>${d}</pubDate></item>`).join('')}</rss>`;
  assert.equal(fb.feedItemsDate(feed(['Wed, 14 Oct 2026 16:00:00 GMT', 'Wed, 14 Oct 2026 16:00:00 GMT', 'Wed, 07 Oct 2026 16:00:00 GMT'])), '2026-10-14');
  assert.equal(fb.feedItemsDate(feed(['Wed, 07 Oct 2026 16:00:00 GMT', 'Wed, 14 Oct 2026 16:00:00 GMT'])), '2026-10-14');
  assert.equal(fb.feedItemsDate('<rss><channel><pubDate>Wed, 14 Oct 2026 16:00:00 GMT</pubDate></channel></rss>'), null, 'a CHANNEL date is not an item date');
  assert.equal(fb.itemsWeekProblem('2026-10-18', START, END), null);
  assert.match(fb.itemsWeekProblem('2026-10-19', START, END), /not this week/);
});

test('freshness: inside the week passes, the day before and the day after fail', () => {
  assert.equal(fb.freshnessProblem(START, START, END), null);
  assert.equal(fb.freshnessProblem(END, START, END), null);
  assert.match(fb.freshnessProblem('2026-10-11', START, END), /not this week/);
  assert.match(fb.freshnessProblem('2026-10-19', START, END), /not this week/);
  assert.match(fb.freshnessProblem(null, START, END), /no readable lastBuildDate/);
});

test('feedBuildDate reads RFC 822 as a UTC date', () => {
  assert.equal(fb.feedBuildDate(rss('Wed, 14 Oct 2026 00:08:16 GMT')), '2026-10-14');
  assert.equal(fb.feedBuildDate('<rss></rss>'), null);
  assert.equal(fb.feedBuildDate(rss('not a date')), null);
});

test('message: day and date from the on-sale date, both links tagged, no quantities', () => {
  const m = fb.buildMessage({ onSale: '2026-10-14', count: 119, store: "Ray & Judy's Book Stop",
    landingUrl: 'https://rjbookstop.com/news/', appUrl: 'https://rjbookstop.pulllist.app/', start: START });
  assert.equal(m, [
    "New comics this Wednesday, Oct 14! 119 new arrivals at Ray & Judy's Book Stop.",
    '',
    'See every new title: https://rjbookstop.com/news/?ref=facebook&w=2026-10-12',
    '',
    'Reserve yours online: https://rjbookstop.pulllist.app/?ref=facebook',
  ].join('\n'));
});

test('shortTitle drops cover credits but never empties a title', () => {
  assert.equal(fb.shortTitle('TRANSFORMERS #37 CVR A JASON HOWARD'), 'TRANSFORMERS #37');
  assert.equal(fb.shortTitle('Star-Crossed #3 (CVR A) (Stuart Immonen)'), 'Star-Crossed #3');
  assert.equal(fb.shortTitle('Teenage Mutant Ninja Turtles #23 Cover A (Pe)'), 'Teenage Mutant Ninja Turtles #23');
  assert.equal(fb.shortTitle('VENOM #1'), 'VENOM #1');
});

test('fullSizeCover asks PRH for the full-size image and leaves everything else alone', () => {
  assert.equal(fb.fullSizeCover('https://images.penguinrandomhouse.com/cover/75960623001300111'),
    'https://images.penguinrandomhouse.com/cover/d/75960623001300111');
  assert.equal(fb.fullSizeCover('https://images.penguinrandomhouse.com/cover/d/75960623001300111'),
    'https://images.penguinrandomhouse.com/cover/d/75960623001300111');
  assert.equal(fb.fullSizeCover('https://media.lunardistribution.com/images/covers/large/0826IM0514.jpg'),
    'https://media.lunardistribution.com/images/covers/large/0826IM0514.jpg');
});

test('the run downloads PRH covers at full size', async () => {
  const w = world({ spotlight: [{ title: 'DNX #3', cover_url: 'https://images.penguinrandomhouse.com/cover/123', series_name: 'DNX' }] });
  const inner = w.fetchImpl;
  w.fetchImpl = async (u, o) => String(u).startsWith('https://images.penguinrandomhouse.com/')
    ? (w.calls.push({ method: 'GET', url: String(u) }), new Response(Buffer.alloc(5000, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    : inner(u, o);
  const r = await go(w);
  assert.equal(r.code, 0);
  assert.ok(w.calls.some(c => c.url === 'https://images.penguinrandomhouse.com/cover/d/123'));
  assert.ok(!w.calls.some(c => c.url === 'https://images.penguinrandomhouse.com/cover/123'));
});

test('renderHtml escapes titles and refuses a template with an unfilled placeholder', () => {
  const tpl = '{{FONT_ANTON}}{{FONT_ARCHIVO}}{{COVER_COUNT}}{{DAY}}{{DATE}}{{ITEM_COUNT}}{{COVERS}}{{SHOP_NAME}}{{SHOP_TOWN}}';
  const args = { day: 'Wednesday', date: 'Oct 14', itemCount: 3, shop: 'R & J', town: 'T',
    fontAnton: 'a', fontArchivo: 'b', covers: [{ title: '<script>x</script>', dataUri: 'data:x' }] };
  const html = fb.renderHtml(tpl, args);
  assert.ok(!html.includes('<script>x'), 'title not escaped');
  assert.match(html, /R &amp; J/);
  assert.throws(() => fb.renderHtml(tpl + '{{NEW_THING}}', args), /NEW_THING/);
  assert.throws(() => fb.renderHtml(tpl, { ...args, covers: [] }), /no covers/);
});

test('pngSize reads the IHDR and rejects a non-PNG', () => {
  assert.deepEqual(fb.pngSize(fakePng(1080, 1350)), { width: 1080, height: 1350 });
  assert.equal(fb.pngSize(Buffer.from('GIF89a................')), null);
});
