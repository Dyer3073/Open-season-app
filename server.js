'use strict';

// Open Season — Private Group App (standalone, zero-dependency)
// One Node http server: JSON API + static PWA from /public.
// All game rules are enforced here, server-side. Persistence via lib/store.js.
//
// Round 2 (Nov 7, 2026): the Reverse Kill card is RETIRED. In its place, the
// KILL CANCEL card: played by a victim on a confirmed kill, it VOIDS the kill
// (offsetting ledger entries claw back the kill/stealth XP, the marked-man
// bonus, the victim's death charge, and any collected bounty — which returns
// to the board) and shields the victim with 24h of immunity. The killer may
// burn his OWN Kill Cancel to OVERRIDE: the kill re-stands (effects
// re-credited, death re-charged, bounties re-collected), both cards spent.
// Plus: danger proximity alerts, kill proof photos, days survived, callsigns
// + emoji avatars, feed reactions, end-of-season superlatives, a first-open
// walkthrough flag, and one-tap invite support on the client.
//
// Round 3 (Nov 7, 2026): Founder/Vice league BACKUP / RESTORE — the whole
// store state (plus the file-based VAPID keypair) downloads as one versioned
// JSON file and restores atomically after validation, as insurance against
// free-tier storage wipes. See buildBackup()/validateBackup() and the admin
// routes.
//
// Round 4 (Nov 7, 2026): SAFE-ZONE ANNOUNCEMENTS — entering one of your safe
// zones now tells the league (feed entry + a public status showing the zone
// LABEL — home/work/church — while your coordinates still never leave the
// server), and AUTOMATIC DRIVING MODE — sustained speed over ~20 mph across
// 2 consecutive fixes (device-reported coords.speed, or a position-derived
// estimate when the device reports none) hides your pin, posts one "🚗 is
// driving" feed entry per trip, and rejects kill claims against you until
// you stop. Driving is a third state beside the manual sharing toggle: it
// never eliminates anyone, in a live season or in scrimmage. Detection only
// works while the app is open — the same web-app limit as all location here.
//
// Round 5 (Nov 7, 2026): BACKUP REMINDER — every admin backup download
// stamps league.lastBackupAt; while the season is live (or a scrimmage is
// running) Founder/Vice payloads carry a `backup` block whose `stale` flag
// turns true when the last backup is missing or over 7 days old, with a
// per-admin 24h snooze. And a TEST PUSH endpoint (POST /api/push/test):
// any claimed hunter can send the canned test notification to his OWN
// subscriptions only, and gets the targeted/accepted counts back.
//
// Round 6 (Nov 7, 2026): HUNT MODE — the in-app answer to the web-app
// location limit (location only updates while the app is open on screen).
// A hunter flips the My Card toggle when he heads out: the client keeps
// the screen awake (Wake Lock) and the GPS hot, and the off→on transition
// fires ONE ANONYMOUS push blast to every other claimed hunter — "⚠️
// Someone's hunting" — plus one anonymous feed entry, at most once per
// hunter per 30 minutes, and only while the hunt is open (live season or
// scrimmage). The 🎯 hunting marker in payloads is computed server-side
// from pin freshness (a fix within 10 minutes) — a persisted flag alone
// is never trusted, so closing the app mid-hunt quietly goes stale: no
// elimination, no feed spam. Hunt Mode never overrides safe zones or
// driving mode.
//
// Round 7 (Nov 7, 2026): LEAGUE PING + LOCATION CHECK. The ping is the
// social nudge: any claimed, alive, non-watching hunter can push every
// other hunter in the game once an hour ("open the app and update your
// location") with a named feed entry. The Location Check is the
// Founder/Vice enforcement version: an admin calls it (live season —
// targets are the alive hunters with sharing ON; scrimmage — everybody
// in, practice only), the settings (reminder interval + deadline) are
// SNAPSHOT at the start, targets check in by posting any fix (safe-zone
// and driving fixes count — the server sees them even when the pin is
// hidden), a timestamp-driven scheduler tick sends interval reminders
// to stragglers only and, at the deadline, eliminates live stragglers
// with NO XP change (it is not a kill) while a scrimmage call just
// names who would have been out. The tick computes everything from
// stored timestamps, so a sleeping free-tier server catches up with at
// most one reminder per straggler instead of bursting.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const { RANKS, XP, rankFor, applyXp, deathXp, uid } = require('./lib/xp');
const { ACHIEVEMENTS, achievementsFor } = require('./lib/achievements');
const push = require('./lib/push');

const PORT = process.env.PORT || 3000;
const LEAGUE_CODE = process.env.LEAGUE_CODE || 'BOYZ-2027';
const ADMIN_RESET_CODE = process.env.ADMIN_RESET_CODE || ''; // founder emergency reset (set in Render env)
const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const IMMUNITY_MS = 24 * 60 * 60 * 1000;
const DANGER_RADIUS_M = 1609.34; // 1 mile
const DANGER_COOLDOWN_MS = 30 * 60 * 1000;
// Safe-zone entry announcements: at most one per stay, and a re-entry inside
// this cooldown stays quiet (GPS boundary jitter). Env-overridable so the
// test suite can exercise the cooldown without waiting 15 real minutes.
const ZONE_ANNOUNCE_COOLDOWN_MS = Number(process.env.ZONE_ANNOUNCE_COOLDOWN_MS) || 15 * 60 * 1000;
// Driving mode thresholds (m/s): enter above ~9 (≈20 mph), exit below ~2.
const DRIVE_ENTER_MPS = 9;
const DRIVE_EXIT_MPS = 2;
const PHOTO_MAX_BYTES = 2.5 * 1024 * 1024; // ~2.5 MB decoded
const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
// League backup/restore (Round 3): a backup IS the state file plus a wrapper,
// and proof photos dominate its size (each ≤2.5 MB stored base64). The cap is
// deliberately generous — its job is rejecting garbage/abuse, not rationing a
// 16-man league. Env-overridable so tests can exercise the rejection cheaply.
const RESTORE_MAX_BYTES = Number(process.env.RESTORE_MAX_BYTES) || 200 * 1024 * 1024;
// Backup reminder (Round 5): a backup older than this — or none at all —
// is "stale" while the hunt is on; the reminder snoozes per admin for a day.
const BACKUP_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUP_SNOOZE_MS = 24 * 60 * 60 * 1000;
// Hunt Mode (Round 6): a pin is "fresh" for 10 minutes (same rule the
// client uses to grey stale pins); the hunt-start blast fires at most
// once per hunter per 30 minutes. Env-overridable so the test suite can
// exercise the cooldown without waiting half an hour.
const PIN_FRESH_MS = 10 * 60 * 1000;
const HUNT_BLAST_COOLDOWN_MS = Number(process.env.HUNT_BLAST_COOLDOWN_MS) || 30 * 60 * 1000;
// League ping + Location Check (Round 7): one ping per hunter per hour;
// the check scheduler ticks every ~30 s and works purely off stored
// timestamps (sleep-resilient). Both env-overridable for the test suite.
const PING_COOLDOWN_MS = Number(process.env.PING_COOLDOWN_MS) || 60 * 60 * 1000;
const CHECK_TICK_MS = Number(process.env.CHECK_TICK_MS) || 30 * 1000;
// PIN login throttle (Round 10): after LOGIN_MAX_FAILS wrong PINs inside
// the window, that player's login locks for LOGIN_LOCK_MS. Counters live
// on the player record, so they persist across restarts like everything
// else in the store.
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
// Push endpoint allowlist (Round 10): a stored subscription endpoint is a
// URL this server POSTs to with a signed VAPID Authorization header, so
// it must be a real push service — https only, never a private/loopback
// address literal, host on (or under) one of these vendor domains.
// PUSH_ALLOW_INSECURE_ENDPOINTS=1 disables the check; the TEST SUITE
// sets it to talk to its localhost fake push service — production never
// should.
const PUSH_HOST_SUFFIXES = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const REACTION_EMOJIS = ['🔥', '🦆', '🏆', '😂'];

let state = store.load();
const save = () => store.save(state);

// ── Round 10 safety net ──────────────────────────────────────────────────────
// Ending a scrimmage wipes state.kills and resurrects the whole board
// (resetPracticeBoard, below — it IS the practice reset). That makes a
// scrimmage flag sitting on a LIVE season a loaded gun: one admin toggle
// would erase real confirmed kills while their XP stayed on the books.
// The scrimmage route now refuses to START outside setup; this net is
// the second line of defense for a flag that arrives any other way (an
// old save, a hand-edited store, a doctored restore): if the league is
// loaded — or rendered — with scrimmage on while the season is live, the
// scrimmage is auto-ended with the normal practice-board reset, exactly
// once, before any live kill can exist under it. The flag flipping off
// is what makes it exactly-once: every later pass sees scrimmage false.
function resetPracticeBoard() {
  state.league.checkCall = null; // a running Location Check dies quietly with the scrimmage — no eliminations
  state.kills = [];
  state.dangerPairs = {};
  state.players.forEach(p => { p.alive = true; p.out = false; p.scrimmageKills = 0; p.killCancelCard = true; p.immuneUntil = null; p.diedAt = null; p.sharing = false; p.position = null; p.zoneStatus = null; p.driving = false; p.drvFast = 0; p.drvSlow = 0; p.lastFix = null; p.hunting = false; p.huntStartedAt = null; });
}
function autoEndLiveScrimmage() {
  if (!state.league.scrimmage || phase() !== 'live') return;
  state.league.scrimmage = false;
  resetPracticeBoard();
  feed('system', '🏋 SCRIMMAGE AUTO-ENDED — a practice flag was found on a live season and was cleared with a practice-board reset before it could touch the real board. Career XP untouched.', null);
  save();
  console.warn('Open Season: auto-ended a scrimmage flag found on a live season.');
}
autoEndLiveScrimmage();

