# Fit Cube ERP

A client, session, schedule and small-inventory manager for Fit Cube (Anthony Zakka — personal training & physical therapy). Built to run on your phone, online or offline, at $0 hosting cost.

## What's in this first version

- **Clients** — every client from your paper/notes tracker has already been imported, with names, unpaid balances, and prepaid session credits, using your own legend (🟢 prepaid, 🔴 unpaid, ⚡️ EMS, 🦵 Presso Therapy, 😊 kids, -$X owed, -$X(N) = N unpaid sessions at $X, $X = paid in advance).
- **Session log** — log each session as prepaid credit, unpaid, or paid now; tag EMS / Presso / kids; see a running balance per client; one tap to mark a session paid.
- **Schedule** — book appointments per client and service, mark done/cancelled.
- **Stock** — track products, quantities, cost/sale price, low-stock warning.
- **Sales & Purchases** — record a sale (deducts stock) or a restock purchase (adds stock).
- **Works offline** — the app keeps working with no signal (in the gym, on the road). Anything you add or change offline is saved on your phone and sent to the server automatically the next time you're online — nothing is lost, and you see the change on screen right away rather than having to go back online first to see it.
- **Installable on your phone** — add it to your home screen and it behaves like a normal app, no App Store needed. Uses your Fit Cube logo as the icon.
- **Revenue by service** — the Sales tab shows total revenue broken down by service (PT, EMS, Presso, etc.) and top-selling products, so you can see what's actually making money.
- **One-tap backup, plus an automatic one you don't have to remember** — ⚙ Settings → Data & backup saves your entire database (clients, sessions, balances, products, sales) to your phone or Google Drive. The server also keeps its own automatic snapshots roughly once a day (⚙ Settings → Automatic backups), so your data is never only as safe as the last time someone remembered to tap the button. See "Protecting your data" below — do a manual one regularly too.
- **Light and dark mode** — follows your phone's system setting automatically; tap the ☾/☀ button top-right to override it. Remembered per device.
- **Settings** — the ⚙ button top-right holds your account, staff accounts, backups, activity and message templates in one place.
- **Sort/find clients your way** — on the Clients tab: A–Z, Most active (by session count), or Not coming anymore (longest since their last session first, with an "at risk" tag once it's been 30+ days). Each client also shows "Last session: Xd ago" so you can spot who's drifted away at a glance. Search is a plain type-as-you-go box (not a dropdown) and ignores capitalization — searching a first name, last name, or part of either all work.
- **WhatsApp reminders** — a "Remind" button on upcoming appointments (and a general "WhatsApp" button on each client) opens WhatsApp directly with the message pre-written — one tap to send, no browser involved, $0. See "WhatsApp reminders" below for the fully-automatic upgrade option.
- **Add clients from your Contacts** — wherever there's a phone field (adding a client, adding a new client inline from the Schedule tab) there are two ways to get a number in without typing it. On Android, "Choose from Contacts" opens the address book directly. On iPhone, Apple blocks web apps from browsing Contacts, so instead: (1) tap the Name or Phone box and pick **AutoFill Contact** above the keyboard — that opens your contact list and fills both fields (needs Settings → Safari → AutoFill → Contact Info switched on); or (2) copy a number in the Contacts app and tap **Paste number from Contacts**. When editing an existing client, AutoFill Contact still works the same way — there's just no paste button there, to keep that screen simpler. Or use the Shortcut below, which is the closest thing to a real contact picker.

### iPhone: one-tap "add this contact as a client" (optional, 2 minutes to set up)

Apple won't let the app read Contacts, but it *will* let a Shortcut do it and hand the result over. Set this up once and adding a client becomes: run the Shortcut → pick the contact → the app opens with the name and number already filled in.

1. Open the **Shortcuts** app → **+** to create a new shortcut.
2. Add the action **Select Contact** (search "contact").
3. Add **Get Details of Contacts** → set it to **Phone Number**, with "Select Contact" as its input.
4. Add **Text**, and set its content to (using the magic-variable picker for the two variables):
   `https://fitcube-erp.onrender.com/#/clients/new?name=[Select Contact]&phone=[Phone Number]`
5. Add **Open URLs**, with that Text as its input.
6. Name it something like "Add Fit Cube client" and, from the shortcut's settings, **Add to Home Screen** so it sits next to the app.

The app accepts `#/clients/new?name=…&phone=…` from anywhere, so this also works from a link, a QR code, or the Share sheet.
- **Search everywhere it matters** — Clients, Stock, and Schedule all have a plain type-as-you-go search box, and the Schedule tab's "New appointment" screen lets you search for a client by name instead of scrolling a list — with "+ Add new client" and "+ Add new service" right there if either doesn't exist yet, so a booking never has to be interrupted.
- **Progress photos** — every client page has a photo strip for before/after and progress shots. Tap + to add one (or take one on the spot with your phone's camera); photos are automatically resized and compressed in your browser before upload, so this stays fast and light. Tap any photo to see it full-size, add a caption, or delete it.
- **Preferred music, one tap away** — paste a client's Spotify, Anghami, SoundCloud, or YouTube playlist link on their profile (when adding or editing a client), and a "Play on [App]" button appears on their page that opens it directly — handy for starting their playlist right as a session begins.
- **Overview kept simple, the full breakdown moved to Accounting** — the Overview tab shows just the handful of numbers worth checking every day (appointments today, active clients, unpaid balance, prepaid credits, and — owner only — profit). Below that, "Quick actions" is a row of big square tiles (View clients, Schedule, Accounting for the owner, Message templates) sized for an easy tap on a phone screen. An "Accounting" tile/button (owner only, on Overview and in ⚙ Settings) opens a separate page with everything money-related: total revenue, gross profit (all revenue minus what sold products actually cost you), the full profit & loss breakdown, money spent restocking, current inventory value at cost, and revenue by service.
- **Revenue &amp; profit at a glance, owner only** — Overview shows total revenue and total profit made all time, side by side, plus a Today / This week / This month / This year toggle right below them for however you want to check in — tap a period and both numbers update together. Profit here is revenue minus cost of goods sold, the same definition used on the Accounting page — this is just a faster way to see it without leaving Overview. Staff accounts never see any of this, on the server as well as in the UI.
- **Sell session packages / bundles, your own pricing** — ⚙ Settings → Session packages lets you set up whatever bundle pricing you want — "1 session" for $30, a "10-pack" for $450, a "12-pack" for $500, as many as you like, edited or deleted any time. From any client's page, "Sell a package" picks one of those (or a one-off custom name/count/price on the spot) and in one step adds that many prepaid session credits to the client and books the price as revenue — showing up immediately in Accounting and in the Overview revenue/profit numbers. Every package sold to a client is listed on their page under "Packages sold." Works offline too: the credits and the sale show up on the client's page right away and sync once you're back online.
- **Import clients from a file** — ⚙ Settings → Import clients accepts a CSV of contacts (name, phone — most phone/contacts exports work as-is). It matches by name against your existing client list: fills in a missing phone number for someone already in the system, leaves anyone who already has a phone alone, and adds anyone new. If two different names in the file share one phone number (a household on one line, say) it flags that in the results instead of guessing who's who — nothing is ever merged automatically.
- **Client count and a duplicate check** — the Clients tab shows how many clients you have right under the title, and the "Active clients" number on Overview is a button through to that list. ⚙ Settings → Check for duplicate clients scans everyone for the same name appearing twice, or the same phone number under two different names, and lets you jump straight to each one to review — nothing is ever merged for you automatically.
- **Client goals** — a free-text goal field on every client (e.g. "Lose 5kg by December", "Fix squat form") shown right on their page, set when adding or editing a client.
- **Progress metrics** — log weight, body fat %, and chest/waist/hips/arm/thigh measurements per client, dated however often you actually measure them (daily, weekly, whatever) — a "+ Log weight / measurements" button on their page. A small trend line appears automatically once there are two or more weigh-ins, so you can see the direction at a glance.
- **Reminders with editable templates** — a "Remind" button on every client's page (next to their contact info) opens a message composer: pick a template (it auto-picks Payment reminder if they owe money, Session reminder if they've got something coming up), the message is pre-filled with their name/service/date/balance, and you can still edit it before sending. "Manage message templates" (also in ⚙ Settings) lets you edit the wording of the built-in templates or add your own — just use `{name}`, `{service}`, `{when}`, `{amount}` anywhere you want those filled in automatically.

## Who can get in

The app is locked. Opening the address without signing in shows nothing but a sign-in box — no clients, no phone numbers, no balances. That isn't just the screen hiding things: the server refuses every request for data unless it recognises your account, so knowing the link gets someone precisely nowhere.

**The very first time you open it after this update, it will ask you to create your owner account.** Do that immediately — until you do, the app is unclaimed, and whoever opens it first becomes the owner. Pick a password you don't use anywhere else and don't lose it; there's no reset email to fall back on.

- **Staff accounts** — the ⚙ button top-right → **Staff & access** → *Add a staff account*. Staff can run the day to day: clients, sessions, schedule, stock, sales, photos, measurements, reminders. They **cannot** see revenue, profit, or the revenue-by-service report, take or restore backups, or manage accounts. That's enforced on the server, so it holds no matter what someone does in their browser.
- **Someone leaves** — *Manage* → **Suspend**. They're signed out of every device instantly and can't sign back in. *Remove* deletes the account outright.
- **A phone goes missing** — change your own password (⚙ → Change my password). That signs out every other device you were signed in on.
- **Who did what** — ⚙ → **Recent activity** shows the last 200 changes and which account made each one.
- Staying signed in lasts 30 days per device, so you're not typing a password before every session.

Under the hood, for the record: passwords are stored as salted scrypt hashes (never the password itself), the session cookie is HttpOnly and SameSite so no script or other website can lift it, sessions live server-side so revoking one takes effect at once, sign-in attempts lock out after 8 wrong guesses, the browser is told to load nothing from outside this app, and the site asks search engines not to index it.

## WhatsApp reminders

**Default, $0, works right now:** tapping "Remind" builds the message and opens WhatsApp itself (not a browser tab) with it pre-filled — you just hit send. No setup needed, and this always works as a fallback even if you set up the option below.

**Optional upgrade — fully automatic sending, no tap needed:** this requires Meta's WhatsApp Cloud API, which means: a Meta Business account, a WhatsApp Business phone number, and an approved message template (Meta reviews the exact wording before it can be used for reminders — takes anywhere from minutes to a couple of days). As of October 2026, Meta also started charging a small per-message fee for these (roughly $0.004–$0.016 depending on the recipient's country) — there's no longer a free tier for business-initiated messages like appointment reminders, so this is no longer strictly $0, but it's close (a few cents per day of reminders). If you want to set this up:

