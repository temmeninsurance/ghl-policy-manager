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
// leave it null and every row counts as 1 app. Any additional entries become
// filterable label fields on the TV page (keep them non-sensitive!).
const COLUMN_MAP = {
  agent: "REPLACE_WITH_AGENT_HEADER", // required
  date: "REPLACE_WITH_DATE_HEADER",   // required
  apps: null,                          // optional — null = 1 app per row
  // Optional filterable fields — uncomment/edit to match the sheet:
  // product: "Product",
  // carrier: "Carrier",
  // source: "Source",
};

// Rows-this-year threshold above which we warn about the 1 MB Firestore
// document limit (and the hard byte guard below refuses to write a doc
// that would exceed it).
const ROW_WARN_THRESHOLD = 9000;
const MAX_DOC_BYTES = 950_000;

/* ════════════════════════════════════════════════════════════════════════ */

const REQUIRED_FIELDS = ["agent", "date"];

function normalizeHeader(h) {
  return String(h ?? "").trim().toLowerCase();
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

  const headers = values[0].map(normalizeHeader);
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

  const currentYear = new Date().getFullYear();
  const rows = [];
  let skippedInvalid = 0;
  let skippedOtherYears = 0;

  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    const agent = String(raw[colIndex.agent] ?? "").trim();
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

    for (const field of Object.keys(colIndex)) {
      if (field === "agent" || field === "date" || field === "apps") continue;
      const v = String(raw[colIndex[field]] ?? "").trim();
      if (v) row[field] = v;
    }
    rows.push(row);
  }

  const warnings = [];
  if (rows.length > ROW_WARN_THRESHOLD) {
    warnings.push(
      `Sheet has ${rows.length} rows this year (> ${ROW_WARN_THRESHOLD}). ` +
      `Approaching the 1 MB Firestore document limit — consider splitting the ` +
      `doc by month (tvLeaderboard/2026-01, 2026-02, …).`
    );
  }

  const doc = {
    updatedAt: FieldValue.serverTimestamp(),
    year: currentYear,
    rowCount: rows.length,
    skippedInvalid,
    skippedOtherYears,
    fields: Object.keys(COLUMN_MAP).filter((f) => COLUMN_MAP[f] != null || f === "apps"),
    warnings,
    rows,
  };

  const approxBytes = JSON.stringify(doc).length;
  if (approxBytes > MAX_DOC_BYTES) {
    throw new Error(
      `Refusing to write: doc would be ~${Math.round(approxBytes / 1024)} KB, over the 1 MB ` +
      `Firestore limit. Split by month (tvLeaderboard/<yyyy-mm> docs) before re-enabling sync.`
    );
  }

  await getFirestore().doc("tvLeaderboard/current").set(doc);

  const summary = { synced: rows.length, skippedInvalid, skippedOtherYears, approxBytes, warnings };
  logger.info("TV leaderboard synced", summary);
  return summary;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

exports.syncLeaderboard = onSchedule(
  { schedule: "every 5 minutes", region: "us-central1", timeZone: "America/Chicago" },
  async () => {
    await syncSheetToFirestore();
  }
);

exports.syncLeaderboardNow = onRequest(
  { region: "us-central1", invoker: "public" },
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
