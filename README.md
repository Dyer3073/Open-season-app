# Open Season — Private Group App (standalone)

The Da Boyz year-long hunt, as a portable web app: invite-only league chat + kill feed, hunt board, kill claims with confirm/dispute, Reverse Kill cards, safe zones, opt-in location sharing, and a Marine career rank system (XP / Recruit → Sergeant Major). Black-and-orange, mobile-first, installable to the home screen. Zero npm dependencies — one Node.js server.

This is the standalone deployable build (the Muse prototype/private app stays where it is; this folder is a fresh portable implementation of the same locked rules).

## Run it locally

```bash
node server.js            # http://localhost:3000
PORT=3100 DATA_DIR=/tmp/os-data node server.js
```

## Deploy to Render (exact steps)

1. **Push this folder to a Git repo** (GitHub is easiest): make this folder the repo root, `git init && git add . && git commit -m "Open Season app"`, create an empty GitHub repo, push. (Alternatively use Render's Docker deploy with the included `Dockerfile`.)
2. In Render (Christian's account): **New + → Web Service → connect the repo**. Render reads `render.yaml` if you choose "New + → Blueprint" — that is the fastest path and pre-fills everything below.
3. If configuring by hand: Runtime **Node**, Build command `npm install --omit=dev` (no dependencies, so it's instant), Start command `npm start`, Plan **Free** to start.
4. **Environment variables** (Render → service → Environment):
   - `LEAGUE_CODE` = `BOYZ-2027`
   - `DATA_DIR` = `/var/data`
   - `ADMIN_RESET_CODE` = a secret only Christian knows (founder emergency: clears all other claims/PINs via the admin panel API). Don't commit it anywhere.
   - `SEASON_START_ISO` (optional) — defaults to Jan 1, 2027, midnight EST.
5. **⚠ Persistent storage — read this before going live.** Render free web services have an **ephemeral filesystem**: league data (claims, chat, kills, XP) is **wiped on every restart, redeploy, and spin-down**. Pick one:
   - **Attach a Render persistent disk** (paid, ~$0.25/GB/mo — 1 GB is plenty): service → Disks → mount path `/var/data`. The lines are pre-written, commented, at the bottom of `render.yaml`.
   - **Or** swap the store: all persistence lives in `lib/store.js` (`load()`/`save()`) — re-implementing those two functions against a hosted Postgres (e.g. Render Postgres / Neon free tier) makes the app disk-independent. Nothing else in the codebase touches the filesystem.
6. Deploy, open the Render URL on a phone, and walk the roster through claiming (below).

### Free-tier caveats (known, accepted)
- **Sleep on idle:** free web services spin down after ~15 min without traffic; the next open takes ~30–60 s to wake. Fine for a 16-man league; a $7/mo Starter instance removes it.
- **Ephemeral disk:** see step 5 — the real risk. Until the disk/DB choice is made, treat the free deploy as a test run.
- Location sharing works **while the app is open** (web-app limit), same as designed. Always-on background tracking needs a native app.

## How the league uses it
1. Open the link → **Add to Home Screen** (iPhone: Safari → Share → Add to Home Screen; Android: Chrome ⋮ → Add to Home screen).
2. Pick your name, enter the league code `BOYZ-2027`, set a PIN (4+ characters) — that claims your spot. Later visits: same name + PIN to log in.
3. Set safe zones (home/work/church, ~150 m) — inside one, your map pin hides automatically.
4. Turn location sharing on to hunt. **Turning it off mid-season = out** (league rule, enforced by the server).
5. Founder (Christian) / Vice (Twigg) get admin controls in the Rules tab: season setup (platform, class, pot, marked man), combo event wins (+300 XP), manual XP adjusts with a note, disputed-kill settlement, and season close.

## Rules enforced by the server
- Season 1 is in **setup until Jan 1, 2027** — kill claims are locked until go-live (countdown in the app).
- Kill claim → victim **confirms** or **disputes** → Founder/Vice settles disputes (an admin who is a party to the kill can't settle it). Stealth killers stay hidden until confirmation.
- On a confirmed kill: killer **+100** (stealth **+125**), **+50** bonus if the victim was the marked man; victim **−75** and out.
- **Reverse Kill:** one card per player per season; the victim has **24 hours** from confirmation to play it — killer dies instead (−75), victim scores it as his own kill (**+150**). Killer may **counter-reverse** within 24 hours with his own card: the original kill stands, the victim is charged the death (−75) **again**, the killer is **not** paid again, both cards are spent. Reversed XP is **never clawed back**. (No Reverse at the Reckoning — the Reckoning itself is settled off-app and recorded via Close Season.)
- **Career XP / Marine ranks** (never reset by seasons): Recruit 0 · Boot 100 · Private 250 · PFC 450 · Lance Corporal 700 · Corporal 1,000 · Sergeant 1,400 · Staff Sergeant 1,900 · Gunnery Sergeant 2,500 · Master Sergeant 3,200 · First Sergeant 4,000 · Master Gunnery Sergeant 5,000 · Sergeant Major 6,500. Deaths can demote, but XP never goes below 0 and a **fresh promotion is protected** from demotion on the very next death. Combo event win **+300**, Last Man **+500**, Deadliest Man **+250** — paid at season close; career XP survives the reset. Every XP change is in the ledger (Founder/Vice can view it via the API state).
- Watching members (Bryce) can claim, chat, and hold rank, but can't hunt or be hunted.

## Layout
- `server.js` — HTTP server + all API routes and game rules (zero dependencies)
- `lib/xp.js` — rank ladder, XP table, demotion/protection logic, ledger writes
- `lib/store.js` — the one swappable persistence module (JSON file under `DATA_DIR`, seeded roster on first boot)
- `public/` — the PWA (map uses Leaflet + CARTO dark tiles, with a built-in no-tiles fallback grid)
- `Dockerfile`, `render.yaml` — deploy configs
