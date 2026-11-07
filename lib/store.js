'use strict';

// ── Swappable persistence ────────────────────────────────────────────────────
// The whole store is ONE module on purpose: today it is a JSON file under
// DATA_DIR; tomorrow it can be swapped for SQLite/Postgres by re-implementing
// load()/save() here without touching server.js.
// NOTE (Render free tier): the filesystem is ephemeral — without a persistent
// disk (or moving this module to a hosted DB) data resets on redeploy/restart.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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
      sharing: false,
      position: null, // {lat, lng, ts}
      safeZones: [], // {id, label, lat, lng, radius}
      reverseCard: true,
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
  };
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.league && Array.isArray(data.players)) return data;
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

module.exports = { load, save, DATA_DIR, FILE };
