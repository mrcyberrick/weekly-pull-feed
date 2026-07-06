/**
 * send-brevo-campaign.js
 * Creates a Brevo email campaign from a local HTML file and sends it.
 * Zero dependencies. Requires Node 18+ (native fetch).
 *
 * Env vars:
 *   BREVO_API_KEY   (required) - Brevo API v3 key
 *   BREVO_LIST_ID   (required) - numeric list ID to send to
 *   SENDER_EMAIL    (required) - verified sender address in Brevo
 *   SENDER_NAME     (optional) - defaults to "Ray & Judy's Book Stop"
 *   EMAIL_HTML_PATH (optional) - path to email-safe HTML, defaults to "email.html"
 *   DRY_RUN         (optional) - "true" creates a draft in Brevo but does NOT send
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

// ---------- 4. Create the campaign ----------

(async () => {
  console.log(`Creating campaign: "${campaignName}"`);
  console.log(`Subject: "${subject}"`);

  const created = await brevo("POST", "/emailCampaigns", {
    name: campaignName,
    subject,
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
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
  console.log("Campaign sent successfully.");
})();
