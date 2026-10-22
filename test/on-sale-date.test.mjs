// The in-store date shown beside "This Week's Releases" - web page, email and RSS
// (comic-preorder docs/newsletter-arrival-date.md, decisions D1-D5; wording changed
// 2026-10-21 by Rick: "In store Wednesday, ...", and no "on sale" anywhere a customer sees).
//
// What this file guards, in order of how badly it would hurt if it regressed:
//   1. The date never shifts by a day in any time zone (F28). The builder runs on
//      a UTC runner; a reader's machine, a developer's laptop and the shop are
//      not UTC. Every format test is therefore run in child processes under
//      several TZ settings, not just the one this test happens to run in.
//   2. The RSS item <pubDate> is on-sale NOON EASTERN, computed for that date's
//      own offset (EDT before 2026-11-01, EST after) - never a hardcoded -4.
//   3. A week with no date renders exactly as it did before (the fallbacks).
//
// Credential-free, like the other suites: build-pull-feed.js reads its
// environment lazily, so requiring it needs none.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BUILDER = fileURLToPath(new URL('../scripts/build-pull-feed.js', import.meta.url));
const {
  formatOnSale, formatOnSaleShort, onSaleNoonEasternRfc822,
  buildNewsletterHtml, buildEmailHtml, buildRssXml,
} = require('../scripts/build-pull-feed.js');
const { readStamp } = require('../scripts/check-stamp.js');

// ── the date helpers ────────────────────────────────────────────────────────

test('formatOnSale: weekday and month come from the date, not from a hardcoded Wednesday', () => {
  assert.equal(formatOnSale('2026-10-21'), 'Wednesday, October 21, 2026');
  assert.equal(formatOnSale('2026-10-22'), 'Thursday, October 22, 2026');   // a holiday-week shipment
  assert.equal(formatOnSale('2026-12-31'), 'Thursday, December 31, 2026');  // year edge
  assert.equal(formatOnSale('2027-01-01'), 'Friday, January 1, 2027');
});

test('formatOnSaleShort: the preheader / subject form', () => {
  assert.equal(formatOnSaleShort('2026-10-21'), 'Wed, Oct 21');
  assert.equal(formatOnSaleShort('2026-10-22'), 'Thu, Oct 22');
  assert.equal(formatOnSaleShort('2026-12-31'), 'Thu, Dec 31');
});

test('a missing or malformed date is null, never a throw and never "Invalid Date"', () => {
  for (const bad of [null, undefined, '', 'next wednesday', '2026-13-01', '2026-02-31', '2026-10-21T00:00:00Z', 20261021]) {
    assert.equal(formatOnSale(bad), null, `formatOnSale(${String(bad)})`);
    assert.equal(formatOnSaleShort(bad), null, `formatOnSaleShort(${String(bad)})`);
    assert.equal(onSaleNoonEasternRfc822(bad), null, `onSaleNoonEasternRfc822(${String(bad)})`);
  }
});

test('noon Eastern: 16:00 GMT while EDT, 17:00 GMT after the clocks go back (2026-11-01)', () => {
  assert.equal(onSaleNoonEasternRfc822('2026-10-21'), 'Wed, 21 Oct 2026 16:00:00 GMT');
  assert.equal(onSaleNoonEasternRfc822('2026-11-04'), 'Wed, 04 Nov 2026 17:00:00 GMT');
  // The transition days themselves: the switch is at 2 AM, so noon is already on the new offset.
  assert.equal(onSaleNoonEasternRfc822('2026-11-01'), 'Sun, 01 Nov 2026 17:00:00 GMT');
  assert.equal(onSaleNoonEasternRfc822('2026-03-08'), 'Sun, 08 Mar 2026 16:00:00 GMT');
  assert.equal(onSaleNoonEasternRfc822('2026-03-07'), 'Sat, 07 Mar 2026 17:00:00 GMT');
});

test('noon Eastern: read back in New York it is the same calendar date at 12:00', () => {
  const ny = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  for (const iso of ['2026-10-21', '2026-11-04', '2026-11-01', '2026-03-08', '2026-12-31', '2027-07-14']) {
    const p = Object.fromEntries(ny.formatToParts(new Date(onSaleNoonEasternRfc822(iso))).map(x => [x.type, x.value]));
    assert.equal(`${p.year}-${p.month}-${p.day}`, iso, `calendar date for ${iso}`);
    assert.equal(`${p.hour}:${p.minute}`, '12:00', `wall clock for ${iso}`);
  }
  assert.match(onSaleNoonEasternRfc822('2026-10-21'), /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/, 'RFC-822 shape');
});

