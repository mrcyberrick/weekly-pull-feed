// Regression suite for planPurge() — the thumbnail retention window.
//
// Why this file exists: the newsletter is an EMAIL, and its <img> tags point
// at thumbnails hosted in the weekly-pull-feed repo. The original purge
// deleted every thumbnail the CURRENT week did not reference, on the very next
// publish. So the moment a new issue went out, the previous issue turned into
// a grid of broken images in every inbox that still had it — the live feed was
// correct while already-delivered mail rotted behind it.
//
// Thumbnails are content-addressed (`thumbs/<md5>.webp`) and carry no date, so
// retention needs an explicit last-seen ledger committed beside them. These
// tests assert the ageing rule against that ledger.
//
// The delete decision is pure precisely so it can be checked here. Previously
// it was only observable by running a real publish against production and
// reading the commit message afterwards, which is why "-50 orphan(s)" scrolled
// past unremarked for a long time.
//
// Credential-free by construction: build-pull-feed.js reads its environment
// lazily (F135), so requiring it needs no env at all. No network call is ever
// made — planPurge takes a state snapshot as a plain argument.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planPurge, md5, daysBetween, THUMB_RETENTION_DAYS } = require('../scripts/build-pull-feed.js');

const TODAY = '2026-08-12';

// A feed row is [imageUrl, title] — planPurge only reads row[0].
const row = url => [url, 'SOME COMIC #1'];
const thumbPath = url => `thumbs/${md5(url)}.webp`;

// Build a published-tree snapshot: which thumbs exist, and when each was last
// referenced. `state.thumbs` is md5 -> tree path, mirroring readPublishState().
function state(published, retention = {}) {
  const thumbs = new Map();
  for (const url of published) thumbs.set(md5(url), thumbPath(url));
  const ledger = {};
  for (const [url, date] of Object.entries(retention)) ledger[md5(url)] = date;
  return { thumbs, retention: ledger };
}

const THIS_WEEK = 'https://media.lunardistribution.com/images/covers/large/AAA111.jpg';
const LAST_WEEK = 'https://media.lunardistribution.com/images/covers/large/BBB222.jpg';
const OLD       = 'https://media.lunardistribution.com/images/covers/large/CCC333.jpg';

test('the reported bug: last week\'s thumbnail is NOT deleted by this week\'s publish', () => {
  const res = planPurge(
    [row(THIS_WEEK)],
    state([THIS_WEEK, LAST_WEEK], { [LAST_WEEK]: '2026-08-05' }), // 7 days ago
    TODAY
  );
  assert.deepEqual(res.orphans, [], 'last week\'s thumb must survive — its email is still in inboxes');
  assert.deepEqual(res.retained, [thumbPath(LAST_WEEK)]);
});

test('a thumbnail past the window is deleted', () => {
  const res = planPurge(
    [row(THIS_WEEK)],
    state([THIS_WEEK, OLD], { [OLD]: '2026-07-01' }), // 42 days ago
    TODAY
  );
  assert.deepEqual(res.orphans, [thumbPath(OLD)]);
  assert.deepEqual(res.retained, []);
});

test('the window boundary: kept at exactly 14 days, dropped at 15', () => {
  assert.equal(THUMB_RETENTION_DAYS, 14);

  const at14 = planPurge([row(THIS_WEEK)],
    state([THIS_WEEK, LAST_WEEK], { [LAST_WEEK]: '2026-07-29' }), TODAY);
  assert.equal(daysBetween('2026-07-29', TODAY), 14);
  assert.deepEqual(at14.orphans, [], '14 days is inside the window');

  const at15 = planPurge([row(THIS_WEEK)],
    state([THIS_WEEK, LAST_WEEK], { [LAST_WEEK]: '2026-07-28' }), TODAY);
  assert.equal(daysBetween('2026-07-28', TODAY), 15);
  assert.deepEqual(at15.orphans, [thumbPath(LAST_WEEK)], '15 days is outside it');
});

