# Temmen Revenue Calculator — Setup Guide

A commission/revenue calculator for the sales team, built on Firebase:

- **Reps** open the link — no login — pick state, age, product, premium, and see every carrier ranked by what they'd earn (first-year, renewal, 3-year total), plus cross-sell suggestions with estimated added commission.
- **Admins** click the Admin tab, enter a PIN, and edit the pay scale live. Changes appear for the whole team within seconds (Firestore real-time sync).
- The PIN is enforced **server-side** (it's the password of a single Firebase Auth account, checked by Firestore security rules), so nobody can edit rates by poking at the page source.

Everything runs on Firebase's free **Spark plan**.

---

## One-time setup (~15 minutes)

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. Click **Add project** → name it (e.g. `temmen-revenue-calc`) → Google Analytics is optional (Disable is fine) → **Create project**.

### 2. Enable Firestore

1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose a US location (e.g. `nam5` / `us-central`) — this can't be changed later.
3. Select **Production mode** (our rules file controls access) → **Enable**.

### 3. Enable Email/Password sign-in

1. **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password** (just the top toggle; leave "Email link" off) → **Save**.

### 4. Create the admin account (this sets your PIN)

1. **Authentication → Users → Add user**.
2. Email: `admin@temmeninsurance.com` (must match `ADMIN_EMAIL` in `public/index.html` and the email in `firestore.rules` — change all three together if you use a different one).
3. Password: **this is your admin PIN.** Firebase requires at least 6 characters. Use something your admins can type quickly but reps can't guess (e.g. `8842-Temmen`).
4. Click **Add user**.

> To change the PIN later: Authentication → Users → ⋮ next to the admin user → **Reset password**, or delete and re-add the user with the new password.

### 5. Block self-registration (important)

The rules only trust the one admin email, but this keeps strangers from creating accounts at all:

1. **Authentication → Settings → User actions**.
2. Uncheck **Enable create (sign-up)** — sometimes labeled "Allow users to sign up".
3. Save.

### 6. Register the web app & paste the config

1. Project overview (gear icon) → **Project settings → General → Your apps → Web** (`</>` icon).
2. Nickname it (e.g. `calculator`), **don't** check Firebase Hosting here (we deploy via CLI) → **Register app**.
3. Copy the `firebaseConfig = { ... }` object it shows you.
4. Open `revenue-calculator/public/index.html` and replace the placeholder `FIREBASE_CONFIG` at the top of the `<script>` section with your values.

### 7. Deploy

On any machine with Node.js:

```bash
npm install -g firebase-tools
cd revenue-calculator
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID   # or edit .firebaserc
firebase deploy                          # deploys hosting + Firestore rules
```

The CLI prints your live URL: `https://YOUR_PROJECT_ID.web.app`

Send that link to your sales team. Bookmark it, or add it in GoHighLevel as a **custom menu link** (Settings → Custom Menu Link) so it lives inside the portal.

---

## First use

1. Open the live URL → **Admin** tab → enter your PIN.
2. Click **🌱 Load sample data** to see how the grid works (placeholder numbers for MO/IL/KS/FL/TX, all marked `SAMPLE`), or go straight to **+ Add Rates**.
3. **+ Add Rates** lets you set product, carrier, pay type (% of annual premium or flat $ per app), first-year and renewal amounts, an optional age band, and **multiple states at once** — it writes one row per state so you're not typing 50 entries.
4. In **Settings**, manage the carrier list, which cross-sells get suggested per product, and the "typical monthly premium" used to estimate cross-sell commissions.
5. When you're done testing, click **🗑 Remove sample data**.

## How the calculator matches rates

- A rate row is keyed by **product + carrier + state + age band**.
- When a rep enters state/age/product, each carrier's **most specific** matching row wins (narrowest age band).
- `% of annual premium` rows multiply against the entered premium (monthly premiums are ×12 automatically). `Flat $` rows ignore premium.
- Carriers are ranked by first-year comp; the table also shows renewal/yr and a 3-year total (first year + 2 renewal years).

## Costs & limits

The Spark (free) plan includes 50k Firestore reads and 20k writes **per day** and 10 GB hosting transfer per month — far beyond what a sales team of dozens will use. No credit card required.

## Security notes

- Anyone with the link can **read** the pay scale (that's what lets reps use it without logging in). Don't share the link publicly if your comp grid is sensitive.
- Only the `admin@temmeninsurance.com` auth account can **write**, enforced by `firestore.rules` on Google's servers — the PIN prompt in the UI is just the front door.
- If you ever want rep logins too (per-rep tracking, hiding the grid from outsiders), the app can be extended to require sign-in for reads — ask for it as a follow-up.