1. Create a Meta Business + WhatsApp Business Platform account at developers.facebook.com/products/whatsapp.
2. Get a phone number ID and a permanent access token.
3. Submit a message template named `session_reminder` (or set `WHATSAPP_TEMPLATE_NAME` to whatever you name it) for approval, with a body like: `Hi {{1}}, reminder from Fit Cube: your {{2}} is on {{3}}. See you then!`
4. Set `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` (and `WHATSAPP_TEMPLATE_NAME`/`WHATSAPP_TEMPLATE_LANG` if different) as environment variables.

Once those are set, "Remind" sends automatically with no app-switching at all. Leave them unset and everything still works via the free WhatsApp-app-opening method above — nothing breaks either way.

## If the app looks out of date after an update

Because this is an installable offline-capable app, your phone keeps a cached copy of it so it still works with no signal — that's the whole point, but it means a brand-new version sometimes takes an extra moment to show up. If you ever add a feature and don't see it: fully close the app (swipe it away, don't just background it) and reopen it once while you have signal. That's normally all it takes — the app checks for a new version in the background and swaps it in automatically the next time you open it.

## Protecting your data

No hosting setup is 100% bulletproof, so this app gives you a backup you fully control on top of everything else:

- **Save backup** (⚙ Settings → Data & backup) makes a complete snapshot of everything — clients, sessions, balances, photos, metrics, products, sales — and opens your phone's share sheet with it. From there, **Save to Files** puts a copy on the phone itself and **Google Drive** uploads it to your Drive; tap the button twice to do both. On a computer it just downloads the file instead. Takes about ten seconds.
- **It reminds you — in Settings, not on Overview.** The app remembers when you last saved a backup. Open ⚙ Settings and, if it's been more than a week (or you've never saved one), a warning card sits right at the top of Data & backup; otherwise it's just a quiet status line. Overview itself never carries this warning, so it stays the day-to-day screen and doesn't turn into a permanent nag.
- **Restore from backup** (same place) loads a backup file back in — useful if a device is lost, or if you want to move the app to different hosting later. The file picker can reach anywhere your phone can, including Files and Google Drive, so a backup you saved to Drive can be restored straight from Drive. It replaces everything currently in the database, so it asks you to confirm first.
- **Automatic backups, no one has to remember them** (⚙ Settings → Automatic backups) — the server itself takes a full snapshot roughly once a day and stores it in Turso, separate from the app host, keeping the most recent 14. This is a second, independent safety net: even if a manual backup is never tapped, data isn't lost to a bad deploy, an accidental bulk change, or anything short of losing the Turso database itself. Each snapshot in the list can be saved as a file (same Files/Drive share sheet as a manual backup) or restored directly.
- If you deploy to Turso (below), that service also keeps its own rolling backup automatically (1 day of point-in-time restore on the free tier) — a third safety net on top of the app's own automatic snapshots and your manually-downloaded copies.
- The offline copy on your phone (in the app itself) is a working cache, not a backup — it's convenience for when you have no signal, not a substitute for a real backup.

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
