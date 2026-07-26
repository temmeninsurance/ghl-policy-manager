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

## Values to fill in before deploying

1. `.firebaserc` — the Firebase **project ID**.
2. `functions/index.js` CONFIG block — `SHEET_ID`, `SHEET_TAB`, `COLUMN_MAP`
   (exact header-row text for agent, date, optional apps + filter fields).
3. `public/tv/index.html` — `FIREBASE_CONFIG` (apiKey, authDomain, projectId
   from Project settings → Your apps → Web app) and
   `TV_CONFIG.filterFields` (must equal the optional fields in COLUMN_MAP).

## One-time GCP setup

1. **Enable the Sheets API** on the Firebase project:
   `https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=<PROJECT_ID>`
2. **Share the sheet (Viewer)** with the functions runtime service account:
   `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`
   (find the project number on the Project settings page, or
   `gcloud projects describe <PROJECT_ID> --format='value(projectNumber)'`).

## ⚠️ Before deploying Firestore rules

`firebase deploy --only firestore:rules` **replaces the project's entire
ruleset**. If this Firebase project already has rules (e.g. for the portal),
copy them from Firebase Console → Firestore → Rules into `firestore.rules`
at the marked spot first. As shipped, everything except `tvLeaderboard`
is deny-all.

The functions deploy is isolated via the `tv-leaderboard` codebase in
`firebase.json`, so it will not touch functions deployed from other repos
(e.g. GHL sync functions).

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

## URL options

- `/tv/` — rotating MTD/YTD, all data
- `/tv/?view=mtd` or `?view=ytd` — lock the view
- `/tv/?product=Life` (etc.) — filter by any field in `filterFields`

## Custom domain

Firebase Console → Hosting → Add custom domain →
`leaderboard.temmenportal.com`, then add the DNS records it shows.

## Limits

Only current-year rows are synced (the page shows MTD/YTD). Above ~9k rows
the sync writes a warning into the doc; near the 1 MB Firestore doc limit it
refuses to write and the fix is splitting into per-month docs.
