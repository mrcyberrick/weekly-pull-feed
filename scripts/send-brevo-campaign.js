/**
 * send-brevo-campaign.js
 * Creates a Brevo email campaign from a local HTML file and sends it.
 * Zero dependencies. Requires Node 18+ (native fetch).
 *
 * Fail-closed by design. It aborts BEFORE sending if the target list has no
 * valid recipients, and fails AFTER sending unless Brevo reports a healthy
 * campaign status. A green run therefore means the send was verified, not
 * merely accepted - Brevo returns 2xx from sendNow on acceptance alone, and
 * three consecutive campaigns were once accepted and then silently suspended
 * with 0 recipients for 18 days. See technical-reference.md F96.
 *
 * Env vars:
 *   BREVO_API_KEY   (required) - Brevo API v3 key
 *   BREVO_LIST_ID   (required) - numeric list ID to send to
 *   SENDER_EMAIL    (required) - verified sender address in Brevo
 *   SENDER_NAME     (optional) - defaults to "Ray & Judy's Book Stop"
 *   EMAIL_HTML_PATH (optional) - path to email-safe HTML, defaults to "email.html"
 *   REPLY_TO        (optional) - reply-to address, defaults to hello@mrcyberrick.us
 *   STALE_MAX_DAYS  (optional) - max age of content in days before send aborts, defaults to 6
 *   DRY_RUN         (optional) - "true" creates a draft in Brevo but does NOT send
 *                                (also bypasses the stale-content guard for previews)
 */

const fs = require("fs");

const API_BASE = "https://api.brevo.com/v3";

const {
  BREVO_API_KEY,
  BREVO_LIST_ID,
  SENDER_EMAIL,
  SENDER_NAME = "Ray & Judy's Book Stop",
  EMAIL_HTML_PATH = "email.html",
  DRY_RUN = "false",
  REPLY_TO = "hello@mrcyberrick.us",
} = process.env;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!BREVO_API_KEY) fail("BREVO_API_KEY is not set.");
if (!BREVO_LIST_ID) fail("BREVO_LIST_ID is not set.");
if (!SENDER_EMAIL) fail("SENDER_EMAIL is not set.");

// ---------- 1. Load and validate the HTML ----------

if (!fs.existsSync(EMAIL_HTML_PATH)) {
  fail(`HTML file not found at "${EMAIL_HTML_PATH}". Did the build step run?`);
}

let html = fs.readFileSync(EMAIL_HTML_PATH, "utf8");

if (html.trim().length < 500) {
  fail("HTML file looks empty or truncated. Aborting to avoid sending a blank email.");
}

// ---------- Stale-content guard ----------
// The generator (Apps Script) writes <!-- pull-feed-generated: YYYY-MM-DD -->
// at the top of the HTML on every run. Prep can happen any day (Fri or Mon),
// but the send fires on a fixed weekly cron. This guard ensures a week with
// NO prep never ships a stale duplicate: if the stamp is older than
// STALE_MAX_DAYS, abort with a non-zero exit so GitHub emails a failure.
// Fail-closed: audience gets nothing (and operator is alerted) rather than
// a repeat of a previous week.
const STALE_MAX_DAYS = Number(process.env.STALE_MAX_DAYS || "6");
const stampMatch = html.match(/pull-feed-generated:\s*(\d{4}-\d{2}-\d{2})/);

if (!stampMatch) {
  // No stamp at all — either an old template predating the guard, or a
  // malformed build. Fail closed unless explicitly a dry run.
  if (DRY_RUN === "true") {
    console.warn("WARNING: No freshness stamp found, but DRY_RUN=true so continuing.");
  } else {
    fail("No freshness stamp found in HTML. Regenerate via buildNewsletter(), then retry.");
  }
} else {
  const stampDate = new Date(stampMatch[1] + "T00:00:00Z");
  const ageDays = (Date.now() - stampDate.getTime()) / 86400000;
  console.log(`Content generated: ${stampMatch[1]} (age ${ageDays.toFixed(1)} days, limit ${STALE_MAX_DAYS})`);

  if (ageDays > STALE_MAX_DAYS) {
    if (DRY_RUN === "true") {
      console.warn(`WARNING: Content is ${ageDays.toFixed(1)} days old (over ${STALE_MAX_DAYS}), but DRY_RUN=true so continuing.`);
    } else {
      fail(
        `Content is ${ageDays.toFixed(1)} days old, exceeding the ${STALE_MAX_DAYS}-day limit. ` +
        `This week's prep likely did not run. Regenerate via buildNewsletter() and retry, ` +
        `or raise STALE_MAX_DAYS for an intentional early build.`
      );
    }
  }
}