// ── helpers ──────────────────────────────────────────────────────────────────
function phase() {
  if (state.league.phase === 'closed') return 'closed';
  return Date.now() >= Date.parse(state.league.seasonStart) ? 'live' : 'setup';
}
function playerById(id) { return state.players.find(p => p.id === id) || null; }
function nameOf(id) { const p = playerById(id); return p ? p.name : 'Unknown'; }
function hashPin(pin, id) { return crypto.createHash('sha256').update(String(pin) + '::' + id).digest('hex'); }
// PIN storage (Round 10): NEW hashes are scrypt with a per-player random
// salt, stored self-describing as `scrypt:<saltHex>:<hashHex>` so the
// verifier can tell formats apart forever. LEGACY hashes (a bare SHA-256
// hex of `pin::playerId`, salt = the public roster id) still verify —
// old backups restore them and those logins must keep working — and a
// successful legacy login upgrades the stored hash on the spot.
function newPinHash(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPin(pin, p) {
  if (!p || !p.pinHash) return false;
  if (String(p.pinHash).startsWith('scrypt:')) {
    const parts = String(p.pinHash).split(':');
    if (parts.length !== 3) return false;
    try {
      const expected = Buffer.from(parts[2], 'hex');
      const actual = crypto.scryptSync(String(pin), Buffer.from(parts[1], 'hex'), expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (_) { return false; }
  }
  return p.pinHash === hashPin(pin, p.id); // legacy SHA-256 (pre-Round-10 saves and backups)
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// The FIRST of the hunter's safe zones containing his current fix, or null.
function matchingSafeZone(p) {
  if (!p.position) return null;
  return p.safeZones.find(z => haversineM(p.position.lat, p.position.lng, z.lat, z.lng) <= (z.radius || 150)) || null;
}
function inOwnSafeZone(p) { return !!matchingSafeZone(p); }
// Recompute a hunter's PUBLIC safe-zone presence from his latest fix. The
// status carries the zone label only — the zone's coordinates (and his) never
// enter anyone else's payload; the pin stays hidden exactly as before.
// Entering a zone announces it to the feed, at most once per continuous stay
// and never twice inside the announcement cooldown, so a fix jittering on a
// zone boundary can't spam the league. Leaving all zones clears the status
// silently — the status disappearing is signal enough.
function updateZoneStatus(p) {
  const zone = matchingSafeZone(p);
  if (zone) {
    const label = String(zone.label || '').toUpperCase();
    if (!p.zoneStatus || p.zoneStatus.zoneId !== zone.id) {
      p.zoneStatus = { zoneId: zone.id, label, since: new Date().toISOString() };
      const now = Date.now();
      if (now - (p.lastZoneAnnounceAt || 0) >= ZONE_ANNOUNCE_COOLDOWN_MS) {
        p.lastZoneAnnounceAt = now;
        feed('safezone', `🛡 ${p.name} is at a safe zone — ${label}`, p.id);
      }
    }
  } else if (p.zoneStatus) {
    p.zoneStatus = null;
  }
}
// Speed of a fix in m/s: the device-reported speed (Geolocation
// coords.speed, forwarded by the client) when present; otherwise a
// position-derived estimate — haversine distance from the previous fix over
// the elapsed time. null when neither is available (first fix, no delta).
function fixSpeed(p, body, lat, lng, now) {
  if (typeof body.speed === 'number' && Number.isFinite(body.speed) && body.speed >= 0) return body.speed;
  if (p.lastFix && now > p.lastFix.t) {
    return haversineM(p.lastFix.lat, p.lastFix.lng, lat, lng) / ((now - p.lastFix.t) / 1000);
  }
  return null;
}
// Driving-mode state machine. ENTER: speed above DRIVE_ENTER_MPS on 2
// consecutive fixes. EXIT: speed below DRIVE_EXIT_MPS on 2 consecutive
// fixes. A mid-range fix resets both streaks, so the speed must be
// SUSTAINED. Entering posts exactly one feed entry per trip; exiting is
// silent. Nothing here touches alive/out/sharing — driving can never
// eliminate anyone; only the manual toggle in /api/sharing does that.
function updateDriving(p, speed) {
  if (speed === null || speed === undefined) return;
  if (speed > DRIVE_ENTER_MPS) { p.drvFast = (p.drvFast || 0) + 1; p.drvSlow = 0; }
  else if (speed < DRIVE_EXIT_MPS) { p.drvSlow = (p.drvSlow || 0) + 1; p.drvFast = 0; }
  else { p.drvFast = 0; p.drvSlow = 0; }
  if (!p.driving && p.drvFast >= 2) {
    p.driving = true;
    feed('driving', `🚗 ${p.name} is driving`, p.id);
  } else if (p.driving && p.drvSlow >= 2) {
    p.driving = false;
  }
}
function isImmune(p) { return !!(p && p.immuneUntil && Date.parse(p.immuneUntil) > Date.now()); }
// Hunt Mode freshness (Round 6): the persisted `hunting` flag alone is
// NEVER trusted for display — the hunter only reads as hunting while he
// also has a position fix no older than PIN_FRESH_MS. Close the app
// mid-hunt and the marker quietly goes stale with the pin; nothing is
// eliminated and nothing is posted.
function isFreshHunting(p) {
  if (!p || !p.hunting || !p.position) return false;
  const ts = Date.parse(p.position.ts);
  return Number.isFinite(ts) && Date.now() - ts <= PIN_FRESH_MS;
}
// ── Location Check machinery (Round 7) ───────────────────────────────────────
// A target checks in by posting ANY position fix at or after the call
// started. The server receives every fix — including ones whose pin is
// hidden by a safe zone or driving mode — so those hunters check in
// exactly like everyone else. Check-ins are stamped onto the call the
// first time they're observed (position posts, scheduler ticks, and
// payload builds all look), so a fix survives later sharing toggles.
function lastFixMs(p) {
  if (!p || !p.position) return 0;
  const ts = Date.parse(p.position.ts);
  return Number.isFinite(ts) ? ts : 0;
}
function refreshCheckIns(call) {
  if (!call) return false;
  let changed = false;
  for (const t of call.targets) {
    if (t.checkedInAt) continue;
    const p = playerById(t.id);
    if (p && lastFixMs(p) >= call.startedAtMs) { t.checkedInAt = p.position.ts; changed = true; }
  }
  return changed;
}
// The public view of the active call: who called it, when the deadline
// lands, the snapshot settings, and each target's check-in status.
// NEVER any location data — no positions, no zones, no coordinates.
function publicCheckCall() {
  const call = state.league.checkCall;
  if (!call) return null;
  refreshCheckIns(call);
  return {
    startedBy: call.startedBy,
    startedByName: nameOf(call.startedBy),
    startedAt: call.startedAt,
    deadlineAt: call.deadlineAt,
    intervalMin: call.intervalMin,
    deadlineMin: call.deadlineMin,
    mode: call.mode,
    targets: call.targets.map(t => {
      const p = playerById(t.id);
      return {
        id: t.id, name: nameOf(t.id),
        checkedIn: !!t.checkedInAt, checkedInAt: t.checkedInAt || null,
        out: p ? (!p.alive || p.out) : true,
      };
    }),
  };
}
// Deadline elimination for a check-in timeout. The out state is the same
// as any other elimination (sharing-off included), with the reason
// recorded — but NO XP moves: a timeout is not a kill, so there is no
// death charge, no killer credit, and the ledger is never touched.
function eliminateCheckTimeout(p) {
  p.alive = false;
  p.out = true;
  p.diedAt = new Date().toISOString();
  p.outReason = 'check-in timeout';
  p.hunting = false; p.huntStartedAt = null; // an elimination ends any hunt in progress
  feed('check', `☠️ ${p.name} never checked in — OUT.`, p.id);
  notify(p, '🏹 Open Season', "☠️ You didn't check in — you're OUT.", 'check-out');
}
// The scheduler. Everything is computed from stored timestamps, so if
// the process slept (Render free tier idles out), the first tick after
// it wakes sends AT MOST ONE catch-up reminder per straggler — never a
// burst of the missed ones — and then applies the deadline if it passed.
function tickCheckCall() {
  const call = state.league.checkCall;
  if (!call) return;
  // The ground moved under the call (scrimmage ended, season closed,
  // a restore rewound the league): close it quietly, no eliminations.
  if ((call.mode === 'scrimmage' && !scrimmage()) || (call.mode === 'live' && phase() !== 'live')) {
    state.league.checkCall = null;
    save();
    return;
  }
  let dirty = refreshCheckIns(call);
  const now = Date.now();
  // Resolve targets who are settled one way or the other: checked in,
  // or eliminated by other means mid-call (a confirmed kill, sharing
  // off) — the deadline must never process those men a second time.
  for (const t of call.targets) {
    if (t.done) continue;
    const p = playerById(t.id);
    if (!p || !p.alive || p.out) { t.done = true; t.outcome = 'out-other'; dirty = true; }
    else if (t.checkedInAt) { t.done = true; t.outcome = 'checked-in'; dirty = true; }
  }
  const stragglers = call.targets.filter(t => !t.done);
  if (now >= call.deadlineAtMs) {
    if (call.mode === 'live') {
      for (const t of stragglers) {
        const p = playerById(t.id);
        if (p) eliminateCheckTimeout(p);
        t.done = true; t.outcome = 'check-timeout';
      }
    } else {
      const names = stragglers.map(t => nameOf(t.id));
      feed('check', names.length
        ? `📍 Scrimmage check over — ${names.join(', ')} would have been out.`
        : '📍 Scrimmage check over — everyone checked in.', null);
    }
    state.league.checkCall = null; // the call is over either way — processed exactly once
    save();
    return;
  }
  if (stragglers.length && now - (call.lastReminderAtMs || call.startedAtMs) >= call.intervalMin * 60000) {
    const remainingMin = Math.max(1, Math.ceil((call.deadlineAtMs - now) / 60000));
    for (const t of stragglers) {
      const p = playerById(t.id);
      if (p) notify(p, '🏹 Open Season', `📍 Still waiting — ${remainingMin} min left to check in or you're OUT.`, 'location-check');
    }
    call.lastReminderAtMs = now;
    dirty = true;
  }
  if (dirty) save();
}
// Days a hunter has survived this season: alive hunters count to today, the
// fallen count to the day they fell. Day 1 = the day the season started.
function daysSurvivedFor(p) {
  if (phase() === 'setup' || p.watching) return null;
  const start = Date.parse(state.league.seasonStart);
  if (!Number.isFinite(start)) return null;
  const end = (p.alive && !p.out) ? Date.now() : (p.diedAt ? Date.parse(p.diedAt) : null);
  if (end === null || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 864e5) + 1;
}
function feed(kind, text, playerId, opts = {}) {
  state.messages.push({
    id: uid('msg'), ts: new Date().toISOString(), playerId: playerId || null, kind, text,
    killId: opts.killId || null, onlyFor: opts.onlyFor || null, reactions: {},
  });
}
// Is this host an IP literal in a private / loopback / link-local range?
// Covers dotted-quad IPv4, IPv4-mapped IPv6, and the IPv6 loopback /
// link-local (fe80::/10) / unique-local (fc00::/7) prefixes. A hostname
// (not a literal) returns false — the allowlist below is what gates those.
function isPrivateHostLiteral(host) {
  let h = String(host || '').toLowerCase();
  if (h.startsWith('::ffff:')) h = h.slice(7); // IPv4-mapped IPv6 → check the v4 tail
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
  return false;
}
// May the server store (and later POST to, with a signed VAPID header)
// this subscription endpoint? Only real push services: https, not a
// private address literal, host equal to or under a known vendor domain
// (Apple / Google FCM / Mozilla / Microsoft WNS). Anything else is an
// SSRF-shaped hole, so it is refused at subscribe time.
function pushEndpointAllowed(endpoint) {
  if (process.env.PUSH_ALLOW_INSECURE_ENDPOINTS === '1') return true; // test-suite escape hatch only
  let u;
  try { u = new URL(endpoint); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host || isPrivateHostLiteral(host)) return false;
  return PUSH_HOST_SUFFIXES.some(d => host === d || host.endsWith('.' + d));
}
// Best-effort Web Push — never awaited by routes, never blocks a request.
function notify(player, title, body, tag) {
  if (!player) return;
  push.sendToPlayer(player, { title, body, tag: tag || 'open-season' }, save).catch(() => { });
}
function scrimmage() { return !!state.league.scrimmage; }
// Kills can be claimed when the real season is live OR a scrimmage is running.
function huntOpen() { return scrimmage() || phase() === 'live'; }
function bountyTotalOn(playerId) {
  return state.bounties.filter(b => b.targetId === playerId).reduce((a, b) => a + b.amount, 0);
}
// A confirmed kill collects every active bounty on the victim: the killer is
// paid the total as bonus XP (minted, not taken from the placers) and the
// bounties are consumed. The collected entries are recorded on the kill so a
// Kill Cancel can restore them to the board verbatim. In scrimmage nothing
// is paid or consumed.
function collectBounties(killer, victim, kill) {
  const mine = state.bounties.filter(b => b.targetId === victim.id);
  kill.bountyAmount = 0;
  kill.bountyList = [];
  if (!mine.length || scrimmage()) return 0;
  const total = mine.reduce((a, b) => a + b.amount, 0);
  state.bounties = state.bounties.filter(b => b.targetId !== victim.id);
  kill.bountyAmount = total;
  kill.bountyList = mine.map(b => ({ ...b }));
  applyXp(state, killer, total, 'bounty', `Bounty collected on ${victim.name} (${mine.length} ${mine.length === 1 ? 'bounty' : 'bounties'})`, kill.id);
  feed('bounty', `💰 BOUNTY COLLECTED — ${killer.name} collected ${total} XP in bounties on ${victim.name}.`, killer.id);
  return total;
}
// Achievements pay +25 career XP the FIRST time they unlock. Paid ids persist
// on player.achievementAwards (career-level, never reset), so re-evaluation —
// on any later mutation, refetch, or restart — can never double-pay. Called
// after every mutation that can change a player's stats. Scrimmage writes no
// ledger entries, so scrimmage play can never trigger a payment here. No
// achievement is XP-threshold-based, so these payments can't cascade.
function awardAchievements(player) {
  if (!player) return;
  if (!Array.isArray(player.achievementAwards)) player.achievementAwards = [];
  const { list } = achievementsFor(state, player);
  for (const a of list) {
    if (!a.earned || player.achievementAwards.includes(a.id)) continue;
    player.achievementAwards.push(a.id); // mark FIRST — payment below can't re-enter
    applyXp(state, player, XP.ACHIEVEMENT, 'achievement', `Achievement — ${a.name}`);
    feed('achievement', `🏅 ACHIEVEMENT — ${player.name} unlocked "${a.name}" (+${XP.ACHIEVEMENT} XP).`, player.id);
  }
}
// ── danger proximity alerts ──────────────────────────────────────────────────
// When a hunter's position update lands him within 1 mile of another alive,
// sharing, non-hidden hunter, BOTH get a private feed entry + a Web Push:
// "a hunter is within 1 mile of you" — no name, no direction, no distance.
// At most one alert per pair per 30 minutes. Only while the hunt is open
// (live season or scrimmage); never when either man is safe-zone hidden,
// out, watching, or not sharing.
function checkDanger(me) {
  if (!huntOpen() || !me.position || !me.sharing || me.out || !me.alive || me.watching) return;
  if (inOwnSafeZone(me)) return;
  if (me.driving) return; // a driver is untouchable and his position is hidden — no alerts FROM him
  const now = Date.now();
  for (const q of state.players) {
    if (q.id === me.id || !q.position || !q.sharing || q.out || !q.alive || q.watching) continue;
    if (inOwnSafeZone(q)) continue;
    if (q.driving) continue; // …and no alerts TO anyone about a driver either
    if (haversineM(me.position.lat, me.position.lng, q.position.lat, q.position.lng) > DANGER_RADIUS_M) continue;
    const key = [me.id, q.id].sort().join('|');
    if (now - (state.dangerPairs[key] || 0) < DANGER_COOLDOWN_MS) continue;
    state.dangerPairs[key] = now;
    for (const who of [me, q]) {
      feed('danger', '⚠️ DANGER — a hunter is within 1 mile of you. Eyes up.', null, { onlyFor: who.id });
      notify(who, 'Open Season — ⚠️ hunter near', 'A hunter is within 1 mile of you. No name, no direction — eyes up.', 'danger');
    }
  }
}
function publicPlayer(p, viewer) {
  const isSelf = viewer && viewer.id === p.id;
  const visible = p.sharing && p.position && !inOwnSafeZone(p) && !p.driving && !p.out;
  const rk = rankFor(p.xp);
  const ach = achievementsFor(state, p);
  return {
    id: p.id, name: p.name, role: p.role, watching: p.watching, claimed: p.claimed,
    callsign: p.callsign, avatar: p.avatar,
    xp: p.xp, rank: rk.name, rankMin: rk.min, nextRank: rk.nextName, nextMin: rk.nextMin, progress: rk.progress,
    alive: p.alive, out: p.out, seasonKills: p.seasonKills, scrimmageKills: p.scrimmageKills, sharing: p.sharing,
    // Hunt Mode (Round 6): `hunting` is the PUBLIC marker — fresh-only,
    // computed server-side. The persisted flag + start time + one-time
    // hint flag ride only on the hunter's own record (like killCancelCard).
    hunting: isFreshHunting(p),
    huntingOn: isSelf ? !!p.hunting : undefined,
    huntStartedAt: isSelf ? p.huntStartedAt : undefined,
    huntHintSeen: isSelf ? !!p.huntHintSeen : undefined,
    lastPingAt: isSelf ? (p.lastPingAt || 0) : undefined, // league-ping cooldown (Round 7), self-only
    immuneUntil: isImmune(p) ? p.immuneUntil : null,
    daysSurvived: daysSurvivedFor(p),
    bountyTotal: bountyTotalOn(p.id),
    stats: ach.stats, achievements: ach.list,
    position: visible ? { lat: p.position.lat, lng: p.position.lng, ts: p.position.ts } : null,
    // Safe-zone presence is PUBLIC (the league is told) but label-only: the
    // display label (HOME / WORK / CHURCH), never coordinates. Driving is
    // likewise a public status with the pin hidden. When both apply, the
    // safe-zone label is the one the client displays.
    atSafeZone: p.zoneStatus ? p.zoneStatus.label : null,
    driving: !!p.driving,
    inSafeZone: isSelf ? inOwnSafeZone(p) : false,
    killCancelCard: isSelf ? p.killCancelCard : undefined,
    walkthroughSeen: isSelf ? p.walkthroughSeen : undefined,
    safeZones: isSelf ? p.safeZones : undefined,
  };
}
function publicKill(k, viewer) {
  const hideKiller = k.stealth && k.status === 'pending' && viewer && viewer.id !== k.killerId && viewer.role !== 'Founder' && viewer.role !== 'Vice';
  const party = viewer && (viewer.id === k.killerId || viewer.id === k.victimId || viewer.role === 'Founder' || viewer.role === 'Vice');
  const out = { ...k, killerId: hideKiller ? null : k.killerId, killerHidden: !!hideKiller };
  // Stealth proof photos stay between the parties (and admins) until the kill resolves.
  if (k.stealth && k.status === 'pending' && !party) delete out.photo;
  return out;
}
// Backup staleness, computed per viewing admin (Round 5): only meaningful
// while league data is actually at risk (live season or scrimmage — plain
// setup stays quiet), suppressed for 24h by that admin's own snooze, and
// cleared for everyone the moment a fresh backup is downloaded.
function backupStaleFor(viewer) {
  if (!isAdmin(viewer)) return false;
  if (phase() !== 'live' && !scrimmage()) return false;
  if (viewer.backupSnoozeUntil && viewer.backupSnoozeUntil > Date.now()) return false;
  const last = state.league.lastBackupAt ? Date.parse(state.league.lastBackupAt) : 0;
  return !last || Date.now() - last > BACKUP_STALE_MS;
}
function snapshot(viewer) {
  autoEndLiveScrimmage(); // Round 10 net, render half: a restore can land a live-season scrimmage flag between boots
  const leagueOut = { ...state.league, phase: phase(), cancelWindowHours: 24 };
  delete leagueOut.lastBackupAt; // admin bookkeeping — rides only in the admin `backup` block below
  delete leagueOut.checkCall; // the active Location Check rides as the curated public block below
  delete leagueOut.checkSettings; // Location Check settings are admin-only, below
  return {
    league: leagueOut,
    // Admin-only (Founder/Vice): backup freshness for the reminder banner.
    // Regular hunters never receive this block.
    backup: viewer && isAdmin(viewer)
      ? { lastBackupAt: state.league.lastBackupAt || null, stale: backupStaleFor(viewer) }
      : undefined,
    // Location Check (Round 7): the active call is public (names and
    // check-in status only — never location data); the settings are
    // admin-only; the ping cooldown is a server constant everyone needs
    // to render their button honestly.
    checkCall: publicCheckCall(),
    checkSettings: viewer && isAdmin(viewer) ? { ...state.league.checkSettings } : undefined,
    pingCooldownMs: PING_COOLDOWN_MS,
    me: viewer ? publicPlayer(viewer, viewer) : null,
    players: state.players.map(p => publicPlayer(p, viewer)),
    // Private entries (danger alerts) are visible only to their hunter.
    messages: state.messages.filter(m => !m.onlyFor || (viewer && m.onlyFor === viewer.id)).slice(-300),
    kills: state.kills.map(k => publicKill(k, viewer)),
    bounties: state.bounties.map(b => ({ ...b, targetName: nameOf(b.targetId) || 'Unknown', placedByName: nameOf(b.placedBy) || 'Unknown' })),
    archive: state.archive,
    achievementDefs: ACHIEVEMENTS.map(a => ({ id: a.id, name: a.name, desc: a.desc })),
    ranks: RANKS,
    xpTable: XP,
    xpLog: viewer && (viewer.role === 'Founder' || viewer.role === 'Vice') ? state.xpLog.slice(-200) : undefined,
  };
}
function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-token'];
  if (!t) return null;
  return state.players.find(p => p.token && p.token === t) || null;
}
function isAdmin(p) { return p && (p.role === 'Founder' || p.role === 'Vice'); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // 5 MB ceiling: a kill proof photo arrives as ~3.4 MB of base64 JSON.
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
// Raw-body read for the restore upload only: resolves the body string, the
// sentinel 'too-big' once the cap is passed, or null on a stream error. Past
// the cap it keeps draining but discards (bounded memory) so the client still
// gets a clean 413 response instead of a destroyed socket. The caller parses
// JSON itself so it can answer 400 vs 413 distinctly.
function readRawBody(req, cap) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0, tooBig = false, settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', c => {
      size += c.length;
      if (size > cap) { tooBig = true; chunks.length = 0; return; }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => finish(tooBig ? 'too-big' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

// ── league backup / restore ──────────────────────────────────────────────────
// A backup is the COMPLETE store state in a versioned wrapper, plus the
// file-based VAPID keypair when one exists (DATA_DIR/vapid.json) so push
// subscriptions made against those keys keep working after a restore. PIN
// hashes ride along (hashes, never plaintext) — claims and PIN logins work
// exactly as before. Session tokens are part of the state too: sessions that
// were live when the backup was taken stay live; newer ones are dropped.
const BACKUP_FORMAT = 'open-season-backup';
const BACKUP_VERSION = 1;
function readVapidFile() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'vapid.json'), 'utf8'));
    if (v && typeof v.publicKey === 'string' && typeof v.privateKey === 'string') {
      return { publicKey: v.publicKey, privateKey: v.privateKey };
    }
  } catch (_) { /* no file-based keys (env keys, or none generated yet) */ }
  return null;
}
function buildBackup() {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    state,
    vapid: readVapidFile(),
  };
}
// Returns an error string, or null when the backup is restorable. Pure check:
// a failed validation must leave the running league untouched.
// `currentPlayers` (Round 10): the roster-identity check — a backup whose
// player ids are not EXACTLY this league's roster (or that carries no
// Founder) would restore into a league nobody can log into or administer:
// the claims and PINs belong to people who are not on it, and the men who
// ARE on it have no records. Refused outright.
function validateBackup(b, currentPlayers) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'That file is not an Open Season backup (expected a JSON object)';
  if (b.format !== BACKUP_FORMAT) return 'That file is not an Open Season backup (missing format marker)';
  if (b.version !== BACKUP_VERSION) return `Unsupported backup version (${b.version}) — this app restores version ${BACKUP_VERSION}`;
  const s = b.state;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'Backup has no league state';
  if (!s.league || typeof s.league !== 'object' || Array.isArray(s.league)) return 'Backup state is missing the league settings';
  if (!Array.isArray(s.players) || !s.players.length) return 'Backup state is missing the player roster';
  if (!s.players.every(p => p && typeof p.id === 'string' && typeof p.name === 'string')) return 'Backup roster entries are malformed';
  for (const key of ['messages', 'kills', 'xpLog', 'bounties', 'bountyHistory', 'archive']) {
    if (!Array.isArray(s[key])) return `Backup state is missing "${key}"`;
  }
  if (b.vapid !== undefined && b.vapid !== null) {
    if (typeof b.vapid !== 'object' || typeof b.vapid.publicKey !== 'string' || typeof b.vapid.privateKey !== 'string') {
      return 'Backup push-key (VAPID) block is malformed';
    }
  }
  if (currentPlayers) {
    const want = new Set(currentPlayers.map(p => p.id));
    const got = s.players.map(p => p.id);
    if (got.length !== want.size || got.some(id => !want.has(id))) {
      return 'That backup belongs to a different roster — restoring it would lock everyone out. Nothing was changed.';
    }
    if (!s.players.some(p => p.role === 'Founder')) {
      return 'That backup has no Founder on its roster — restoring it would leave the league with no admin. Nothing was changed.';
    }
  }
  return null;
}

