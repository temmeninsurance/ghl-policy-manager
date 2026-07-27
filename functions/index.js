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

// The primary tab (worksheet). Company-wide facts on the TV (celebrations,
// career badges, streaks) always come from this tab.
const SHEET_TAB = "All Apps";

// Every OTHER visible tab in the spreadsheet is also synced as an extra
// data source. Each tab's columns are auto-detected from the alias lists
// below, so tabs don't need to use the primary tab's exact header names.
// Tabs where no agent + date column can be recognized (notes, pivots,
// pictures, …) are skipped automatically — the skip reason (including the
// headers seen) is written to tvLeaderboard/current → skippedTabs.
// Hidden tabs and any tab listed here are never synced:
const EXCLUDE_TABS = [];

// Explicit column mappings for extra tabs the auto-detection can't figure
// out. Key = exact tab name (trailing spaces ok), value shaped like
// COLUMN_MAP. Example:
//   "Retained Revenue": { agent: "Agent", date: "Month", apps: null, revenue: "Retained" },
const TAB_COLUMN_MAPS = {};

// Auto-detection aliases, matched case/whitespace-insensitively against each
// extra tab's headers. Agent aliases are deliberately conservative (exact
// matches only) so a customer-name column can never be mistaken for the
// agent column and leak into the public docs.
const AGENT_ALIASES = [
  "employee email", "employee", "employee name", "agent email", "agent",
  "agent name", "rep", "rep name", "producer", "producer name", "sdr",
  "sdr name", "salesperson", "sold by", "writing agent", "team member",
];
const DATE_ALIASES = [
  "date sold", "sold date", "sale date", "date", "submission date",
  "date submitted", "submitted", "app date", "application date",
  "date of sale", "effective date", "timestamp", "created", "created at",
  "month",
];
const APPS_ALIASES = [
  "app count", "apps", "app", "# of apps", "number of apps",
  "policy count", "policies", "count", "qty", "quantity",
];
const REVENUE_ALIASES = [
  "revenue", "monthly revenue", "new revenue", "total revenue",
  "retained revenue", "commission", "comp",
];

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

function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function listVisibleTabs(sheets) {
  const resp = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties(title,hidden)",
  });
  return (resp.data.sheets || [])
    .map((s) => s.properties)
    .filter((p) => p && !p.hidden && p.title)
    .map((p) => p.title);
}

