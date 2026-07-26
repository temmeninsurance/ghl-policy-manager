# TV Leaderboard — Setup & Deploy

Live sales-floor leaderboard for office TVs, served at
**https://leaderboard.temmenportal.com/tv/** (once the custom domain is
connected in Firebase Hosting).

## Architecture

Google Sheet → `syncLeaderboard` Cloud Function (every 5 min, us-central1)
→ Firestore doc `tvLeaderboard/current` → static `/tv/` page with a
real-time `onSnapshot` listener. The page is public and contains only agent
names, dates, label fields (product/carrier/source…), and app counts —
no PHI, no client data, no revenue.

## Files

| File | Purpose |
|---|---|
| `functions/index.js` | `syncLeaderboard` (schedule) + `syncLeaderboardNow` (manual HTTP trigger) |
| `public/tv/index.html` | The TV page |
| `firestore.rules` | Public read on `tvLeaderboard` only; deny-all otherwise |
| `firebase.json` | Hosting (`public/`), rules, functions codebase `tv-leaderboard` |
| `.firebaserc` | Firebase project alias |

## Project

- Firebase project: **Temmen Leaderboard** (`temmen-leaderboard-2026`,
  project number `205711754258`) — a dedicated project, so the deny-all
  default in `firestore.rules` is safe to deploy as-is.
- Functions runtime service account (share the sheet with this, Viewer):
  **`205711754258-compute@developer.gserviceaccount.com`**

## Values still to fill in before deploying

1. `functions/index.js` CONFIG block — `SHEET_ID`, `SHEET_TAB`, `COLUMN_MAP`
   (exact header-row text for agent, date, optional apps + filter fields).
2. `public/tv/index.html` — `FIREBASE_CONFIG.apiKey` (from the web app,
   see below) and `TV_CONFIG.filterFields` (must equal the optional fields
   in COLUMN_MAP).

## One-time project setup

1. **Upgrade to the Blaze plan** (Cloud Functions and Cloud Scheduler
   require it; cost at this scale is ~$0).
2. **Create the Firestore database**: Firebase Console → Firestore →
   Create database → production mode → `us-central1` (or nam5).
3. **Create a web app** (for the TV page's apiKey): Project settings →
   Your apps → Add app → Web (</>) → name it "TV Leaderboard" — no hosting
   snippet needed. Copy the `apiKey` into `public/tv/index.html`.
4. **Enable the Sheets API**:
   https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=temmen-leaderboard-2026
5. **Share the sheet (Viewer)** with
   `205711754258-compute@developer.gserviceaccount.com`.

The functions deploy is isolated via the `tv-leaderboard` codebase in
`firebase.json`, so it can never touch functions deployed from other
repos/projects (e.g. GHL sync functions).

## Deploy

```bash
cd functions && npm install && cd ..
firebase deploy --only firestore:rules          # after merging existing rules!
firebase deploy --only functions:tv-leaderboard
firebase deploy --only hosting
```

## Verify

1. Hit the manual sync endpoint (URL printed by the functions deploy):
   `https://us-central1-<PROJECT_ID>.cloudfunctions.net/syncLeaderboardNow`
   → should return `{"ok":true,"synced":<n>,...}`. A 403/permission error
   means the sheet isn't shared with the service account yet.
2. Check `tvLeaderboard/current` in the Firestore console: row count sane,
   dates `yyyy-mm-dd`, apps numeric, no unmapped fields present.
3. Open `/tv/` — total renders, ranking matches a hand spot-check,
   `/tv/?<filterField>=<value>` filters, MTD/YTD rotation runs
   (lock with `/tv/?view=mtd`).

## Dashboards (URL options)

Every distinct URL is its own dashboard — point each TV at a different
combination:

- `/tv/` — rotating MTD/YTD, all data, ranked by **revenue** (default KPI)
- `/tv/?metric=apps` — rank/total by app count instead
- `/tv/?view=mtd` or `?view=ytd` — lock the view
- `/tv/?title=Ancillary Board` — custom title on that screen
- `/tv/?carrier=Humana Choice PPO&policy_type=PPO` — filter by any sheet
  column (header slugified: "Policy Type" → `policy_type`, "Company" →
  `company`); params AND together

Example: `/tv/?title=Inbound Apps&metric=apps&inbound_outbound=Inbound&view=mtd`

## Agent photos

See `public/tv/agents/README.md` — drop `<display-name-slug>.jpg` files in
that folder and redeploy hosting; initials are shown when no photo exists.
Nicknames map in AGENT_PROFILES (functions/index.js).

## Custom domain

Firebase Console → Hosting → Add custom domain →
`leaderboard.temmenportal.com`, then add the DNS records it shows.

## Limits

Only current-year rows are synced (the page shows MTD/YTD). Above ~9k rows
the sync writes a warning into the doc; near the 1 MB Firestore doc limit it
refuses to write and the fix is splitting into per-month docs.