test('a retained thumbnail keeps its ORIGINAL last-seen date and ages out on schedule', () => {
  // If retention refreshed the date each week, an unreferenced thumb would be
  // immortal and the repo would grow without bound.
  const res = planPurge([row(THIS_WEEK)],
    state([THIS_WEEK, LAST_WEEK], { [LAST_WEEK]: '2026-08-05' }), TODAY);
  assert.equal(res.manifest[md5(LAST_WEEK)], '2026-08-05', 'must not be refreshed to today');
});

test('everything the current week references is stamped today, cached or new', () => {
  const res = planPurge(
    [row(THIS_WEEK), row(LAST_WEEK)],
    state([THIS_WEEK], { [THIS_WEEK]: '2026-01-01' }), // stale date, still active
    TODAY
  );
  assert.equal(res.manifest[md5(THIS_WEEK)], TODAY, 'an active thumb is always seen today');
  assert.equal(res.manifest[md5(LAST_WEEK)], TODAY, 'a newly staged thumb is recorded too');
  assert.deepEqual(res.orphans, []);
});

test('an active thumbnail is never purged however old its ledger entry', () => {
  const res = planPurge([row(OLD)], state([OLD], { [OLD]: '2020-01-01' }), TODAY);
  assert.deepEqual(res.orphans, [], 'the current feed must never break');
});

test('an undated thumbnail gets grace, not deletion', () => {
  // Thumbs published before the ledger existed have no entry. Deleting what we
  // cannot date is the one failure this design must not have.
  const res = planPurge([row(THIS_WEEK)], state([THIS_WEEK, LAST_WEEK], {}), TODAY);
  assert.deepEqual(res.orphans, [], 'unknown age must mean keep');
  assert.equal(res.manifest[md5(LAST_WEEK)], TODAY, 'its clock starts now');
});

test('an empty ledger (unreadable file) purges nothing at all', () => {
  // readPublishState() falls back to {} when the ledger is missing or corrupt.
  // That must not be a mass-delete.
  const res = planPurge(
    [row(THIS_WEEK)],
    { thumbs: state([THIS_WEEK, LAST_WEEK, OLD]).thumbs, retention: {} },
    TODAY
  );
  assert.deepEqual(res.orphans, []);
  assert.equal(res.retained.length, 2);
});

test('purged thumbnails are dropped from the ledger, so it cannot grow forever', () => {
  const res = planPurge([row(THIS_WEEK)],
    state([THIS_WEEK, OLD], { [OLD]: '2026-06-01' }), TODAY);
  assert.deepEqual(res.orphans, [thumbPath(OLD)]);
  assert.equal(md5(OLD) in res.manifest, false, 'a deleted file must not keep a ledger entry');
  assert.deepEqual(Object.keys(res.manifest), [md5(THIS_WEEK)]);
});

test('rows with no image are ignored rather than hashed as empty', () => {
  const res = planPurge(
    [row(THIS_WEEK), ['', 'NO COVER'], [null, 'ALSO NONE']],
    state([THIS_WEEK]),
    TODAY
  );
  assert.deepEqual(res.orphans, []);
  assert.deepEqual(Object.keys(res.manifest), [md5(THIS_WEEK)]);
});

test('the retired purge-everything rule would delete last week — proving the fix bites', () => {
  const s = state([THIS_WEEK, LAST_WEEK], { [LAST_WEEK]: '2026-08-05' });
  const active = new Set([row(THIS_WEEK)].map(r => md5(r[0])));
  const oldRule = [...s.thumbs].filter(([h]) => !active.has(h)).map(([, p]) => p);
  assert.deepEqual(oldRule, [thumbPath(LAST_WEEK)], 'the old rule deleted it');
  assert.deepEqual(planPurge([row(THIS_WEEK)], s, TODAY).orphans, [], 'the new rule keeps it');
});

test('daysBetween is DST-safe across a spring-forward boundary', () => {
  // US DST began 2026-03-08. A midnight-anchored diff can round to 13 or 15.
  assert.equal(daysBetween('2026-03-01', '2026-03-15'), 14);
});