async function fetchTabValues(sheets, tab) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${String(tab).replace(/'/g, "''")}'`, // A1 escapes ' by doubling
  });
  return resp.data.values || [];
}

// Column mapping for an EXTRA tab: explicit TAB_COLUMN_MAPS entry first,
// then alias auto-detection. Throws (with the headers it saw) when no
// agent + date column can be recognized.
function detectTabMap(tabTitle, values) {
  for (const [name, map] of Object.entries(TAB_COLUMN_MAPS)) {
    if (normalizeHeader(name) === normalizeHeader(tabTitle)) return map;
  }
  for (let i = 0; i < Math.min(values.length, 20); i++) {
    const h = (values[i] || []).map(normalizeHeader);
    const agent = AGENT_ALIASES.find((a) => h.includes(a));
    const date = DATE_ALIASES.find((a) => h.includes(a));
    if (!agent || !date) continue;
    const apps = APPS_ALIASES.find((a) => h.includes(a)) || null;
    const revenue = REVENUE_ALIASES.find((a) => h.includes(a)) ||
      h.find((x) => /revenue/.test(x)) || null;
    return { agent, date, apps, revenue };
  }
  const firstRow = (values.find((r) => r && r.filter(Boolean).length >= 2) || [])
    .slice(0, 12).join(" | ");
  throw new Error(`no recognizable agent/date columns; headers seen: [${firstRow.slice(0, 220)}]`);
}

// Parse one tab's raw values into public rows using the given column map.
// Throws when the map's required headers can't be found (callers skip
// non-primary tabs on that error).
function parseTab(tabTitle, values, colMap = COLUMN_MAP) {
  if (values.length < 2) {
    throw new Error(`tab '${tabTitle}' returned ${values.length} row(s) — expected a header row plus data.`);
  }

  // The header row is not necessarily row 1 — find the first row containing
  // both required headers.
  const agentHeader = normalizeHeader(colMap.agent);
  const dateHeader = normalizeHeader(colMap.date);
  let headerRow = -1;
  for (let i = 0; i < Math.min(values.length, 20); i++) {
    const h = (values[i] || []).map(normalizeHeader);
    if (h.includes(agentHeader) && h.includes(dateHeader)) { headerRow = i; break; }
  }
  if (headerRow === -1) {
    throw new Error(
      `no header row containing "${colMap.agent}" and "${colMap.date}" ` +
      `in the first 20 rows of tab '${tabTitle}'`
    );
  }

  const headers = values[headerRow].map(normalizeHeader);
  const colIndex = {};
  const missing = [];
  for (const [field, headerText] of Object.entries(colMap)) {
    if (headerText == null) continue;
    const idx = headers.indexOf(normalizeHeader(headerText));
    if (idx === -1) missing.push(`${field} → "${headerText}"`);
    else colIndex[field] = idx;
  }
  if (missing.length) {
    throw new Error(`header(s) not found in tab '${tabTitle}': ${missing.join(", ")}`);
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

  for (let i = headerRow + 1; i < values.length; i++) {
    const raw = values[i];
    const agent = displayName(raw[colIndex.agent]);
    const date = normalizeDate(raw[colIndex.date]);
    if (!agent || !date) { skippedInvalid++; continue; }
    // All history is synced (one doc per month); only obviously bogus
    // dates are dropped.
    const year = Number(date.slice(0, 4));
    if (year < 2000 || year > currentYear + 1) { skippedInvalid++; continue; }

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

  return {
    rows,
    skippedInvalid,
    fields: [...new Set([...Object.keys(colIndex), "apps"])],
    filterFields: Object.keys(colIndex).filter((f) => !["agent", "date", "apps", "revenue"].includes(f)),
  };
}

function slugifyTab(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

  const sheets = sheetsClient();
  const warnings = [];
  const skippedTabs = [];

  // Primary tab first — a failure here fails the whole sync, exactly as
  // before multi-tab support.
  const primary = parseTab(SHEET_TAB, await fetchTabValues(sheets, SHEET_TAB));
  const sources = [{ id: "main", title: SHEET_TAB, ...primary }];

  // Every other visible tab with the required headers becomes an extra
  // source; anything else is skipped (and listed in the meta doc).
  let tabs = [];
  try {
    tabs = await listVisibleTabs(sheets);
  } catch (err) {
    warnings.push(`Could not list sheet tabs (${err.message}) — synced only '${SHEET_TAB}'.`);
  }
  const excludedTabs = new Set(EXCLUDE_TABS.map((t) => normalizeHeader(t)));
  const usedIds = new Set(["main", "current"]);
  for (const tab of tabs) {
    if (tab === SHEET_TAB || excludedTabs.has(normalizeHeader(tab))) continue;
    try {
      const values = await fetchTabValues(sheets, tab);
      const parsed = parseTab(tab, values, detectTabMap(tab, values));
      if (!parsed.rows.length) {
        skippedTabs.push({ tab, reason: "columns recognized but no parsable data rows" });
        continue;
      }
      let id = slugifyTab(tab) || "tab";
      while (usedIds.has(id)) id += "-2";
      usedIds.add(id);
      sources.push({ id, title: tab.trim(), ...parsed });
    } catch (err) {
      skippedTabs.push({ tab, reason: err.message });
    }
  }

  const currentYear = new Date().getFullYear();
  const db = getFirestore();
  const metaRef = db.doc("tvLeaderboard/current");
  const prevHashes = ((await metaRef.get()).data() || {}).monthHashes || {};

  // One doc per source-month (heavy months shard into -p1, -p2, …). The
  // primary source keeps the legacy '<yyyy-mm>' ids; extra sources use
  // '<slug>~<yyyy-mm>' and store rows under `srows` so TV pages older than
  // this feature ignore them instead of double-counting.
  const TARGET_DOC_BYTES = 700_000;
  const docs = new Map(); // docId → { source, rows }
  for (const src of sources) {
    const byMonth = new Map();
    for (const row of src.rows) {
      const m = row.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(row);
    }
    src.months = [...byMonth.keys()].sort();
    for (const [month, monthRows] of byMonth) {
      const base = src.id === "main" ? month : `${src.id}~${month}`;
      const size = JSON.stringify(monthRows).length + 200;
      const parts = Math.max(1, Math.ceil(size / TARGET_DOC_BYTES));
      if (parts === 1) { docs.set(base, { src, month, rows: monthRows }); continue; }
      const per = Math.ceil(monthRows.length / parts);
      for (let k = 0; k < parts; k++) {
        const chunk = monthRows.slice(k * per, (k + 1) * per);
        if (chunk.length) docs.set(`${base}-p${k + 1}`, { src, month, rows: chunk });
      }
    }
  }

  const monthHashes = {};
  let monthsWritten = 0;
  for (const [docId, { src, month, rows: docRows }] of docs) {
    const payload = { source: src.id, sourceTitle: src.title, month, rowCount: docRows.length };
    if (src.id === "main") payload.rows = docRows;
    else payload.srows = docRows;
    const json = JSON.stringify(payload);
    if (json.length > MAX_DOC_BYTES) {
      throw new Error(
        `Refusing to write: doc ${docId} would be ~${Math.round(json.length / 1024)} KB, ` +
        `over the 1 MB Firestore doc limit even after sharding.`
      );
    }
    const hash = hashString(json);
    monthHashes[docId] = hash;
    if (prevHashes[docId] === hash) continue; // unchanged — skip the write
    await db.doc(`tvLeaderboard/${docId}`).set({ ...payload, updatedAt: FieldValue.serverTimestamp() });
    monthsWritten++;
  }

  // Drop docs that no longer exist (year rollover, a re-sharded month, or
  // a tab that was renamed/removed).
  for (const docId of Object.keys(prevHashes)) {
    if (!docs.has(docId)) await db.doc(`tvLeaderboard/${docId}`).delete();
  }

  const totalRows = sources.reduce((n, s) => n + s.rows.length, 0);
  await metaRef.set({
    updatedAt: FieldValue.serverTimestamp(),
    year: currentYear,
    months: sources[0].months,
    monthHashes,
    rowCount: totalRows,
    skippedInvalid: sources.reduce((n, s) => n + s.skippedInvalid, 0),
    // Legacy top-level fields describe the primary tab (older TV pages).
    fields: sources[0].fields,
    filterFields: sources[0].filterFields,
    sources: sources.map((s) => ({
      id: s.id, title: s.title, rowCount: s.rows.length, filterFields: s.filterFields,
    })),
    skippedTabs,
    warnings,
  });

  const summary = {
    synced: totalRows,
    sources: sources.map((s) => `${s.title}: ${s.rows.length}`),
    monthsWritten,
    skippedTabs: skippedTabs.map((t) => t.tab),
    warnings,
  };
  logger.info("TV leaderboard synced", summary);
  return summary;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

exports.syncLeaderboard = onSchedule(
  { schedule: "every 2 minutes", region: "us-central1", timeZone: "America/Chicago", memory: "512MiB", timeoutSeconds: 300 },
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
      const { key, agent, name, photo, goal } = req.body || {};
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
      if (goal !== undefined) {
        const g = Number(goal);
        if (!Number.isFinite(g) || g < 0 || g > 10_000_000) {
          res.status(400).json({ ok: false, error: "Goal must be a number between 0 and 10,000,000" });
          return;
        }
        update.goal = g > 0 ? g : FieldValue.delete(); // 0 clears the goal
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