// Run the helpers in a fresh process under each TZ. A naive new Date('2026-10-21')
// parses as UTC midnight and prints the previous day west of Greenwich; a helper
// that quietly depended on the process time zone would pass in-process and fail
// here. Pacific/Auckland covers the far-east side, Honolulu the far-west.
const ZONES = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Pacific/Honolulu', 'Pacific/Auckland'];
const CHILD = `
  const b = require(${JSON.stringify(BUILDER)});
  console.log(JSON.stringify({
    long: b.formatOnSale('2026-10-21'), short: b.formatOnSaleShort('2026-10-21'),
    yearEdge: b.formatOnSale('2026-12-31'), thursday: b.formatOnSale('2026-10-22'),
    noonEdt: b.onSaleNoonEasternRfc822('2026-10-21'), noonEst: b.onSaleNoonEasternRfc822('2026-11-04'),
  }));`;

for (const TZ of ZONES) {
  test(`no day shift and the same noon-Eastern instant under TZ=${TZ}`, () => {
    const r = spawnSync(process.execPath, ['-e', CHILD], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      long: 'Wednesday, October 21, 2026', short: 'Wed, Oct 21',
      yearEdge: 'Thursday, December 31, 2026', thursday: 'Thursday, October 22, 2026',
      noonEdt: 'Wed, 21 Oct 2026 16:00:00 GMT', noonEst: 'Wed, 04 Nov 2026 17:00:00 GMT',
    });
  });
}

// ── the three renderers ─────────────────────────────────────────────────────

// Rows are [coverUrl, title, seriesName|null] - see fetchWeekRows().
const ROWS = [
  ['https://img.example/a.jpg', 'BATMAN #14', 'Batman'],
  ['https://img.example/b.jpg', 'X-MEN #1', 'X-Men'],
  ['https://img.example/c.jpg', 'A ONE-SHOT', null],
];
const WITH = { onSaleDate: '2026-10-21', shipmentCount: 3 };
const WITHOUT = { shipmentCount: 3 };
const ON_SALE_LINE = 'In store Wednesday, October 21, 2026';

// The builders log progress; keep the test output readable.
function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}
const page  = meta => quiet(() => buildNewsletterHtml(ROWS, new Map(), meta));
const email = meta => quiet(() => buildEmailHtml(ROWS, new Map(), meta));
const rss   = (meta, rows = ROWS) => quiet(() => buildRssXml(rows, new Map(), meta));

for (const [name, build, label] of [
  ['web page', page, 'This Week&rsquo;s Releases'],
  ['email', email, 'This Week&rsquo;s Releases'],
]) {
  test(`${name}: the date line sits under "This Week's Releases" and above "One cover per series"`, () => {
    const html = build(WITH);
    const at = s => html.indexOf(s);
    assert.ok(at(label) > -1, 'section label present');
    assert.equal(html.split(ON_SALE_LINE).length - 1, 1, 'the date line appears exactly once');
    assert.ok(at(label) < at(ON_SALE_LINE), 'date line is after the label');
    assert.ok(at(ON_SALE_LINE) < at('One cover per series'), 'date line is before the count line');
  });

  test(`${name}: no date, no line - and the rest of the section is untouched`, () => {
    const html = build(WITHOUT);
    assert.ok(!html.includes('In store Wednesday'), 'no in-store date line without a date');
    assert.ok(html.includes('One cover per series'), 'count line still present');
    assert.ok(html.includes('3 titles arriving'), 'count still present');
  });
}

test('email: the preheader carries the date, and falls back to the old wording without one', () => {
  assert.ok(email(WITH).includes('3 new titles in store Wed, Oct 21 &mdash; stop in before your favorites are gone'));
  assert.ok(email(WITHOUT).includes('3 new titles in store Wednesday &mdash; stop in before your favorites are gone'));
});

test('email: pull-feed-onsale stamp is present with a date, absent without, and does not disturb the freshness stamp', () => {
  const dated = email(WITH);
  assert.equal(dated.split('<!-- pull-feed-onsale: 2026-10-21 -->').length - 1, 1);
  assert.ok(!email(WITHOUT).includes('pull-feed-onsale'), 'no stamp without a date');
  // check-stamp.js and send-brevo-campaign.js both key on pull-feed-generated: it
  // must still be found, still be today's date, and be the ONLY thing they match.
  assert.equal(readStamp(dated), new Date().toISOString().slice(0, 10));
  assert.equal((dated.match(/pull-feed-generated:/g) || []).length, 1);
});

test('email: the new date lines add under 1 KB (Gmail clips near 102 KB; the send script warns at 95 KB)', () => {
  const added = Buffer.byteLength(email(WITH)) - Buffer.byteLength(email(WITHOUT));
  assert.ok(added > 0 && added < 1024, `added ${added} bytes`);
});

// Rick's call: customers see "In store ...", never "on sale". Asserted across all three
// artifacts, with a date AND without one (the preheader's old fallback said "on sale
// Wednesday"). The machine-readable stamp is spelled "onsale" inside an HTML comment, so
// the pattern below does not match it, and a mail client does not display it.
for (const [name, build] of [['web page', page], ['email', email], ['rss', rss]]) {
  for (const [which, meta] of [['with a date', WITH], ['without a date', WITHOUT]]) {
    test(`${name} ${which}: the words "on sale" never appear`, () => {
      const hit = build(meta).match(/.{0,40}\bon[ -]sale\b.{0,40}/i);
      assert.equal(hit, null, hit && hit[0]);
    });
  }
}