// ── kill resolution ──────────────────────────────────────────────────────────
// Applies a confirmed kill: victim dies (−75), killer paid (+100 / +125
// stealth / +50 marked-man bonus), bounties collected. Every applied effect
// is recorded on the kill record (appliedKill / appliedBonus / appliedDeath /
// bountyAmount + bountyList) so a Kill Cancel can void the kill with exactly
// offsetting ledger entries, and an Override can re-credit them.
// SCRIMMAGE: flags and practice counters move, but NO XP, NO ledger, NO
// bounties, and the victim is never marked OUT (practice deaths don't count).
function resolveKill(k, via) {
  const killer = playerById(k.killerId);
  const victim = playerById(k.victimId);
  k.status = 'confirmed';
  k.confirmedAt = new Date().toISOString();
  k.cancelExpiresAt = new Date(Date.now() + CANCEL_WINDOW_MS).toISOString();
  victim.alive = false;
  victim.diedAt = k.confirmedAt;
  victim.hunting = false; victim.huntStartedAt = null; // death ends any hunt in progress
  if (scrimmage()) {
    killer.scrimmageKills += 1;
    feed('kill', `SCRIMMAGE — ${killer.name} took out ${victim.name}. Practice only: nothing counts. ${victim.name} has 24 hours to play a Kill Cancel card.`, killer.id, { killId: k.id });
    return;
  }
  killer.seasonKills += 1;
  if (k.stealth) killer.seasonStealthKills += 1;
  victim.seasonDeaths += 1;
  k.baseXp = k.stealth ? XP.STEALTH_KILL : XP.KILL;
  k.appliedKill = applyXp(state, killer, k.baseXp, k.stealth ? 'stealth-kill' : 'kill', `Killed ${victim.name}${via ? ' (' + via + ')' : ''}`, k.id);
  k.markedBonus = state.league.markedManId === victim.id;
  k.appliedBonus = k.markedBonus
    ? applyXp(state, killer, XP.MARKED_MAN_BONUS, 'marked-man-bonus', `Took out the marked man (${victim.name})`, k.id)
    : 0;
  k.appliedDeath = deathXp(state, victim, `Killed by ${killer.name}`, k.id);
  collectBounties(killer, victim, k);
  feed('kill', `${killer.name} took out ${victim.name}. ${victim.name} has 24 hours to play a Kill Cancel card — void the kill and walk away immune.`, killer.id, { killId: k.id });
  awardAchievements(killer);
  awardAchievements(victim);
}
// Another kill that currently stands against this victim (used so canceling
// one kill never resurrects a man who was also killed by someone else).
function otherStandingKill(victimId, exceptKillId) {
  return state.kills.find(x => x.id !== exceptKillId && x.victimId === victimId && (x.status === 'confirmed' || x.status === 'overridden')) || null;
}
// ── Round 10: a kill confirms exactly once ───────────────────────────────────
// Two different killers can both hold claims on one victim (the claim
// route only blocks a duplicate from the SAME killer). Before this fix,
// both could confirm: both killers paid, the victim charged twice, two
// deaths on his record. confirmKill() is the single gate both confirm
// paths (victim confirm, admin settle) go through:
//  - if the victim is already out/dead, or ANOTHER kill already stands
//    on him, this claim is auto-rejected and the caller gets an error;
//  - on a successful confirm, every OTHER pending claim on the victim is
//    auto-rejected as superseded, so it can never be confirmed later.
function confirmKill(k, via) {
  const victim = playerById(k.victimId);
  if (!victim || !victim.alive || victim.out || otherStandingKill(k.victimId, k.id)) {
    k.status = 'rejected';
    feed('system', `A kill claim on ${victim ? victim.name : 'a hunter'} was auto-rejected — superseded: the victim is already eliminated.`, null);
    return 'That claim was auto-rejected — the victim is already eliminated by another kill';
  }
  resolveKill(k, via);
  const superseded = state.kills.filter(x => x.id !== k.id && x.victimId === k.victimId && x.status === 'pending');
  if (superseded.length) {
    for (const x of superseded) x.status = 'rejected';
    feed('system', `${superseded.length} other pending claim${superseded.length === 1 ? '' : 's'} on ${victim.name} auto-rejected — superseded: victim already eliminated.`, null);
  }
  return null;
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  // Restore is the one route whose body is a whole backup file (far past the
  // normal 5 MB JSON ceiling), so it gets its own raw read + cap + parse.
  let body = {};
  if (method === 'POST' && url.pathname === '/api/admin/restore') {
    const raw = await readRawBody(req, RESTORE_MAX_BYTES);
    if (raw === 'too-big') return json(res, 413, { error: `Backup file too large — the restore cap is ${Math.round(RESTORE_MAX_BYTES / 1048576)} MB` });
    if (raw === null) return json(res, 400, { error: 'Could not read that upload' });
    try { body = { __backup: JSON.parse(raw) }; }
    catch (_) { return json(res, 400, { error: 'That file is not valid JSON — pick the backup file you downloaded from this app' }); }
  } else if (method === 'POST' || method === 'DELETE') {
    body = await readBody(req).catch(() => null);
    if (body === null) return json(res, 400, { error: 'Bad JSON' });
  }

  // public: roster (names only, for the claim screen)
  if (method === 'GET' && url.pathname === '/api/roster') {
    return json(res, 200, { players: state.players.map(p => ({ id: p.id, name: p.name, role: p.role, watching: p.watching, claimed: p.claimed })), league: { name: state.league.name, season: state.league.season, phase: phase(), seasonStart: state.league.seasonStart } });
  }

  if (method === 'POST' && url.pathname === '/api/claim') {
    const p = playerById(body.playerId);
    if (!p) return json(res, 404, { error: 'Roster spot not found' });
    if (String(body.code || '').trim().toUpperCase() !== LEAGUE_CODE) return json(res, 403, { error: 'Wrong league code' });
    if (p.claimed) return json(res, 409, { error: 'That spot is already claimed — log in with your PIN instead' });
    if (!body.pin || String(body.pin).length < 4) return json(res, 400, { error: 'PIN must be at least 4 characters' });
    p.claimed = true;
    p.pinHash = newPinHash(body.pin);
    p.token = newToken();
    p.joinedAt = new Date().toISOString();
    feed('system', `${p.name} joined the league.`, p.id);
    save();
    return json(res, 200, { token: p.token, state: snapshot(p) });
  }

  if (method === 'POST' && url.pathname === '/api/login') {
    const p = playerById(body.playerId);
    if (!p || !p.claimed) return json(res, 404, { error: 'Spot not claimed yet' });
    // Round 10 throttle: a locked player stays locked (even for the
    // right PIN) until the lock runs out; failures inside the window
    // count toward the next lock; a success wipes the slate.
    const now = Date.now();
    if (!Array.isArray(p.loginFailTs)) p.loginFailTs = [];
    p.loginFailTs = p.loginFailTs.filter(t => now - t < LOGIN_WINDOW_MS);
    if (p.loginLockUntil && p.loginLockUntil > now) {
      const mins = Math.max(1, Math.ceil((p.loginLockUntil - now) / 60000));
      return json(res, 429, { error: `Too many wrong PIN attempts — login for ${p.name} is locked for about ${mins} more minute${mins === 1 ? '' : 's'}` });
    }
    if (!verifyPin(body.pin || '', p)) {
      p.loginFailTs.push(now);
      if (p.loginFailTs.length >= LOGIN_MAX_FAILS) {
        p.loginLockUntil = now + LOGIN_LOCK_MS;
        p.loginFailTs = [];
        save();
        return json(res, 429, { error: `Too many wrong PIN attempts — login for ${p.name} is locked for ${LOGIN_LOCK_MS / 60000} minutes` });
      }
      save();
      return json(res, 403, { error: 'Wrong PIN' });
    }
    p.loginFailTs = [];
    p.loginLockUntil = 0;
    // Upgrade-on-login: a legacy SHA-256 hash that just verified is
    // replaced with a scrypt hash, so old saves/backups migrate forward
    // one successful login at a time.
    if (!String(p.pinHash).startsWith('scrypt:')) p.pinHash = newPinHash(body.pin || '');
    p.token = newToken();
    save();
    return json(res, 200, { token: p.token, state: snapshot(p) });
  }

  // everything below requires auth
  const me = auth(req);
  if (!me) return json(res, 401, { error: 'Not logged in' });

  if (method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot(me));

  if (method === 'POST' && url.pathname === '/api/logout') { me.token = null; save(); return json(res, 200, { ok: true }); }

  // ── Web Push ──
  if (method === 'GET' && url.pathname === '/api/push/key') {
    return json(res, 200, { publicKey: push.vapid().publicKey });
  }
  if (method === 'POST' && url.pathname === '/api/push/subscribe') {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return json(res, 400, { error: 'A full push subscription (endpoint + keys) is required' });
    }
    if (!pushEndpointAllowed(sub.endpoint)) {
      return json(res, 400, { error: 'That push endpoint is not a recognized push service — subscription refused' });
    }
    me.pushSubs = me.pushSubs.filter(s => s.endpoint !== sub.endpoint);
    me.pushSubs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    save();
    return json(res, 200, { ok: true, subscriptions: me.pushSubs.length });
  }
  if (method === 'POST' && url.pathname === '/api/push/unsubscribe') {
    if (body.endpoint) me.pushSubs = me.pushSubs.filter(s => s.endpoint !== body.endpoint);
    else me.pushSubs = [];
    save();
    return json(res, 200, { ok: true });
  }
  // Test push (Round 5): any claimed hunter verifies HIS OWN phone. Sends
  // only to the requester's stored subscriptions — never anyone else's —
  // prunes dead ones like every other send, and reports the counts.
  if (method === 'POST' && url.pathname === '/api/push/test') {
    if (!me.pushSubs.length) return json(res, 400, { error: 'Turn notifications on first' });
    const r = await push.sendToPlayerReport(me, {
      title: '🏹 Open Season',
      body: "Test push — notifications are working. You're all set.",
      tag: 'test-push',
    }, save);
    // Round 8 diagnostics: surface the push service's per-attempt HTTP
    // statuses (and error notes for sends that never got an answer) so a
    // rejected test push is decisive evidence, not just "0 accepted".
    return json(res, 200, {
      ok: true, targeted: r.targeted, accepted: r.accepted, pruned: r.pruned,
      statuses: r.statuses, ...(r.errors && r.errors.length ? { errors: r.errors } : {}),
    });
  }

  if (method === 'POST' && url.pathname === '/api/messages') {
    const text = String(body.text || '').trim().slice(0, 1000);
    if (!text) return json(res, 400, { error: 'Empty message' });
    const m = { id: uid('msg'), ts: new Date().toISOString(), playerId: me.id, kind: 'chat', text, killId: null, onlyFor: null, reactions: {} };
    state.messages.push(m);
    save();
    return json(res, 200, { message: m, state: snapshot(me) });
  }

  // ── feed reactions (toggle one emoji per hunter per entry) ──
  if (method === 'POST' && seg[1] === 'messages' && seg[2] && seg[3] === 'react') {
    const m = state.messages.find(x => x.id === seg[2]);
    if (!m) return json(res, 404, { error: 'Feed entry not found' });
    if (!me.claimed) return json(res, 403, { error: 'Claim your spot first' });
    const emoji = String(body.emoji || '');
    if (!REACTION_EMOJIS.includes(emoji)) return json(res, 400, { error: 'Pick one of: ' + REACTION_EMOJIS.join(' ') });
    if (!m.reactions || typeof m.reactions !== 'object') m.reactions = {};
    const arr = Array.isArray(m.reactions[emoji]) ? m.reactions[emoji] : [];
    const i = arr.indexOf(me.id);
    if (i >= 0) arr.splice(i, 1); else arr.push(me.id);
    if (arr.length) m.reactions[emoji] = arr; else delete m.reactions[emoji];
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  // ── profile: callsign + emoji avatar, walkthrough flag ──
  if (method === 'POST' && url.pathname === '/api/profile') {
    if ('callsign' in body) {
      const v = String(body.callsign || '').trim().replace(/\s+/g, ' ');
      if (v && (v.length > 16 || !/^[\p{L}\p{N} ._'!-]+$/u.test(v))) {
        return json(res, 400, { error: 'Callsign must be plain text, 16 characters max' });
      }
      me.callsign = v || null;
    }
    if ('avatar' in body) {
      const v = String(body.avatar || '').trim();
      if (v && ([...v].length > 6 || /[\p{L}\p{N}\s]/u.test(v))) {
        return json(res, 400, { error: 'Avatar must be a single emoji' });
      }
      me.avatar = v || null;
    }
    save();
    return json(res, 200, { state: snapshot(me) });
  }
  if (method === 'POST' && url.pathname === '/api/walkthrough') {
    me.walkthroughSeen = !!body.seen;
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  if (method === 'POST' && url.pathname === '/api/sharing') {
    const on = !!body.on;
    me.sharing = on;
    if (!on) {
      me.position = null;
      // Manual off also clears the derived statuses (no fixes are coming).
      me.zoneStatus = null; me.driving = false; me.drvFast = 0; me.drvSlow = 0; me.lastFix = null;
      me.hunting = false; me.huntStartedAt = null; // Hunt Mode rides on sharing — off means the hunt is over
    }
    // League rule: turning sharing off mid-season (while alive and in) = out.
    // Scrimmage exempt: practice never eliminates anyone.
    if (!on && phase() === 'live' && !scrimmage() && me.alive && !me.watching) {
      me.out = true; me.alive = false; me.diedAt = new Date().toISOString();
      feed('system', `${me.name} turned location off mid-season and is OUT.`, me.id);
    }
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  // ── Hunt Mode (Round 6) ──
  // ON: persists the hunting flag + start time, and turns location
  // sharing ON with it (the toggle rides on sharing; turning Hunt Mode
  // OFF never touches sharing). The off→on TRANSITION fires the blast —
  // one anonymous push to every OTHER claimed hunter + one anonymous
  // feed entry — at most once per hunter per HUNT_BLAST_COOLDOWN_MS,
  // and only while the hunt is open (live season or scrimmage). In
  // plain setup the toggle/wake-lock/banner still work; nothing blasts.
  if (method === 'POST' && url.pathname === '/api/hunt-mode') {
    const on = !!body.on;
    if (!on) {
      me.hunting = false; me.huntStartedAt = null;
      save();
      return json(res, 200, { state: snapshot(me), blasted: false });
    }
    if (me.watching) return json(res, 400, { error: 'Watching members do not hunt' });
    if (!me.alive || me.out) return json(res, 400, { error: 'You are out — dead men do not hunt' });
    const transition = !me.hunting;
    if (transition) {
      me.hunting = true;
      me.huntStartedAt = new Date().toISOString();
      if (!me.sharing) me.sharing = true; // Hunt Mode requires sharing — it turns on with it
    }
    let blasted = false;
    if (transition && huntOpen() && Date.now() - (me.lastBlastAt || 0) >= HUNT_BLAST_COOLDOWN_MS) {
      me.lastBlastAt = Date.now();
      // ANONYMOUS by construction: fixed text, no player attached, and
      // the push payload carries no name, id, or identifier of any kind.
      feed('hunt', '🎯 Someone started hunting.', null);
      for (const q of state.players) {
        if (q.id === me.id || !q.claimed) continue;
        notify(q, '🏹 Open Season', "⚠️ Someone's hunting. Open the app — your pin goes live.", 'hunt-start');
      }
      blasted = true;
    }
    save();
    return json(res, 200, { state: snapshot(me), blasted });
  }
  // The one-time battery hint was shown (client records it so it never nags twice).
  if (method === 'POST' && url.pathname === '/api/hunt-hint') {
    me.huntHintSeen = true;
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  // ── League ping (Round 7) ──
  // The social nudge: any claimed, alive, non-watching hunter pushes
  // every OTHER hunter in the game once an hour — "open the app and
  // update your location." The sender is NAMED (feed + push): this is a
  // roll call, not a stealth mechanic. Allowed in every phase.
  if (method === 'POST' && url.pathname === '/api/ping') {
    if (me.watching) return json(res, 400, { error: 'Watching members do not ping' });
    if (!me.alive || me.out) return json(res, 400, { error: 'You are out — dead men do not ping' });
    const now = Date.now();
    const waitMs = PING_COOLDOWN_MS - (now - (me.lastPingAt || 0));
    if (waitMs > 0) {
      return json(res, 429, { error: `Ping is cooling down — about ${Math.max(1, Math.ceil(waitMs / 60000))} min left`, retryAfterMs: waitMs });
    }
    me.lastPingAt = now;
    feed('ping', `📍 ${me.name} pinged the league for a location update.`, me.id);
    let pinged = 0;
    for (const q of state.players) {
      if (q.id === me.id || !q.claimed || !q.alive || q.out || q.watching) continue;
      notify(q, '🏹 Open Season', `📍 ${me.name} pinged the league — open the app to update your location.`, 'league-ping');
      pinged++;
    }
    save();
    return json(res, 200, { state: snapshot(me), pinged });
  }

  if (method === 'POST' && url.pathname === '/api/position') {
    const { lat, lng } = body;
    // Round 10: finite + in range. Raw JSON can carry 1e999, which parses
    // to Infinity — a "number" that would serialize back out as null to
    // every client and poison the speed math with NaN.
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return json(res, 400, { error: 'lat/lng must be finite numbers in range (lat −90..90, lng −180..180)' });
    }
    if (!me.sharing) return json(res, 400, { error: 'Turn location sharing on first' });
    const now = Date.now();
    const speed = fixSpeed(me, body, lat, lng, now); // device speed, else derived from the previous fix
    me.lastFix = { lat, lng, t: now };
    me.position = { lat, lng, ts: new Date(now).toISOString() };
    updateDriving(me, speed); // may enter/exit driving mode (one feed entry per trip)
    updateZoneStatus(me); // may announce a safe-zone entry (label only)
    checkDanger(me); // may append private danger alerts + pushes (suppressed around drivers)
    refreshCheckIns(state.league.checkCall); // a fix during a Location Check IS the check-in (hidden pin or not)
    save();
    return json(res, 200, { inSafeZone: inOwnSafeZone(me), driving: me.driving, atSafeZone: me.zoneStatus ? me.zoneStatus.label : null, state: snapshot(me) });
  }

  if (method === 'POST' && url.pathname === '/api/safe-zones') {
    const { label, lat, lng } = body;
    if (!['home', 'work', 'church'].includes(label)) return json(res, 400, { error: 'label must be home, work, or church' });
    // Round 10: same finite/range discipline as /api/position, and the
    // radius must be a sane number when one is sent (a non-finite radius
    // used to be silently clamped into a real zone).
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return json(res, 400, { error: 'lat/lng must be finite numbers in range (lat −90..90, lng −180..180)' });
    }
    let radius = 150;
    if (body.radius !== undefined) {
      radius = Number(body.radius);
      if (!Number.isFinite(radius) || radius < 25 || radius > 2000) {
        return json(res, 400, { error: 'Safe-zone radius must be between 25 and 2000 m' });
      }
    }
    me.safeZones = me.safeZones.filter(z => z.label !== label);
    me.safeZones.push({ id: uid('zone'), label, lat, lng, radius });
    updateZoneStatus(me); // standing inside the zone you just saved lights the status up now
    save();
    return json(res, 200, { state: snapshot(me) });
  }
  if (method === 'DELETE' && seg[1] === 'safe-zones' && seg[2]) {
    me.safeZones = me.safeZones.filter(z => z.id !== seg[2]);
    updateZoneStatus(me); // deleting the zone you're in clears (or re-points) the status
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  // ── kills ──
  if (method === 'POST' && url.pathname === '/api/kills') {
    if (!huntOpen()) return json(res, 403, { error: 'Kill claims are locked until the season goes live (January 1, 2027).' });
    const victim = playerById(body.victimId);
    if (!victim || victim.id === me.id) return json(res, 400, { error: 'Pick another hunter as your target' });
    if (me.watching || victim.watching) return json(res, 400, { error: 'Watching members are not in the hunt' });
    if (!victim.claimed) return json(res, 400, { error: 'That hunter has not claimed their spot yet — no claims on an empty chair' });
    if (!me.alive || me.out) return json(res, 400, { error: 'You are out — dead men tell no tales' });
    if (!victim.alive || victim.out) return json(res, 400, { error: 'That hunter is already out' });
    if (isImmune(victim)) {
      const hrs = Math.max(1, Math.ceil((Date.parse(victim.immuneUntil) - Date.now()) / 36e5));
      return json(res, 400, { error: `That hunter is IMMUNE — Kill Cancel shield up for ~${hrs} more hour${hrs === 1 ? '' : 's'}. No claim lands.` });
    }
    if (victim.driving) {
      return json(res, 400, { error: `That hunter is DRIVING — no hits on a driver (target is driving). Wait until he stops.` });
    }
    if (state.kills.some(k => k.killerId === me.id && k.victimId === victim.id && k.status === 'pending')) {
      return json(res, 409, { error: 'You already have a pending claim on that hunter' });
    }
    // Optional proof photo: one image, ≤ ~2.5 MB decoded, jpeg/png/webp.
    let photo = null;
    if (body.photo !== undefined && body.photo !== null) {
      const ph = body.photo;
      if (!ph || typeof ph !== 'object' || !PHOTO_MIMES.includes(ph.mime) || typeof ph.data !== 'string') {
        return json(res, 400, { error: 'Proof photo must be a JPEG, PNG, or WebP image' });
      }
      const bytes = Buffer.from(ph.data, 'base64');
      if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) {
        return json(res, 400, { error: 'Proof photo is too big — keep it under 2.5 MB' });
      }
      photo = { mime: ph.mime, data: ph.data };
    }
    const k = {
      id: uid('kill'), killerId: me.id, victimId: victim.id, stealth: !!body.stealth,
      status: 'pending', createdAt: new Date().toISOString(), confirmedAt: null,
      cancelExpiresAt: new Date(Date.now() + CANCEL_WINDOW_MS).toISOString(),
      counterExpiresAt: null, photo,
      baseXp: 0, appliedKill: 0, appliedBonus: 0, appliedDeath: 0, markedBonus: false,
      bountyAmount: 0, bountyList: [],
    };
    state.kills.push(k);
    feed('system', k.stealth ? `A stealth kill was claimed on ${victim.name} — awaiting confirmation.` : `${me.name} claimed a kill on ${victim.name} — awaiting confirmation.`, me.id);
    save();
    // Push (a): a NON-stealth claim alerts the victim. Stealth never leaks.
    if (!k.stealth && !scrimmage()) notify(victim, 'Open Season — kill claim', `${me.name} claimed a kill on you. Confirm or dispute it in the app.`, 'kill-claim');
    return json(res, 200, { kill: publicKill(k, me), state: snapshot(me) });
  }

  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'confirm') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'pending') return json(res, 404, { error: 'No pending claim with that id' });
    if (k.victimId !== me.id) return json(res, 403, { error: 'Only the victim can confirm' });
    const confirmErr = confirmKill(k, 'confirmed by victim');
    if (confirmErr) { save(); return json(res, 400, { error: confirmErr }); }
    save();
    // Push (c): the killer hears his kill is confirmed.
    if (!scrimmage()) notify(playerById(k.killerId), 'Open Season — kill confirmed', `Your kill on ${me.name} is confirmed.`, 'kill-confirmed');
    return json(res, 200, { state: snapshot(me) });
  }
  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'dispute') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'pending') return json(res, 404, { error: 'No pending claim with that id' });
    if (k.victimId !== me.id) return json(res, 403, { error: 'Only the victim can dispute' });
    k.status = 'disputed';
    feed('system', `${me.name} disputed a kill claim. Founder/Vice settles it.`, me.id);
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  // ── Kill Cancel: the victim voids a confirmed kill ──
  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'cancel') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'confirmed') return json(res, 404, { error: 'No confirmed kill to cancel' });
    if (k.victimId !== me.id) return json(res, 403, { error: 'Only the victim can play a Kill Cancel' });
    if (!me.killCancelCard) return json(res, 400, { error: 'Your Kill Cancel card is spent' });
    if (Date.now() > Date.parse(k.cancelExpiresAt)) return json(res, 400, { error: 'The 24-hour Kill Cancel window has closed' });
    const killer = playerById(k.killerId);
    const victim = me;
    victim.killCancelCard = false;
    k.status = 'canceled';
    k.canceledAt = new Date().toISOString();
    k.counterExpiresAt = new Date(Date.now() + CANCEL_WINDOW_MS).toISOString();
    victim.immuneUntil = new Date(Date.now() + IMMUNITY_MS).toISOString();
    // The victim stands back up — unless a DIFFERENT standing kill also has him.
    const other = otherStandingKill(victim.id, k.id);
    if (!other) { victim.alive = true; victim.diedAt = null; }
    else victim.diedAt = other.confirmedAt;
    if (scrimmage()) {
      killer.scrimmageKills = Math.max(0, killer.scrimmageKills - 1);
      feed('cancel', `SCRIMMAGE KILL CANCEL — ${victim.name} played his card. The kill is VOIDED, nobody is down, and ${victim.name} is immune for 24 hours. Practice only: nothing counts.`, victim.id, { killId: k.id });
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    killer.seasonKills = Math.max(0, killer.seasonKills - 1);
    if (k.stealth) killer.seasonStealthKills = Math.max(0, killer.seasonStealthKills - 1);
    victim.seasonDeaths = Math.max(0, victim.seasonDeaths - 1);
    // Offsetting ledger entries (reason 'kill-cancel', linked to this kill):
    // the kill's XP effects are clawed back to the cent (subject to the
    // global 0-XP floor inside applyXp, like every other adjustment).
    if (k.appliedKill) applyXp(state, killer, -k.appliedKill, 'kill-cancel', `Kill on ${victim.name} voided by Kill Cancel — kill XP clawed back`, k.id);
    if (k.appliedBonus) applyXp(state, killer, -k.appliedBonus, 'kill-cancel', `Marked-man bonus on ${victim.name} voided by Kill Cancel`, k.id);
    if (k.bountyAmount) {
      applyXp(state, killer, -k.bountyAmount, 'kill-cancel', `Bounty on ${victim.name} voided by Kill Cancel — bounty restored to the board`, k.id);
      state.bounties.push(...k.bountyList.map(b => ({ ...b }))); // the price is back on his head
    }
    applyXp(state, victim, -k.appliedDeath, 'kill-cancel', `Death charge refunded — Kill Cancel on ${killer.name}`, k.id);
    applyXp(state, victim, 0, 'kill-cancel-played', `Played Kill Cancel — voided ${killer.name}'s kill, immune 24h`, k.id);
    feed('cancel', `🛡 KILL CANCEL — ${victim.name} played his card. ${killer.name}'s kill is VOIDED: nobody dies, and ${victim.name} is IMMUNE for 24 hours. ${killer.name} can burn his own card within 24 hours to override.`, victim.id, { killId: k.id });
    awardAchievements(victim);
    awardAchievements(killer);
    save();
    // Push: the killer hears his kill died instead.
    notify(killer, 'Open Season — kill CANCELED', `${victim.name} played a Kill Cancel. Your kill is voided and ${victim.name} is immune for 24 hours — burn your own card to override.`, 'kill-canceled');
    return json(res, 200, { state: snapshot(me) });
  }

  // ── Override: the killer burns his own card so the kill stands ──
  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'counter-cancel') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'canceled') return json(res, 404, { error: 'No canceled kill to override' });
    if (k.killerId !== me.id) return json(res, 403, { error: 'Only the killer can override a Kill Cancel' });
    if (!me.killCancelCard) return json(res, 400, { error: 'Your Kill Cancel card is spent' });
    if (Date.now() > Date.parse(k.counterExpiresAt)) return json(res, 400, { error: 'The 24-hour override window has closed' });
    const killer = me;
    const victim = playerById(k.victimId);
    killer.killCancelCard = false;
    k.status = 'overridden';
    k.counteredAt = new Date().toISOString();
    victim.immuneUntil = null; // shield drops — the kill stands
    victim.alive = false;
    victim.diedAt = k.counteredAt;
    if (scrimmage()) {
      killer.scrimmageKills += 1;
      feed('cancel', `SCRIMMAGE OVERRIDE — ${killer.name} burned his card. The kill on ${victim.name} STANDS. Practice only: nothing counts. Both cards are gone.`, killer.id, { killId: k.id });
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    killer.seasonKills += 1;
    if (k.stealth) killer.seasonStealthKills += 1;
    victim.seasonDeaths += 1;
    // Re-credit the voided effects as fresh ledger entries ('kill-restored'),
    // re-charge the death, and re-collect whatever bounties sit on the victim
    // now (the restored ones included, plus any placed during the window).
    applyXp(state, killer, k.baseXp, 'kill-restored', `Kill on ${victim.name} re-credited — Kill Cancel overridden`, k.id);
    if (k.markedBonus) applyXp(state, killer, XP.MARKED_MAN_BONUS, 'kill-restored', `Marked-man bonus on ${victim.name} re-credited — override`, k.id);
    k.appliedDeath = deathXp(state, victim, `Kill Cancel overridden by ${killer.name} — original kill stands`, k.id);
    collectBounties(killer, victim, k);
    applyXp(state, killer, 0, 'override', `Overrode ${victim.name}'s Kill Cancel — the kill stands`, k.id);
    feed('cancel', `🔥 OVERRIDE — ${killer.name} burned his Kill Cancel. The kill on ${victim.name} STANDS and ${victim.name} is out. Both cards are gone.`, killer.id, { killId: k.id });
    awardAchievements(killer);
    awardAchievements(victim);
    save();
    notify(victim, 'Open Season — cancel OVERRIDDEN', `${killer.name} burned his Kill Cancel to override yours. The kill stands — you are out.`, 'cancel-overridden');
    return json(res, 200, { state: snapshot(me) });
  }

  // ── admin (Founder / Vice) ──
  if (seg[1] === 'admin') {
    if (seg[2] === 'founder-reset') {
      if (!ADMIN_RESET_CODE || body.resetCode !== ADMIN_RESET_CODE) return json(res, 403, { error: 'Reset code not set or wrong' });
      if (me.role !== 'Founder') return json(res, 403, { error: 'Founder only' });
      state.players.forEach(p => { if (p.id !== me.id) { p.claimed = false; p.pinHash = null; p.token = null; } });
      feed('system', 'Founder reset: all other roster claims/PINs were cleared.', me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (!isAdmin(me)) return json(res, 403, { error: 'Founder/Vice only' });

    // ── backup / restore (insurance against free-tier storage wipes) ──
    if (method === 'GET' && seg[2] === 'backup') {
      // Stamp the download (Round 5): this is what feeds the stale-backup
      // reminder. Stamped BEFORE building so the backup file itself
      // records when it was taken in league.lastBackupAt too.
      state.league.lastBackupAt = new Date().toISOString();
      save();
      const backup = buildBackup();
      const stamp = backup.exportedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 13); // YYYYMMDD-HHmm
      const payload = JSON.stringify(backup, null, 1);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="open-season-backup-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      return res.end(payload);
    }
    if (method === 'POST' && seg[2] === 'restore') {
      const b = body.__backup;
      const err = validateBackup(b, state.players);
      if (err) return json(res, 400, { error: err }); // nothing has changed
      // Detach from the request object, fill defaults like a disk load.
      const next = store.normalize(JSON.parse(JSON.stringify(b.state)));
      // The restoring admin keeps his live session across the swap (his
      // backup-era token may predate his current login); every other
      // session reverts to whatever the backup holds.
      const myToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-token'];
      const meNext = next.players.find(p => p.id === me.id);
      if (meNext && myToken) meNext.token = myToken;
      // Audit trail inside the restored league itself.
      next.messages.push({
        id: uid('msg'), ts: new Date().toISOString(), playerId: me.id, kind: 'system', reactions: {},
        text: `♻ League restored from a backup taken ${b.exportedAt || 'earlier'} — restored by ${me.name}. The league is exactly as it was in that backup.`,
      });
      // Commit to disk FIRST (atomic tmp+rename): if the write fails, the
      // running league is untouched. Only then swap the in-memory state.
      try { store.save(next); } catch (e) { return json(res, 500, { error: 'Could not write the restored state — nothing was changed' }); }
      state = next;
      // Backed-up push keys come back too (unless env keys are configured,
      // in which case vapid() keeps preferring them, as before).
      if (b.vapid) {
        try {
          const vf = path.join(store.DATA_DIR, 'vapid.json');
          fs.writeFileSync(vf + '.tmp', JSON.stringify({ publicKey: b.vapid.publicKey, privateKey: b.vapid.privateKey }, null, 1));
          fs.renameSync(vf + '.tmp', vf);
          push.invalidateKeys();
        } catch (e) { console.warn('Restore: could not write vapid.json:', e.message); }
      }
      return json(res, 200, { ok: true, state: snapshot(meNext || null) });
    }
    // Backup reminder snooze (Round 5): hides the stale-backup banner for
    // THIS admin for 24 hours. Per-player on purpose — the Founder
    // snoozing doesn't silence the Vice's reminder.
    if (method === 'POST' && seg[2] === 'backup-snooze') {
      me.backupSnoozeUntil = Date.now() + BACKUP_SNOOZE_MS;
      save();
      return json(res, 200, { state: snapshot(me) });
    }

    // ── Location Check (Round 7): settings + the call itself ──
    // Settings are the DEFAULTS for the next call. Starting a call
    // snapshots them into the call record — editing settings mid-call
    // never alters a running call.
    if (method === 'POST' && seg[2] === 'check-settings') {
      const intervalMin = Math.round(Number(body.intervalMin));
      const deadlineMin = Math.round(Number(body.deadlineMin));
      if (!Number.isFinite(intervalMin) || intervalMin < 5 || intervalMin > 120) {
        return json(res, 400, { error: 'Reminder interval must be between 5 and 120 minutes' });
      }
      if (!Number.isFinite(deadlineMin) || deadlineMin < 15 || deadlineMin > 480) {
        return json(res, 400, { error: 'Check-in deadline must be between 15 and 480 minutes' });
      }
      state.league.checkSettings = { intervalMin, deadlineMin };
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'check-call' && seg[3] === 'start') {
      if (state.league.checkCall) return json(res, 400, { error: 'A location check is already running' });
      // Scrimmage takes precedence, exactly like kill claims: a call
      // during a scrimmage is practice and can never eliminate anyone.
      const mode = scrimmage() ? 'scrimmage' : (phase() === 'live' ? 'live' : null);
      if (!mode) return json(res, 400, { error: 'Location checks open once the season is live — or in a scrimmage' });
      // Target snapshot: live = alive hunters with sharing ON;
      // scrimmage = everybody in the game.
      const targets = state.players.filter(p => p.claimed && p.alive && !p.out && !p.watching && (mode === 'scrimmage' || p.sharing));
      if (!targets.length) {
        return json(res, 400, { error: mode === 'live' ? 'No targets — no alive hunter has location sharing on' : 'No targets — nobody is in the hunt' });
      }
      const { intervalMin, deadlineMin } = state.league.checkSettings;
      const now = Date.now();
      state.league.checkCall = {
        id: uid('check'),
        startedBy: me.id,
        startedAt: new Date(now).toISOString(), startedAtMs: now,
        deadlineAt: new Date(now + deadlineMin * 60000).toISOString(), deadlineAtMs: now + deadlineMin * 60000,
        intervalMin, deadlineMin, mode,
        lastReminderAtMs: now,
        targets: targets.map(p => ({ id: p.id, checkedInAt: null, done: false, outcome: null })),
      };
      feed('check', `📍 ${me.name} called a LOCATION CHECK — ${deadlineMin} min to check in.`, me.id);
      for (const p of targets) {
        notify(p, '🏹 Open Season', `📍 LOCATION CHECK — open the app and update your location. You have ${deadlineMin} minutes.`, 'location-check');
      }
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'check-call' && seg[3] === 'cancel') {
      if (!state.league.checkCall) return json(res, 400, { error: 'No location check is running' });
      state.league.checkCall = null; // called off: no elimination is ever applied from this call
      feed('check', '📍 Location check called off.', me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }

    if (method === 'POST' && seg[2] === 'settings') {
      if ('platform' in body) state.league.platform = body.platform || null;
      if ('weaponClass' in body) state.league.weaponClass = body.weaponClass || null;
      if ('pot' in body) state.league.pot = Math.max(0, Number(body.pot) || 0);
      let newMarked = null;
      if ('markedManId' in body) {
        const prevMarked = state.league.markedManId;
        state.league.markedManId = body.markedManId || null;
        if (state.league.markedManId && state.league.markedManId !== prevMarked) newMarked = playerById(state.league.markedManId);
      }
      feed('system', `Season setup updated by ${me.name}: platform ${state.league.platform || '—'}, class ${state.league.weaponClass || '—'}, pot $${state.league.pot}, marked man ${state.league.markedManId ? nameOf(state.league.markedManId) : '—'}.`, me.id);
      save();
      // Push (e): the newly marked man hears it first.
      if (newMarked) notify(newMarked, 'Open Season — you are marked', 'You are the marked man. Every hunter is coming for you — killing you pays a bonus.', 'marked-man');
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'callsign') {
      const p = playerById(body.playerId);
      if (!p) return json(res, 404, { error: 'Player not found' });
      const v = String(body.callsign || '').trim().replace(/\s+/g, ' ');
      if (v && (v.length > 16 || !/^[\p{L}\p{N} ._'!-]+$/u.test(v))) {
        return json(res, 400, { error: 'Callsign must be plain text, 16 characters max' });
      }
      p.callsign = v || null;
      feed('system', `${me.name} ${v ? `set ${p.name}'s callsign to "${v}"` : `cleared ${p.name}'s callsign`}.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'settle-kill') {
      const k = state.kills.find(x => x.id === body.killId);
      if (!k || k.status !== 'disputed') return json(res, 404, { error: 'No disputed kill with that id' });
      if (k.killerId === me.id || k.victimId === me.id) return json(res, 403, { error: 'A party to the kill cannot settle it — the other admin does' });
      if (body.outcome === 'confirm') {
        const confirmErr = confirmKill(k, `settled by ${me.name}`);
        if (confirmErr) { save(); return json(res, 400, { error: confirmErr }); }
        save();
        // Pushes (b)+(c): both parties hear the ruling — the victim died, the killer scored.
        if (!scrimmage()) {
          notify(playerById(k.victimId), 'Open Season — ☠ eliminated', `The disputed kill stands. You have been eliminated by ${nameOf(k.killerId)}.`, 'eliminated');
          notify(playerById(k.killerId), 'Open Season — kill confirmed', `Your disputed kill on ${nameOf(k.victimId)} was settled in your favor.`, 'kill-confirmed');
        }
      }
      else if (body.outcome === 'reject') {
        k.status = 'rejected';
        feed('system', `${me.name} rejected the disputed kill claim on ${nameOf(k.victimId)}. No kill, no XP.`, me.id);
        save();
      } else return json(res, 400, { error: 'outcome must be confirm or reject' });
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'duck') {
      const p = playerById(body.playerId);
      if (!p) return json(res, 404, { error: 'Player not found' });
      if (p.watching) return json(res, 400, { error: 'Watching members are not in the hunt — the Duck cannot touch them' });
      const applied = applyXp(state, p, XP.DUCK_OF_SHAME, 'duck-of-shame', `Duck of Shame awarded by ${me.name}`);
      p.seasonDucks += 1; // Duck Magnet superlative counter
      feed('duck', `🦆 DUCK OF SHAME — ${p.name} takes the duck (${applied} XP). Rubber duck on the dash until the next event, and the group expects the Creed recited out loud.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'bounty') {
      const target = playerById(body.targetId);
      const amount = Number(body.amount);
      if (!target) return json(res, 404, { error: 'Target not found' });
      if (target.watching) return json(res, 400, { error: 'Watching members cannot be hunted — no bounties on them' });
      if (!target.claimed) return json(res, 400, { error: 'That hunter has not claimed their spot yet — no bounties on an empty chair' });
      if (!target.alive || target.out) return json(res, 400, { error: 'That hunter is already out — no bounties on a dead man' });
      if (!Number.isInteger(amount) || amount < 25 || amount > 500) return json(res, 400, { error: 'Bounty must be a whole number of XP between 25 and 500' });
      const b = { id: uid('bounty'), targetId: target.id, amount, placedBy: me.id, note: String(body.note || '').slice(0, 140), createdAt: new Date().toISOString() };
      state.bounties.push(b);
      // Placement history is forever (even if the bounty is later pulled or
      // collected) — it feeds the Most Wanted superlative at season close.
      state.bountyHistory.push({ season: state.league.season, targetId: target.id, amount, placedBy: me.id, ts: b.createdAt });
      feed('bounty', `💰 BOUNTY — ${amount} XP on ${target.name}'s head, placed by ${me.name}${b.note ? ' — ' + b.note : ''}. Whoever takes him out collects.`, me.id);
      save();
      // Push (f): the target hears a price is on his head.
      notify(target, 'Open Season — 💰 bounty on you', `${me.name} put a ${amount} XP bounty on your head. Watch your back.`, 'bounty-on-you');
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'DELETE' && seg[2] === 'bounty' && seg[3]) {
      const b = state.bounties.find(x => x.id === seg[3]);
      if (!b) return json(res, 404, { error: 'Bounty not found' });
      state.bounties = state.bounties.filter(x => x.id !== seg[3]);
      feed('system', `${me.name} pulled the ${b.amount} XP bounty on ${nameOf(b.targetId)}.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'scrimmage') {
      const on = !!body.on;
      if (on === scrimmage()) return json(res, 200, { state: snapshot(me) });
      // Round 10: a scrimmage may only START during setup. Ending one
      // wipes state.kills and resurrects the board (the practice reset),
      // so a start during the live season puts real confirmed kills one
      // toggle away from vanishing while their XP stays — refused.
      if (on && phase() !== 'setup') {
        return json(res, 400, { error: 'Scrimmage can only start during setup — the season is live, and ending a scrimmage would wipe the real board' });
      }
      state.league.scrimmage = on;
      if (on) {
        feed('system', `🏋 SCRIMMAGE OPEN — practice season started by ${me.name}. Kills resolve, but nothing counts: no XP, no ledger, no real outs.`, me.id);
      } else {
        // Ending a scrimmage wipes the practice board back to a clean slate.
        resetPracticeBoard();
        feed('system', `🏋 SCRIMMAGE OVER — ${me.name} ended practice. Board reset clean; career XP untouched.`, me.id);
      }
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'event-win') {
      const p = playerById(body.playerId);
      if (!p) return json(res, 404, { error: 'Player not found' });
      if (p.watching) return json(res, 400, { error: 'Watching members are not in the hunt — no event wins for them' });
      applyXp(state, p, XP.EVENT_WIN, 'event-win', body.note || `Combo event win recorded by ${me.name}`);
      feed('xp', `${p.name} won a combo event: +${XP.EVENT_WIN} XP.`, me.id);
      awardAchievements(p);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'adjust-xp') {
      const p = playerById(body.playerId);
      const delta = Number(body.delta);
      if (!p) return json(res, 404, { error: 'Player not found' });
      if (p.watching) return json(res, 400, { error: 'Watching members are not in the hunt — no XP adjustments for them' });
      if (!Number.isInteger(delta) || delta === 0) return json(res, 400, { error: 'playerId and a non-zero whole-number delta are required' });
      const applied = applyXp(state, p, delta, 'adjust', body.note || `Manual adjust by ${me.name}`);
      feed('xp', `${me.name} adjusted ${p.name}'s XP by ${applied > 0 ? '+' : ''}${applied}${body.note ? ' — ' + body.note : ''}.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'close-season') {
      // Round 10: a season can only close while it is LIVE. In setup the
      // same call used to pay a phantom Last Man, archive a phantom
      // season, and advance the counter past a season nobody played.
      if (phase() !== 'live') return json(res, 400, { error: 'The season can only be closed while it is live — there is no season to close yet' });
      const alive = state.players.filter(p => !p.watching && p.alive && !p.out);
      let lastMan = body.lastManId ? playerById(body.lastManId) : (alive.length === 1 ? alive[0] : null);
      if (!lastMan) return json(res, 400, { error: 'Name the Last Man (lastManId) — more than one hunter is still alive (Reckoning result)' });
      const hunters = state.players.filter(p => !p.watching);
      // Deadliest Man requires at least one kill: at zero kills the
      // "top" hunter is just roster order, so the title stays unawarded
      // (null in the archive, no XP — the payment below already agreed).
      const deadliestTop = [...hunters].sort((a, b) => b.seasonKills - a.seasonKills)[0];
      const deadliest = deadliestTop && deadliestTop.seasonKills > 0 ? deadliestTop : null;
      // ── End-of-season superlatives (honors only — no XP attached) ──
      // First Blood: the earliest kill that still STANDS (canceled kills
      // count for nothing). Sneakiest / Duck Magnet read the net season
      // counters; Most Wanted sums this season's bounty PLACEMENTS.
      let firstBlood = null;
      for (const k of state.kills) {
        if (k.status !== 'confirmed' && k.status !== 'overridden') continue;
        if (!firstBlood || k.confirmedAt < firstBlood.at) firstBlood = { playerId: k.killerId, name: nameOf(k.killerId), at: k.confirmedAt };
      }
      const topBy = fn => {
        let best = null;
        for (const p of hunters) { const v = fn(p); if (v > 0 && (!best || v > best.value)) best = { playerId: p.id, name: p.name, value: v }; }
        return best;
      };
      const sneakiestRaw = topBy(p => p.seasonStealthKills);
      const duckRaw = topBy(p => p.seasonDucks);
      const wantedTotals = {};
      for (const h of state.bountyHistory) if (h.season === state.league.season) wantedTotals[h.targetId] = (wantedTotals[h.targetId] || 0) + h.amount;
      let mostWanted = null;
      for (const [tid, total] of Object.entries(wantedTotals)) {
        if (total > 0 && (!mostWanted || total > mostWanted.bountyXp)) mostWanted = { playerId: tid, name: nameOf(tid), bountyXp: total };
      }
      const superlatives = {
        firstBlood,
        sneakiest: sneakiestRaw ? { playerId: sneakiestRaw.playerId, name: sneakiestRaw.name, stealthKills: sneakiestRaw.value } : null,
        mostWanted,
        duckMagnet: duckRaw ? { playerId: duckRaw.playerId, name: duckRaw.name, ducks: duckRaw.value } : null,
      };
      // Hall of the Fallen: archive the finished board BEFORE anything resets.
      state.archive.push({
        season: state.league.season,
        closedAt: new Date().toISOString(),
        lastManId: lastMan.id, lastManName: lastMan.name,
        deadliestId: deadliest ? deadliest.id : null, deadliestName: deadliest ? deadliest.name : null,
        deadliestKills: deadliest ? deadliest.seasonKills : 0,
        superlatives,
        standings: hunters
          .map(p => ({ playerId: p.id, name: p.name, kills: p.seasonKills, stealthKills: p.seasonStealthKills, deaths: p.seasonDeaths, daysSurvived: daysSurvivedFor(p), alive: p.alive && !p.out }))
          .sort((a, b) => b.kills - a.kills),
      });
      const supBits = [
        superlatives.firstBlood ? `🩸 First Blood: ${superlatives.firstBlood.name}` : null,
        superlatives.sneakiest ? `🥷 Sneakiest: ${superlatives.sneakiest.name} (${superlatives.sneakiest.stealthKills} stealth)` : null,
        superlatives.mostWanted ? `🎯 Most Wanted: ${superlatives.mostWanted.name} (${superlatives.mostWanted.bountyXp} XP in bounties placed)` : null,
        superlatives.duckMagnet ? `🦆 Duck Magnet: ${superlatives.duckMagnet.name} (${superlatives.duckMagnet.ducks} ducks)` : null,
      ].filter(Boolean);
      if (supBits.length) feed('xp', `Season ${state.league.season} superlatives — ${supBits.join(' • ')}`, me.id);
      applyXp(state, lastMan, XP.LAST_MAN, 'last-man', `Last Man — Season ${state.league.season}`);
      feed('xp', `SEASON ${state.league.season} CLOSED — ${lastMan.name} is the LAST MAN: +${XP.LAST_MAN} XP.`, me.id);
      if (deadliest && deadliest.seasonKills > 0) {
        applyXp(state, deadliest, XP.DEADLIEST_MAN, 'deadliest-man', `Deadliest Man — Season ${state.league.season} (${deadliest.seasonKills} kills)`);
        feed('xp', `${deadliest.name} is Deadliest Man with ${deadliest.seasonKills} kills: +${XP.DEADLIEST_MAN} XP.`, me.id);
      }
      // Season-close achievements (Last Man / Deadliest Man / Survivor /
      // Reaper via the archive) — paid once each via achievementAwards.
      state.players.forEach(p => awardAchievements(p));
      // Reset the season; career XP and ranks carry over untouched.
      state.league.season += 1;
      // The next season starts on the Jan 1 following the CLOSED season's
      // own start (Round 10) — computed from seasonStart itself, not
      // from whatever calendar year the close happens to land in, so a
      // season closed late (or in a test fixture set in the past) still
      // rolls to ITS next January 1.
      const closedStartMs = Date.parse(state.league.seasonStart);
      if (Number.isFinite(closedStartMs)) {
        const nextStart = new Date(closedStartMs);
        nextStart.setUTCFullYear(nextStart.getUTCFullYear() + 1);
        state.league.seasonStart = nextStart.toISOString();
      } else {
        const y = new Date().getUTCFullYear();
        state.league.seasonStart = `${y + 1}-01-01T05:00:00.000Z`;
      }
      state.league.phase = 'setup';
      state.league.markedManId = lastMan.id; // champion starts next season marked (champion's privilege: he also picks platform/class via settings)
      state.league.scrimmage = false;
      state.league.checkCall = null; // a running Location Check dies quietly with the season — no eliminations
      state.bounties = []; // last season's prices die with the season
      state.kills = [];
      state.dangerPairs = {};
      state.players.forEach(p => {
        p.alive = true; p.out = false; p.seasonKills = 0; p.scrimmageKills = 0;
        p.seasonStealthKills = 0; p.seasonDeaths = 0; p.seasonDucks = 0;
        p.killCancelCard = true; p.immuneUntil = null; p.diedAt = null;
        p.sharing = false; p.position = null;
        p.zoneStatus = null; p.lastZoneAnnounceAt = 0; p.driving = false; p.drvFast = 0; p.drvSlow = 0; p.lastFix = null;
        p.hunting = false; p.huntStartedAt = null;
      });
      feed('system', `Season ${state.league.season} setup is open. ${lastMan.name} starts as the marked man and picks the platform/class.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    return json(res, 404, { error: 'Unknown admin route' });
  }

  return json(res, 404, { error: 'Unknown route' });
}

// ── static PWA ───────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };
// HTML/JS/CSS (and the manifest) are the app itself: after a redeploy
// they must never be served stale from a browser cache, or members run
// last week's client against this week's server (Round 10). Media and
// other assets keep default caching.
const NO_CACHE_EXTS = new Set(['.html', '.js', '.css', '.webmanifest']);
function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...(NO_CACHE_EXTS.has(ext) ? { 'Cache-Control': 'no-cache' } : {}),
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { console.error(e); json(res, 500, { error: 'Server error' }); });
  } else serveStatic(req, res, url);
});
// Location Check scheduler (Round 7): a plain interval over stored
// timestamps. unref'd so it never keeps a dying process alive on its own.
setInterval(() => { try { tickCheckCall(); } catch (e) { console.error('check-call tick:', e); } }, CHECK_TICK_MS).unref();
server.listen(PORT, () => console.log(`Open Season app listening on :${PORT} (data: ${store.FILE})`));
