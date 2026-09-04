# Fit Cube ERP

A client, session, schedule and small-inventory manager for Fit Cube (Anthony Zakka — personal training & physical therapy). Built to run on your phone, online or offline, at $0 hosting cost.

## What's in this first version

- **Clients** — every client from your paper/notes tracker has already been imported, with names, unpaid balances, and prepaid session credits, using your own legend (🟢 prepaid, 🔴 unpaid, ⚡️ EMS, 🦵 Presso Therapy, 😊 kids, -$X owed, -$X(N) = N unpaid sessions at $X, $X = paid in advance).
- **Session log** — log each session as prepaid credit, unpaid, or paid now; tag EMS / Presso / kids; see a running balance per client; one tap to mark a session paid.
- **Schedule** — book appointments per client and service, mark done/cancelled.
- **Stock** — track products, quantities, cost/sale price, low-stock warning.
- **Sales & Purchases** — record a sale (deducts stock) or a restock purchase (adds stock).
- **Works offline** — the app keeps working with no signal (in the gym, on the road). Anything you add or change offline is saved on your phone and sent to the server automatically the next time you're online — nothing is lost.
- **Installable on your phone** — add it to your home screen and it behaves like a normal app, no App Store needed. Uses your Fit Cube logo as the icon.
- **Revenue by service** — the Sales tab shows total revenue broken down by service (PT, EMS, Presso, etc.) and top-selling products, so you can see what's actually making money.
- **One-tap backup** — a "Download backup" button on the Overview tab saves your entire database (clients, sessions, balances, products, sales) as one file. See "Protecting your data" below — do this regularly.
- **Light and dark mode** — follows your phone's system setting automatically; tap the ☾/☀ button top-right to override it. Remembered per device.
- **Sort/find clients your way** — on the Clients tab: A–Z, Most active (by session count), or Not coming anymore (longest since their last session first, with an "at risk" tag once it's been 30+ days). Each client also shows "Last session: Xd ago" so you can spot who's drifted away at a glance. Search is a plain type-as-you-go box (not a dropdown) and ignores capitalization — searching a first name, last name, or part of either all work.
- **WhatsApp reminders** — a "Remind" button on upcoming appointments (and a general "WhatsApp" button on each client) opens WhatsApp directly with the message pre-written — one tap to send, no browser involved, $0. See "WhatsApp reminders" below for the fully-automatic upgrade option.
- **Add clients from your Contacts** — on Android, "Choose from Contacts" fills the name/phone straight from your phone's address book. (iOS/Safari doesn't allow web apps to browse Contacts — Apple restricts that to native apps only — so on iPhone the Name/Phone fields instead support Safari's own contact-suggestion autofill as you type.)

## WhatsApp reminders

**Default, $0, works right now:** tapping "Remind" builds the message and opens WhatsApp itself (not a browser tab) with it pre-filled — you just hit send. No setup needed, and this always works as a fallback even if you set up the option below.

**Optional upgrade — fully automatic sending, no tap needed:** this requires Meta's WhatsApp Cloud API, which means: a Meta Business account, a WhatsApp Business phone number, and an approved message template (Meta reviews the exact wording before it can be used for reminders — takes anywhere from minutes to a couple of days). As of October 2026, Meta also started charging a small per-message fee for these (roughly $0.004–$0.016 depending on the recipient's country) — there's no longer a free tier for business-initiated messages like appointment reminders, so this is no longer strictly $0, but it's close (a few cents per day of reminders). If you want to set this up:

1. Create a Meta Business + WhatsApp Business Platform account at developers.facebook.com/products/whatsapp.
2. Get a phone number ID and a permanent access token.
3. Submit a message template named `session_reminder` (or set `WHATSAPP_TEMPLATE_NAME` to whatever you name it) for approval, with a body like: `Hi {{1}}, reminder from Fit Cube: your {{2}} is on {{3}}. See you then!`
4. Set `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` (and `WHATSAPP_TEMPLATE_NAME`/`WHATSAPP_TEMPLATE_LANG` if different) as environment variables.

Once those are set, "Remind" sends automatically with no app-switching at all. Leave them unset and everything still works via the free WhatsApp-app-opening method above — nothing breaks either way.

## Protecting your data

No hosting setup is 100% bulletproof, so this app gives you a backup you fully control on top of everything else:

- **Download backup** (Overview tab) saves a complete snapshot as a `.json` file. Do this after busy days, and save the file somewhere safe — email it to yourself, save to Google Drive/iCloud, or AirDrop it to another device. Takes 5 seconds.
- **Restore from backup** (also on Overview) loads a backup file back in — useful if a device is lost, or if you want to move the app to different hosting later. It replaces everything currently in the database, so it asks you to confirm first.
- If you deploy to Turso (below), that service also keeps its own rolling backup automatically (1 day of point-in-time restore on the free tier) — a second safety net on top of your own downloaded copies.
- The offline copy on your phone (in the app itself) is a working cache, not a backup — it's convenience for when you have no signal, not a substitute for downloading a real backup file.

## Not built yet (next steps, once this is working for you)

- A visual calendar/day-grid for the schedule (currently a list, grouped by day)
- Multi-line sales/purchases in one screen (currently one product per transaction — you can just record a few sales in a row)
- Automatic reminders (right now you tap "Remind" yourself — a scheduled daily nudge for tomorrow's appointments is a natural next step)
- Recurring/renewal clients (e.g. a monthly package that renews on a set day) — flagged as a note today, not tracked automatically

Tell me which of these matters most and I'll build it next.

Note: phone numbers weren't part of your original paper tracker, so none of the 48 imported clients have one yet — WhatsApp buttons only appear once a client has a phone number. Add numbers as you go (or use "Choose from Contacts" on Android) and reminders will start working for that client immediately.

---

## Running it yourself, right now (no hosting, on your own WiFi)

This is the same way the Zakka Autoparts system runs today — good for trying it out immediately.

```
npm install
npm run seed      # only once, to import your existing client list
npm start
```

Then open `http://localhost:3000` on the same computer, or `http://<your-computer's-local-IP>:3000` from your phone while on the same WiFi.

> If you also run the Zakka Autoparts system locally on the same port, your browser can get confused between the two (it remembers an "offline app" for that address and keeps showing the wrong one). If that happens: open DevTools (⌥⌘I in Chrome) → Application tab → Service Workers → Unregister, then reload. Easiest fix is just running them on different ports, e.g. `PORT=3001 npm start` for this app.

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