// Brevo requires an unsubscribe link. Inject a footer if the template lacks one.
if (!html.includes("{{ unsubscribe }}") && !html.includes("{{unsubscribe}}")) {
  const footer = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#888888;">
      You are receiving this because you signed up for weekly pull list previews.<br>
      <a href="{{ unsubscribe }}" style="color:#888888;">Unsubscribe</a>
    </td></tr>
  </table>`;
  html = html.includes("</body>")
    ? html.replace("</body>", `${footer}</body>`)
    : html + footer;
  console.log("No unsubscribe tag found. Injected default footer.");
}

// Warn if Gmail is likely to clip the message (~102KB limit).
const sizeKB = Buffer.byteLength(html, "utf8") / 1024;
console.log(`HTML size: ${sizeKB.toFixed(1)} KB`);
if (sizeKB > 95) {
  console.warn("WARNING: Over ~95 KB. Gmail will likely clip this email. Consider trimming the cover grid.");
}

// ---------- 2. Build subject and campaign name ----------

const today = new Date();
const dateStr = today.toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "America/New_York",
});

// Prefer the <title> from the generated HTML if present.
const titleMatch = html.match(/<title>([^<]{3,120})<\/title>/i);
const subject = titleMatch
  ? `${titleMatch[1].trim()} - ${dateStr}`
  : `This Week's Comic Previews - ${dateStr}`;

const campaignName = `weekly-pull-feed ${today.toISOString().slice(0, 10)}`;

// ---------- 3. Brevo API helpers ----------

async function brevo(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    fail(`Brevo ${method} ${path} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// Non-fatal variant for status polling. A transient 5xx or a dropped socket
// while READING a campaign's status must not turn a send that already
// succeeded into a red build (the false-alarm risk in this check). Returns
// a result object instead of exiting; the caller decides when to give up.
async function brevoTry(method, path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, json: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, why: `request failed: ${e.message}` };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 3b. Campaign status vocabulary ----------
// Brevo returns 2xx from sendNow on ACCEPTANCE, not on delivery. A campaign
// can be accepted and then immediately suspended - which is exactly what
// happened for campaigns #16/#17/#18 (2026-07-07/14/21): three consecutive
// sends reported success while every one was Suspended with 0 recipients,
// for 18 days, with no signal anywhere. See technical-reference.md F96.
// Verified against run 30406602527: Brevo's API returns snake_case
// "in_process". The camelCase spelling appears in parts of Brevo's own
// docs and was what this list originally carried, so a healthy 9-recipient
// send still in flight at the end of the poll window fell through to the
// "unrecognized status" branch and failed a send that had 100% delivery.
// Both spellings accepted so a vendor inconsistency cannot cost a second
// false alarm. See technical-reference.md F96.
const STATUS_HEALTHY = ["sent", "in_process", "inProcess", "queued"];
const STATUS_BROKEN = ["suspended", "draft", "archive"];
const STATUS_TERMINAL = ["sent", ...STATUS_BROKEN]; // stop polling on these

// ---------- 4. Create the campaign ----------

(async () => {
  // ---------- Pre-send recipient guard ----------
  // Brevo blocklisting is a per-CONTACT, account-level property, not a
  // per-list one, so a list can look populated in the UI and still resolve
  // to zero valid recipients - Brevo then suspends the campaign at
  // submission. This is the check that would have caught F96 BEFORE
  // burning a send, rather than after.
  const list = await brevo("GET", `/contacts/lists/${Number(BREVO_LIST_ID)}`);
  const subscribers = Number(list.totalSubscribers ?? 0);
  const blocklisted = Number(list.totalBlacklisted ?? 0);
  console.log(
    `List ${BREVO_LIST_ID} ("${list.name || "?"}"): ${subscribers} subscriber(s), ` +
    `${blocklisted} blocklisted`
  );

  if (subscribers === 0) {
    const detail =
      blocklisted > 0
        ? `All ${blocklisted} contact(s) on this list are blocklisted account-wide. ` +
          `Unblocklist them under Contacts > Blocklisted in Brevo - removing and ` +
          `re-adding to the list will NOT clear the flag.`
        : `The list is empty.`;
    if (DRY_RUN === "true") {
      console.warn(`WARNING: list ${BREVO_LIST_ID} has 0 valid recipients. ${detail}`);
      console.warn("DRY_RUN=true so continuing, but a real send would be suspended by Brevo.");
    } else {
      fail(
        `List ${BREVO_LIST_ID} has 0 valid recipients, so Brevo would accept this ` +
        `campaign and then suspend it with nothing delivered. ${detail} (F96)`
      );
    }
  }

  console.log(`Creating campaign: "${campaignName}"`);
  console.log(`Subject: "${subject}"`);

  const created = await brevo("POST", "/emailCampaigns", {
    name: campaignName,
    subject,
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    replyTo: REPLY_TO,
    type: "classic",
    htmlContent: html,
    recipients: { listIds: [Number(BREVO_LIST_ID)] },
    inlineImageActivation: false,
  });

  console.log(`Campaign created with ID ${created.id}`);

  // ---------- 5. Send (or stop for dry run) ----------

  if (DRY_RUN === "true") {
    console.log("DRY_RUN=true. Draft created in Brevo but NOT sent.");
    console.log("Review it at https://app.brevo.com > Campaigns, or send a test from there.");
    return;
  }

  await brevo("POST", `/emailCampaigns/${created.id}/sendNow`);
  console.log(`sendNow accepted for campaign ${created.id}. Verifying actual status...`);

  // ---------- 6. Verify the send actually happened (F96) ----------
  // sendNow returning 2xx means "accepted", nothing more. Read the campaign
  // back and require a healthy status. Poll rather than reading once: the
  // status immediately after acceptance is legitimately transient, and a
  // single read would either false-alarm on `queued` or race past a
  // suspension. Bounded so the Action can never hang.
  const ATTEMPTS = 10;
  const INTERVAL_MS = 5000;

  let status = null;
  let lastWhy = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(INTERVAL_MS);

    const res = await brevoTry("GET", `/emailCampaigns/${created.id}`);
    if (!res.ok) {
      lastWhy = res.why;
      console.warn(`  [${attempt}/${ATTEMPTS}] could not read status (${res.why}) - retrying`);
      continue;
    }

    status = res.json.status;
    const sent = res.json.statistics?.globalStats?.sent;
    console.log(
      `  [${attempt}/${ATTEMPTS}] status=${status}` +
      (sent === undefined ? "" : ` sent=${sent}`)
    );

    if (STATUS_TERMINAL.includes(status)) break;
  }

  if (status === null) {
    fail(
      `sendNow was accepted for campaign ${created.id}, but its status could not be ` +
      `read after ${ATTEMPTS} attempts (last error: ${lastWhy}). Treating as FAILED ` +
      `because an unverified send is exactly the blind spot F96 documents - check ` +
      `https://app.brevo.com > Campaigns before re-running to avoid a duplicate send.`
    );
  }

  if (STATUS_BROKEN.includes(status)) {
    fail(
      `Campaign ${created.id} is "${status}" - NOTHING WAS DELIVERED. Brevo accepted ` +
      `sendNow and then refused to send. The usual cause is zero valid recipients ` +
      `(blocklisted contacts) or an unauthenticated sender domain. Inspect the ` +
      `campaign at https://app.brevo.com > Campaigns. (F96)`
    );
  }

  if (!STATUS_HEALTHY.includes(status)) {
    fail(
      `Campaign ${created.id} returned an unrecognized status "${status}". Failing ` +
      `closed: this script cannot confirm the send, and an unconfirmed send is what ` +
      `hid F96 for 18 days. If Brevo has introduced a new legitimate status, add it ` +
      `to STATUS_HEALTHY.`
    );
  }

  if (status === "sent") {
    console.log(`Campaign ${created.id} confirmed SENT.`);
  } else {
    console.log(
      `Campaign ${created.id} is "${status}" - accepted and in flight, not suspended. ` +
      `Brevo has not reported final delivery within ${(ATTEMPTS * INTERVAL_MS) / 1000}s, ` +
      `which is normal for larger lists.`
    );
  }
})();
