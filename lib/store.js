'use strict';

// ── Swappable persistence ────────────────────────────────────────────────────
// The whole store is ONE module on purpose: today it is a JSON file under
// DATA_DIR; tomorrow it can be swapped for SQLite/Postgres by re-implementing
// load()/save() here without touching server.js.
// NOTE (Render free tier): the filesystem is ephemeral — without a persistent
// disk (or moving this module to a hosted DB) data resets on redeploy/restart.

const fs = require('fs');
const path = require('path');

const FALLBACK_DIR = path.join(__dirname, '..', 'data');
let DATA_DIR = process.env.DATA_DIR || FALLBACK_DIR;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  // e.g. Render free tier: DATA_DIR=/var/data but no persistent disk is
  // mounted there, so /var/data cannot be created (EACCES). Fall back to the
  // app-local data dir (ephemeral, same as the rest of the free filesystem)
  // instead of crashing. When a disk IS mounted at DATA_DIR, it is used.
  console.warn(`DATA_DIR ${DATA_DIR} not usable (${e.code || e.message}); falling back to ${FALLBACK_DIR}`);
  DATA_DIR = FALLBACK_DIR;
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const FILE = path.join(DATA_DIR, 'data.json');

const ROSTER = [
  { name: 'Christian Dyer', role: 'Founder' },
  { name: 'Isaiah Twigg', role: 'Vice' },
  { name: 'Bryce Harmon', role: 'Member', watching: true },
  { name: 'David Brockmen', role: 'Member' },
  { name: 'Korben Beecham', role: 'Member' },
  { name: 'Norton Bradford Ray', role: 'Member' },
  { name: 'Wilber Flores', role: 'Member' },
  { name: 'Josh LaBozetta', role: 'Member' },
  { name: 'Memphis Seadler', role: 'Member' },
  { name: 'Logan Vance', role: 'Member' },
  { name: 'Kaleb Edwards', role: 'Member' },
  { name: 'Joshua Grinnell', role: 'Member' },
  { name: 'Dylan George', role: 'Member' },
  { name: 'Nick J George', role: 'Member' },
  { name: 'Garrison Peak', role: 'Member' },
  { name: 'El Bashir Ndiaye', role: 'Member' },
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function seed() {
  const seasonStart = process.env.SEASON_START_ISO || '2027-01-01T05:00:00.000Z'; // Jan 1, 2027 00:00 EST
  return {
    league: {
      name: 'Da Boyz — Open Season',
      season: 1,
      phase: 'setup', // 'setup' | 'closed' — 'live' is derived from seasonStart
      seasonStart,
      platform: null,
      weaponClass: null,
      pot: 0,
      markedManId: null,
      lastBackupAt: null, // ISO ts of the last admin backup download (Round 5 reminder)
      checkSettings: { intervalMin: 15, deadlineMin: 60 }, // Location Check defaults (Round 7) — snapshot at call start
      checkCall: null, // the active Location Check (Round 7), or null: {startedBy, startedAtMs, deadlineAtMs, intervalMin, deadlineMin, mode, lastReminderAtMs, targets:[{id, checkedInAt, done, outcome}]}
      scrimmage: false, // December practice mode: kills resolve, nothing counts (no XP/ledger)
      createdAt: new Date().toISOString(),
    },
    players: ROSTER.map((r, i) => ({
      id: slug(r.name),
      name: r.name,
      role: r.role,
      watching: !!r.watching,
      claimed: false,
      pinHash: null,
      token: null,
      xp: 0,
      freshPromotion: false,
      alive: true,
      out: false,
      seasonKills: 0,
      scrimmageKills: 0,
      seasonStealthKills: 0, // season-scope counters (net of cancels) for superlatives
      seasonDeaths: 0,
      seasonDucks: 0,
      achievementAwards: [], // achievement ids already PAID (+25 XP once each; career-level, never reset)
      pushSubs: [], // Web Push subscriptions [{endpoint, keys:{p256dh, auth}}]
      backupSnoozeUntil: 0, // ms epoch — per-admin snooze of the stale-backup reminder (Round 5)
      sharing: false,
      hunting: false, // Hunt Mode (Round 6): persisted toggle — screen awake + hot GPS while the app is open
      huntStartedAt: null, // ISO ts the current hunt began (banner elapsed time)
      lastBlastAt: 0, // ms epoch of the last hunt-start push blast (30-min per-hunter cooldown)
      lastPingAt: 0, // ms epoch of the last league ping (Round 7, 60-min per-hunter cooldown)
      huntHintSeen: false, // the one-time "Hunt Mode eats battery" hint was shown
      position: null, // {lat, lng, ts}
      safeZones: [], // {id, label, lat, lng, radius}
      killCancelCard: true, // the one Kill Cancel card per season (was reverseCard in round 1)
      immuneUntil: null, // ISO ts — Kill Cancel shield: no new kill claims land while set
      zoneStatus: null, // {zoneId, label, since} — public safe-zone presence (LABEL only; coordinates never leave the server)
      lastZoneAnnounceAt: 0, // ms epoch of the last safe-zone feed announcement (15-min re-entry anti-spam cooldown)
      driving: false, // automatic driving mode: pin hidden, claims rejected — a third state, NEVER an elimination
      drvFast: 0, drvSlow: 0, // consecutive fast/slow fix streaks driving the driving-mode state machine
      lastFix: null, // {lat, lng, t} — previous fix, for the position-derived speed fallback
      diedAt: null, // ISO ts of the death that currently stands (days-survived math)
      callsign: null, // hunter-chosen callsign (≤16 chars) shown across the app
      avatar: null, // one emoji shown on pins/profiles instead of initials
      walkthroughSeen: false, // first-open 3-card walkthrough dismissed
      joinedAt: null,
      order: i,
    })),
    messages: [
      {
        id: 'sys-welcome',
        ts: new Date().toISOString(),
        playerId: null,
        kind: 'system',
        text: 'League created. Season 1 is in setup — enter the code, claim your spot, set your safe zones. The hunt goes live January 1, 2027.',
      },
    ],
    kills: [],
    xpLog: [],
    bounties: [], // [{id, targetId, amount, placedBy, note, createdAt}]
    bountyHistory: [], // every bounty ever placed: [{season, targetId, amount, placedBy, ts}] — feeds the Most Wanted superlative
    dangerPairs: {}, // "idA|idB" (sorted) → last danger-alert ts (ms); 30-min cooldown per pair
    archive: [], // closed seasons: [{season, closedAt, lastManId, lastManName, deadliestId, deadliestName, deadliestKills, superlatives:{...}, standings:[{playerId, name, kills, stealthKills, deaths, daysSurvived, alive}]}]
  };
}

// Fill defaults for fields added after a data.json was first written, so old
// saves keep loading after an upgrade.
function normalize(data) {
  if (!Array.isArray(data.messages)) data.messages = [];
  if (!Array.isArray(data.kills)) data.kills = [];
  if (!Array.isArray(data.xpLog)) data.xpLog = [];
  if (!Array.isArray(data.bounties)) data.bounties = [];
  if (!Array.isArray(data.bountyHistory)) data.bountyHistory = [];
  if (!data.dangerPairs || typeof data.dangerPairs !== 'object') data.dangerPairs = {};
  if (!Array.isArray(data.archive)) data.archive = [];
  if (typeof data.league.scrimmage !== 'boolean') data.league.scrimmage = false;
  if (data.league.lastBackupAt === undefined) data.league.lastBackupAt = null;
  // Round 7: Location Check settings + active-call slot.
  if (!data.league.checkSettings || typeof data.league.checkSettings !== 'object') data.league.checkSettings = { intervalMin: 15, deadlineMin: 60 };
  if (typeof data.league.checkSettings.intervalMin !== 'number' || !(data.league.checkSettings.intervalMin >= 5 && data.league.checkSettings.intervalMin <= 120)) data.league.checkSettings.intervalMin = 15;
  if (typeof data.league.checkSettings.deadlineMin !== 'number' || !(data.league.checkSettings.deadlineMin >= 15 && data.league.checkSettings.deadlineMin <= 480)) data.league.checkSettings.deadlineMin = 60;
  if (data.league.checkCall === undefined) data.league.checkCall = null;
  for (const m of data.messages) {
    if (!m.reactions || typeof m.reactions !== 'object') m.reactions = {};
  }
  for (const p of data.players) {
    if (!Array.isArray(p.pushSubs)) p.pushSubs = [];
    if (typeof p.backupSnoozeUntil !== 'number') p.backupSnoozeUntil = 0;
    if (!Array.isArray(p.achievementAwards)) p.achievementAwards = [];
    if (typeof p.scrimmageKills !== 'number') p.scrimmageKills = 0;
    if (typeof p.seasonStealthKills !== 'number') p.seasonStealthKills = 0;
    if (typeof p.seasonDeaths !== 'number') p.seasonDeaths = 0;
    if (typeof p.seasonDucks !== 'number') p.seasonDucks = 0;
    if (!Array.isArray(p.safeZones)) p.safeZones = [];
    // Round 1 → 2: the Reverse Kill card became the Kill Cancel card.
    if (typeof p.killCancelCard !== 'boolean') p.killCancelCard = typeof p.reverseCard === 'boolean' ? p.reverseCard : true;
    delete p.reverseCard;
    if (p.immuneUntil === undefined) p.immuneUntil = null;
    if (p.zoneStatus === undefined) p.zoneStatus = null;
    if (typeof p.lastZoneAnnounceAt !== 'number') p.lastZoneAnnounceAt = 0;
    if (typeof p.driving !== 'boolean') p.driving = false;
    if (typeof p.drvFast !== 'number') p.drvFast = 0;
    if (typeof p.drvSlow !== 'number') p.drvSlow = 0;
    if (p.lastFix === undefined) p.lastFix = null;
    if (p.diedAt === undefined) p.diedAt = null;
    if (p.callsign === undefined) p.callsign = null;
    if (p.avatar === undefined) p.avatar = null;
    if (typeof p.hunting !== 'boolean') p.hunting = false;
    if (p.huntStartedAt === undefined) p.huntStartedAt = null;
    if (typeof p.lastBlastAt !== 'number') p.lastBlastAt = 0;
    if (typeof p.lastPingAt !== 'number') p.lastPingAt = 0;
    if (typeof p.huntHintSeen !== 'boolean') p.huntHintSeen = false;
    if (typeof p.walkthroughSeen !== 'boolean') p.walkthroughSeen = false;
  }
  return data;
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.league && Array.isArray(data.players)) return normalize(data);
  } catch (_) { /* missing/corrupt → seed fresh */ }
  const fresh = seed();
  save(fresh);
  return fresh;
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, FILE);
}

// Restore path (Round 3): a validated backup state is normalized (defaults
// filled, exactly like a disk load) and committed through save() — which is
// already atomic (tmp file + rename), so a restore never leaves a half-written
// data.json behind.
module.exports = { load, save, normalize, DATA_DIR, FILE };
