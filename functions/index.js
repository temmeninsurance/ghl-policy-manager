/**
 * TV Leaderboard sync
 *
 * Google Sheet → Firestore doc `tvLeaderboard/current`, read by the public
 * TV page at /tv/. Two exports:
 *
 *   syncLeaderboard    — onSchedule, every 5 minutes, us-central1
 *   syncLeaderboardNow — onRequest manual trigger (returns sync summary)
 *
 * The synced doc contains ONLY: agent names, dates (yyyy-mm-dd), app counts,
 * and the label fields listed in COLUMN_MAP. Nothing else from the sheet is
 * copied, so nothing sensitive can leak unless it is explicitly mapped below.
 *
 * Setup:
 *   1. Fill in SHEET_ID / SHEET_TAB / COLUMN_MAP below.
 *   2. Enable the Google Sheets API on the temmen-leaderboard-2026 project.
 *   3. Share the sheet (Viewer) with the functions' runtime service account:
 *      205711754258-compute@developer.gserviceaccount.com
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");

initializeApp();

/* ════════════════════════════════════════════════════════════════════════
   CONFIG — edit this block
   ════════════════════════════════════════════════════════════════════════ */

// The long ID from the sheet URL: docs.google.com/spreadsheets/d/<SHEET_ID>/edit
const SHEET_ID = "1Q_UveDxIZ8-NokXp_umtoiiEC0Gs_MZvt4ZmFjbmly8";

// Exact tab (worksheet) name holding the submission rows.
const SHEET_TAB = "All Apps";

// Maps output field → exact header-row text in the sheet (case/whitespace
// insensitive match). `agent` and `date` are required. `apps` is optional —
// leave it null and every row counts as 1 app.
const COLUMN_MAP = {
  agent: "Employee email", // required
  date: "Date Sold",       // required
  apps: "App Count",       // optional — null = 1 app per row
  revenue: "Revenue",      // optional numeric KPI ("$1,234.56" → 1234.56)
};

// email (lowercase) → display name/nickname shown on the TV. The public doc
// only ever contains the display name, never the raw email. Emails not
// listed fall back to a prettified local part ("jordan.tully@…" → "Jordan
// Tully").
const AGENT_PROFILES = {
  // "corey@temmeninsurance.com": "Corey",
  // "jordan.tully@temmeninsurance.com": "JT",
};

// When true, every sheet column NOT mapped above is also synced as a
// filterable label field (field key = slugified header, e.g.
// "Lead Source" → lead_source) and the TV page picks them up automatically.
// ⚠ The leaderboard doc is PUBLICLY readable — list any column that must
// stay private (client names, phones, premiums, …) in EXCLUDE_COLUMNS.
const SYNC_ALL_COLUMNS = true;
const EXCLUDE_COLUMNS = [
  "Annual Premium", // premium data — never public
  "Agent Name",     // redundant — agent identity comes from Employee email
];

// Any header matching one of these is also excluded — pattern-based so a
// renamed/added client-data column can't leak by accident.
// ("Company" is intentionally synced — it's used as a TV filter.)
const EXCLUDE_PATTERNS = [/customer/i, /phone/i, /client/i];

// Rows are split into one Firestore doc per month (tvLeaderboard/<yyyy-mm>)
// plus a small metadata doc (tvLeaderboard/current). A month doc
// approaching the 1 MB Firestore limit warns at 80% and fails hard rather
// than truncate.
const MAX_DOC_BYTES = 950_000;

/* ════════════════════════════════════════════════════════════════════════ */

const REQUIRED_FIELDS = ["agent", "date"];

function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}

// Cheap stable content hash (djb2) — used to skip rewriting month docs whose
// rows haven't changed, so TV listeners don't re-download unchanged months.
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

// Public display name for an agent cell. Profile match first; otherwise a
// prettified email local part; non-email values pass through as-is.
function displayName(raw) {
  const key = String(raw ?? "").trim().toLowerCase();
  if (AGENT_PROFILES[key]) return AGENT_PROFILES[key];
  if (!key.includes("@")) return String(raw).trim();
  return key.split("@")[0]
    .split(/[._\-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || key;
}

// Normalize a sheet date cell to "yyyy-mm-dd", or null if unparseable.
function normalizeDate(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;

  // Already ISO-ish: 2026-07-26 (optionally with time appended)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  // US format: 7/26/2026, 07-26-2026, 7/26/26
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Fall back to Date.parse for formats like "July 26, 2026"
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

async function fetchSheetRows() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'`,
  });
  return resp.data.values || [];
}

