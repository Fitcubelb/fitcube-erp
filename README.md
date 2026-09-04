# Fit Cube ERP

A client, session, schedule and small-inventory manager for Fit Cube (Anthony Zakka — personal training & physical therapy). Built to run on your phone, online or offline, at $0 hosting cost.

## What's in this first version

- **Clients** — every client from your paper/notes tracker has already been imported, with names, unpaid balances, and prepaid session credits, using your own legend (🟢 prepaid, 🔴 unpaid, ⚡️ EMS, 🦵 Presso Therapy, 😊 kids, -$X owed, -$X(N) = N unpaid sessions at $X, $X = paid in advance).
- **Session log** — log each session as prepaid credit, unpaid, or paid now; tag EMS / Presso / kids; see a running balance per client; one tap to mark a session paid.
- **Schedule** — book appointments per client and service, mark done/cancelled.
- **Stock** — track products, quantities, cost/sale price, low-stock warning.
- **Sales & Purchases** — record a sale (deducts stock) or a restock purchase (adds stock).
- **Works offline** — the app keeps working with no signal (in the gym, on the road). Anything you add or change offline is saved on your phone and sent to the server automatically the next time you're online — nothing is lost.
- **Installable on your phone** — add it to your home screen and it behaves like a normal app, no App Store needed.

## Not built yet (next steps, once this is working for you)

- A visual calendar/day-grid for the schedule (currently a list, grouped by day)
- Multi-line sales/purchases in one screen (currently one product per transaction — you can just record a few sales in a row)
- Reminders/notifications for upcoming or overdue-payment clients
- Reports (monthly revenue, top clients, most-booked service)

Tell me which of these matters most and I'll build it next.

---

## Running it yourself, right now (no hosting, on your own WiFi)

This is the same way the Zakka Autoparts system runs today — good for trying it out immediately.

```
npm install
npm run seed      # only once, to import your existing client list
npm start
```

Then open `http://localhost:3000` on the same computer, or `http://<your-computer's-local-IP>:3000` from your phone while on the same WiFi.

## Putting it online for free, so it works from your phone anywhere (not just your WiFi)

You asked for this to work from your phone, online and offline, at $0. Two free services do that together:

1. **Turso** (free database) — holds your data so it's never lost, even though the free hosting below "sleeps."
2. **Render** (free web hosting) — runs the app and serves it to your phone's browser.

### Step 1 — Create the free database (Turso)

1. Go to turso.tech and sign up (no credit card required for the free tier).
2. Create a database (any name, e.g. `fitcube`).
3. From its dashboard, copy the **database URL** (starts with `libsql://`) and create an **auth token**.
4. Import your existing client list into it (one-time, from your computer):
   ```
   TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="..." npm run seed
   ```
   (Run this only once — running it again on a database that already has clients does nothing, so it's safe.)

### Step 2 — Put this project on GitHub

1. Create a free GitHub account if you don't have one.
2. Create a new repository and push this project's code to it (I can walk you through this, or do it for you if you'd like this session connected to GitHub).

### Step 3 — Deploy on Render (free)

1. Go to render.com and sign up (no credit card required for the free tier).
2. Click **New → Blueprint**, point it at your GitHub repo — Render will read `render.yaml` in this project and set everything up.
   - (If you'd rather click through manually: **New → Web Service**, connect the repo, build command `npm install`, start command `npm start`.)
3. When asked, paste in the `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from Step 1.
4. Deploy. Render gives you a web address like `https://fitcube-erp.onrender.com` — that's your app's address from anywhere.

### Step 4 — Install it on your phone

1. Open your Render address in your phone's browser.
2. iPhone: tap Share → **Add to Home Screen**. Android (Chrome): tap the menu (⋮) → **Add to Home screen** / **Install app**.
3. Open it from the home screen icon like any other app.

### A note on the free tier

Render's free web service goes to sleep after 15 minutes of no visits, and takes about a minute to wake back up on the next visit — that's the trade-off for $0 hosting. It doesn't lose any data (that lives in Turso), and while it's asleep or your phone has no signal, the app still opens and shows everything from the last time it synced — you just won't see brand-new updates from someone else until it wakes up. If this cold-start delay ever becomes annoying, the fix is a small monthly hosting cost (a few dollars) instead of the free tier — just say the word and I'll switch it over.

---

## Project structure

```
server/           Express API + SQLite/Turso database
  db/schema.sql    table definitions
  db/seed.js       one-time import of your existing client tracker
  index.js         API routes
public/            the phone app (installable PWA)
  index.html, app.js, styles.css   the app itself
  db.js, api.js, sync.js           offline storage + background sync
  sw.js, manifest.json             installability + offline shell
```