// The date line is the point of this feature, so it has to be readable. It was first built
// in the same muted grey as the count line under it (#5a5755 on #222222, about 2.2:1, 10px)
// and was hard to see in the real render. Asserted from the markup itself, so a later style
// tweak that makes it faint again goes red. WCAG relative luminance; the band behind the
// line is #222222 in both the page and the email.
const luminance = hex => {
  const [r, g, b] = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const BAND = '#222222';
const colorOf = style => style.match(/color:(#[0-9a-fA-F]{6})/)[1];

for (const [name, build] of [['web page', page], ['email', email]]) {
  test(`${name}: the date line is readable (contrast 4.5:1 or better, 12px or larger) and stands out from the count line`, () => {
    const html = build(WITH);
    const dateStyle = html.match(/<div style="([^"]*)">\s*In store Wednesday/)[1];
    const countStyle = html.match(/<div style="([^"]*)">\s*One cover per series/)[1];
    const ratio = contrast(colorOf(dateStyle), BAND);
    assert.ok(ratio >= 4.5, `date line ${colorOf(dateStyle)} on ${BAND} is ${ratio.toFixed(2)}:1`);
    const px = Number(dateStyle.match(/font-size:(\d+)px/)[1]);
    assert.ok(px >= 12, `date line is ${px}px`);
    assert.notEqual(colorOf(dateStyle), colorOf(countStyle), 'the date should not share the count line\'s muted colour');
  });
}

// ── RSS ─────────────────────────────────────────────────────────────────────

const items = xml => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
const itemPubDates = xml => items(xml).map(i => i.match(/<pubDate>([^<]+)<\/pubDate>/)[1]);
const channelPart = xml => xml.slice(0, xml.indexOf('<item>'));
const channelTag = (xml, tag) => channelPart(xml).match(new RegExp(`<${tag}>([^<]+)</${tag}>`))[1];
// What a feed reader shows as the item's text: the <p>, entities decoded.
const itemText = item =>
  item.match(/<p>([\s\S]*?)<\/p>/)[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('rss: every item is dated the on-sale day at noon Eastern; the channel keeps the real build time', () => {
  const xml = rss(WITH);
  assert.equal(items(xml).length, ROWS.length);
  assert.deepEqual(itemPubDates(xml), ROWS.map(() => 'Wed, 21 Oct 2026 16:00:00 GMT'));
  const built = channelTag(xml, 'pubDate');
  assert.equal(channelTag(xml, 'lastBuildDate'), built, 'channel pubDate and lastBuildDate agree');
  assert.notEqual(built, 'Wed, 21 Oct 2026 16:00:00 GMT', 'the channel date is the build time, not the on-sale date');
  assert.ok(Math.abs(Date.now() - new Date(built).getTime()) < 60_000, 'and it is recent');
});

test('rss: the channel description says when the books land', () => {
  assert.match(channelTag(rss(WITH), 'description'),
    /^This week's releases, in store Wednesday, October 21, 2026\. /);
});

test('rss: item text carries the on-sale date, drops the untrue "now available / ready for pickup", and stays over 300 characters', () => {
  // Shortest realistic worst case: a one-character title and the shortest date string.
  const worst = rss({ onSaleDate: '2026-06-01' }, [['https://img.example/x.jpg', 'X', null]]);
  const longest = rss(WITH);
  for (const xml of [worst, longest]) {
    for (const item of items(xml)) {
      const text = itemText(item);
      assert.ok(/In store (Wednesday|Monday)/.test(text), text);
      assert.ok(!/now available|ready for pickup/i.test(text), text);
      assert.ok(text.length >= 300, `item text is ${text.length} chars: ${text}`);
    }
  }
  assert.ok(itemText(items(longest)[0]).includes('In store Wednesday, October 21, 2026'));
  // The shop name is written as an entity inside CDATA-wrapped HTML, like the title.
  assert.ok(items(longest)[0].includes("Ray &amp; Judy's Book Stop"));
});

test('rss: no date keeps today\'s feed exactly - item date = build time, old wording', () => {
  const xml = rss(WITHOUT);
  const built = channelTag(xml, 'pubDate');
  assert.deepEqual(itemPubDates(xml), ROWS.map(() => built));
  assert.equal(channelTag(xml, 'description'),
    'Weekly pull list of new releases with thumbnails and links to full-size cover images.');
  for (const item of items(xml)) {
    assert.ok(itemText(item).includes('is now available'), 'old wording kept when there is no date to put in it');
  }
  // And calling it the old way, with no third argument at all, is the same thing.
  const bare = rss(undefined);   // one build: two builds could straddle a second boundary
  assert.equal(itemPubDates(bare)[0], channelTag(bare, 'pubDate'));
});