async function syncSheetToFirestore() {
  if (SHEET_ID.startsWith("REPLACE_") || SHEET_TAB.startsWith("REPLACE_")) {
    throw new Error("SHEET_ID / SHEET_TAB are not configured yet — edit functions/index.js CONFIG block.");
  }
  for (const f of REQUIRED_FIELDS) {
    if (!COLUMN_MAP[f] || String(COLUMN_MAP[f]).startsWith("REPLACE_")) {
      throw new Error(`COLUMN_MAP.${f} is not configured yet — edit functions/index.js CONFIG block.`);
    }
  }

  const values = await fetchSheetRows();
  if (values.length < 2) {
    throw new Error(`Sheet tab '${SHEET_TAB}' returned ${values.length} row(s) — expected a header row plus data.`);
  }

  // The header row is not necessarily row 1 — find the first row containing
  // both required headers.
  const agentHeader = normalizeHeader(COLUMN_MAP.agent);
  const dateHeader = normalizeHeader(COLUMN_MAP.date);
  let headerRow = -1;
  for (let i = 0; i < Math.min(values.length, 20); i++) {
    const h = (values[i] || []).map(normalizeHeader);
    if (h.includes(agentHeader) && h.includes(dateHeader)) { headerRow = i; break; }
  }
  if (headerRow === -1) {
    throw new Error(
      `Could not find a header row containing "${COLUMN_MAP.agent}" and "${COLUMN_MAP.date}" ` +
      `in the first 20 rows of tab '${SHEET_TAB}'. First non-empty row seen: ` +
      `[${(values.find((r) => r && r.length) || []).join(" | ")}]`
    );
  }

  const headers = values[headerRow].map(normalizeHeader);
  const colIndex = {};
  const missing = [];
  for (const [field, headerText] of Object.entries(COLUMN_MAP)) {
    if (headerText == null) continue;
    const idx = headers.indexOf(normalizeHeader(headerText));
    if (idx === -1) missing.push(`${field} → "${headerText}"`);
    else colIndex[field] = idx;
  }
  if (missing.length) {
    throw new Error(
      `Header(s) not found in sheet tab '${SHEET_TAB}': ${missing.join(", ")}. ` +
      `First row seen: [${values[0].join(" | ")}]`
    );
  }

  if (SYNC_ALL_COLUMNS) {
    const excluded = new Set(EXCLUDE_COLUMNS.map(normalizeHeader));
    const used = new Set(Object.values(colIndex));
    const reserved = new Set(["agent", "date", "apps", "revenue"]);
    for (let idx = 0; idx < headers.length; idx++) {
      if (used.has(idx) || excluded.has(headers[idx]) || !headers[idx]) continue;
      if (EXCLUDE_PATTERNS.some((p) => p.test(headers[idx]))) continue;
      let key = headers[idx].replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (!key || reserved.has(key)) continue;
      while (key in colIndex) key += "_2";
      colIndex[key] = idx;
    }
  }

  const currentYear = new Date().getFullYear();
  const rows = [];
  let skippedInvalid = 0;
  let skippedOtherYears = 0;

  for (let i = headerRow + 1; i < values.length; i++) {
    const raw = values[i];
    const agent = displayName(raw[colIndex.agent]);
    const date = normalizeDate(raw[colIndex.date]);
    if (!agent || !date) { skippedInvalid++; continue; }
    // The TV page only shows MTD/YTD, so only the current year is synced —
    // this also keeps the doc well under the 1 MB limit.
    if (Number(date.slice(0, 4)) !== currentYear) { skippedOtherYears++; continue; }

    const row = { agent, date };

    if (colIndex.apps != null) {
      const n = Number(String(raw[colIndex.apps] ?? "").replace(/[^0-9.\-]/g, ""));
      row.apps = Number.isFinite(n) && n > 0 ? n : 0;
    } else {
      row.apps = 1;
    }

    if (colIndex.revenue != null) {
      const n = Number(String(raw[colIndex.revenue] ?? "").replace(/[^0-9.\-]/g, ""));
      row.revenue = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    }

    for (const field of Object.keys(colIndex)) {
      if (["agent", "date", "apps", "revenue"].includes(field)) continue;
      const v = String(raw[colIndex[field]] ?? "").trim();
      if (v) row[field] = v;
    }
    rows.push(row);
  }

  const warnings = [];

  // One doc per month, so a full year can exceed 1 MB overall while each
  // doc stays small.
  const byMonth = new Map();
  for (const row of rows) {
    const m = row.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(row);
  }

  const db = getFirestore();
  const metaRef = db.doc("tvLeaderboard/current");
  const prevHashes = ((await metaRef.get()).data() || {}).monthHashes || {};

  const monthHashes = {};
  let monthsWritten = 0;
  for (const [month, monthRows] of byMonth) {
    const payload = { month, rowCount: monthRows.length, rows: monthRows };
    const json = JSON.stringify(payload);
    if (json.length > MAX_DOC_BYTES) {
      throw new Error(
        `Refusing to write: month ${month} would be ~${Math.round(json.length / 1024)} KB, ` +
        `over the 1 MB Firestore doc limit. Reduce synced fields for this to fit.`
      );
    }
    if (json.length > MAX_DOC_BYTES * 0.8) {
      warnings.push(`Month ${month} is at ${Math.round((json.length / MAX_DOC_BYTES) * 100)}% of the 1 MB doc limit.`);
    }
    const hash = hashString(json);
    monthHashes[month] = hash;
    if (prevHashes[month] === hash) continue; // unchanged — skip the write
    await db.doc(`tvLeaderboard/${month}`).set({ ...payload, updatedAt: FieldValue.serverTimestamp() });
    monthsWritten++;
  }

  // Drop month docs that no longer exist in the sheet (e.g. year rollover).
  for (const month of Object.keys(prevHashes)) {
    if (!byMonth.has(month)) await db.doc(`tvLeaderboard/${month}`).delete();
  }

  await metaRef.set({
    updatedAt: FieldValue.serverTimestamp(),
    year: currentYear,
    months: [...byMonth.keys()].sort(),
    monthHashes,
    rowCount: rows.length,
    skippedInvalid,
    skippedOtherYears,
    fields: [...new Set([...Object.keys(colIndex), "apps"])],
    filterFields: Object.keys(colIndex).filter((f) => !["agent", "date", "apps", "revenue"].includes(f)),
    warnings,
  });

  const summary = {
    synced: rows.length,
    months: byMonth.size,
    monthsWritten,
    skippedInvalid,
    skippedOtherYears,
    warnings,
  };
  logger.info("TV leaderboard synced", summary);
  return summary;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

exports.syncLeaderboard = onSchedule(
  { schedule: "every 5 minutes", region: "us-central1", timeZone: "America/Chicago", memory: "512MiB", timeoutSeconds: 300 },
  async () => {
    await syncSheetToFirestore();
  }
);

exports.syncLeaderboardNow = onRequest(
  { region: "us-central1", invoker: "public", memory: "512MiB", timeoutSeconds: 300 },
  async (req, res) => {
    try {
      const summary = await syncSheetToFirestore();
      res.status(200).json({ ok: true, ...summary });
    } catch (err) {
      logger.error("Manual sync failed", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// In-app editing of agent display names/photos (tvProfiles collection),
// guarded by the TV_ADMIN_KEY secret. The TV page never gets write access
// to Firestore — it posts here and the Admin SDK does the write.
const TV_ADMIN_KEY = defineSecret("TV_ADMIN_KEY");

exports.updateAgentProfile = onRequest(
  { region: "us-central1", invoker: "public", cors: true, secrets: [TV_ADMIN_KEY] },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "POST only" });
        return;
      }
      const { key, agent, name, photo } = req.body || {};
      if (!key || key !== TV_ADMIN_KEY.value()) {
        res.status(403).json({ ok: false, error: "Invalid admin key" });
        return;
      }
      const agentStr = String(agent || "").trim();
      const slug = agentStr.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug || agentStr.length > 120) {
        res.status(400).json({ ok: false, error: "Invalid agent" });
        return;
      }
      const update = { agent: agentStr, updatedAt: FieldValue.serverTimestamp() };
      if (typeof name === "string") {
        update.name = name.trim().slice(0, 60) || FieldValue.delete();
      }
      if (typeof photo === "string" && photo) {
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 300_000) {
          res.status(400).json({ ok: false, error: "Photo must be a small jpeg/png data URI" });
          return;
        }
        update.photo = photo;
      }
      await getFirestore().doc(`tvProfiles/${slug}`).set(update, { merge: true });
      res.json({ ok: true, slug });
    } catch (err) {
      logger.error("updateAgentProfile failed", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// Shared dashboard definitions (tvDashboards/config) so every TV/phone sees
// the same set. Same admin-key guard as profiles; the doc is public-read.
exports.updateDashboards = onRequest(
  { region: "us-central1", invoker: "public", cors: true, secrets: [TV_ADMIN_KEY] },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "POST only" });
        return;
      }
      const { key, dashboards } = req.body || {};
      if (!key || key !== TV_ADMIN_KEY.value()) {
        res.status(403).json({ ok: false, error: "Invalid admin key" });
        return;
      }
      if (!Array.isArray(dashboards) || dashboards.length > 200 ||
          dashboards.some((d) => !d || typeof d.title !== "string" || !d.title.trim() || d.title.length > 80)) {
        res.status(400).json({ ok: false, error: "dashboards must be an array of {title, ...} objects" });
        return;
      }
      if (JSON.stringify(dashboards).length > 500_000) {
        res.status(400).json({ ok: false, error: "Dashboard config too large" });
        return;
      }
      await getFirestore().doc("tvDashboards/config").set({
        dashboards,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ ok: true, count: dashboards.length });
    } catch (err) {
      logger.error("updateDashboards failed", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);
