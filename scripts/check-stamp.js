#!/usr/bin/env node
/**
 * check-stamp.js — F135 gate: the email about to be sent was built TODAY.
 *
 * With build and send adjacent, send-brevo-campaign.js's stale guard (a 6-day
 * budget) is near-vacuous: a fresh build always passes it, and so does a
 * week-old build. It stays, because it still protects a manual send-only run,
 * but it is no longer the safety net. This is: after the build step, the
 * committed newsletter-email.html must carry TODAY's stamp (UTC, the same clock
 * build-pull-feed.js stamps with), or something other than this run's build is
 * about to be mailed - exactly how a stale issue goes out.
 *
 * Usage:  node scripts/check-stamp.js [path-to-email-html]
 */

const fs = require('fs');

function readStamp(html) {
  const m = html.match(/pull-feed-generated:\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Returns null when the stamp is today's, else the reason it is not.
function checkStamp(html, today) {
  const stamp = readStamp(html);
  if (!stamp) return 'no pull-feed-generated stamp found - not a build of this pipeline';
  if (stamp !== today) return `the stamp is ${stamp}, not today (${today}) - this is not the build from this run`;
  return null;
}

module.exports = { readStamp, checkStamp };

if (require.main === module) {
  const file = process.argv[2] || 'newsletter-email.html';
  const today = new Date().toISOString().slice(0, 10);
  const problem = checkStamp(fs.readFileSync(file, 'utf8'), today);
  if (problem) {
    console.error(`ERROR: ${file}: ${problem}. Refusing to send.`);
    process.exit(1);
  }
  console.log(`${file} is stamped ${today} - built by this run.`);
}
