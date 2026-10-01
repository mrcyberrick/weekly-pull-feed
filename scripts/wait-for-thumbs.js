#!/usr/bin/env node
/**
 * wait-for-thumbs.js — F135 gate: what the email references must be SERVED.
 *
 * build-pull-feed.js's own verifyPublishedTree() proves the commit's TREE holds
 * every referenced file. It does NOT prove GitHub Pages has served it, and that
 * gap is exactly F98 / F100: a newsletter went out while its last ten images
 * 404'd. This script closes it. After the publish (and the Pages build), it
 * reads the email the send step is about to mail and polls every image it
 * references on this site until all return HTTP 200, or fails.
 *
 * Fail-closed: a timeout is a non-zero exit, so the send job (which needs this
 * one to pass) never runs and GitHub emails the failure.
 *
 * Usage:  node scripts/wait-for-thumbs.js [path-to-email-html]
 * Env:    THUMB_WAIT_MINUTES   how long to keep polling (default 10)
 */

const fs = require('fs');

const SITE = 'https://mrcyberrick.github.io/weekly-pull-feed/';

// Only the assets this repo serves for the email: thumbnails and the two images.
function extractAssetUrls(html) {
  const found = html.match(/https:\/\/mrcyberrick\.github\.io\/weekly-pull-feed\/(?:thumbs|images)\/[^\s"'<>)]+/g) || [];
  return [...new Set(found)];
}

async function statusOf(url, fetchImpl) {
  try {
    // The host 301s to the custom domain (F98); follow it, as a mail client does.
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    return res.status;
  } catch {
    return 0;
  }
}

async function waitForUrls(urls, {
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 20 * 1000,
  concurrency = 8,
  log = console.log,
  fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let pending = [...urls];
  for (let round = 1; ; round++) {
    const failed = [];
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const url = pending[next++];
        const status = await statusOf(url, fetchImpl);
        if (status !== 200) failed.push({ url, status });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    log(`round ${round}: ${urls.length - failed.length}/${urls.length} served`);
    if (!failed.length) return { ok: true, failed: [] };
    if (Date.now() + intervalMs > deadline) return { ok: false, failed };
    pending = failed.map(f => f.url);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

module.exports = { extractAssetUrls, waitForUrls, SITE };

if (require.main === module) {
  const file = process.argv[2] || 'newsletter-email.html';
  const minutes = Number(process.env.THUMB_WAIT_MINUTES || '10');
  const html = fs.readFileSync(file, 'utf8');
  const urls = extractAssetUrls(html);
  if (!urls.length) {
    console.error(`ERROR: ${file} references no images on ${SITE} - the template is broken. Refusing to send.`);
    process.exit(1);
  }
  console.log(`Waiting up to ${minutes} min for ${urls.length} image(s) referenced by ${file} to be served...`);
  waitForUrls(urls, { timeoutMs: minutes * 60 * 1000 }).then(({ ok, failed }) => {
    if (ok) {
      console.log(`All ${urls.length} image(s) served (HTTP 200).`);
      return;
    }
    console.error(`ERROR: ${failed.length} of ${urls.length} image(s) are NOT being served after ${minutes} min:`);
    for (const f of failed.slice(0, 10)) console.error(`  ${f.status || 'no response'}  ${f.url}`);
    if (failed.length > 10) console.error(`  ... and ${failed.length - 10} more`);
    console.error('Refusing to send: this is the F98 failure (an email with broken images).');
    process.exit(1);
  });
}
