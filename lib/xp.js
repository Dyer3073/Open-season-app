'use strict';

// Marine career rank ladder (cumulative career XP thresholds) — locked Nov 6, 2026.
const RANKS = [
  { name: 'Recruit', min: 0 },
  { name: 'Boot', min: 100 },
  { name: 'Private', min: 250 },
  { name: 'PFC', min: 450 },
  { name: 'Lance Corporal', min: 700 },
  { name: 'Corporal', min: 1000 },
  { name: 'Sergeant', min: 1400 },
  { name: 'Staff Sergeant', min: 1900 },
  { name: 'Gunnery Sergeant', min: 2500 },
  { name: 'Master Sergeant', min: 3200 },
  { name: 'First Sergeant', min: 4000 },
  { name: 'Master Gunnery Sergeant', min: 5000 },
  { name: 'Sergeant Major', min: 6500 },
];

const XP = {
  KILL: 100,
  STEALTH_KILL: 125,
  REVERSE_KILL: 150,
  MARKED_MAN_BONUS: 50,
  LAST_MAN: 500,
  DEADLIEST_MAN: 250,
  EVENT_WIN: 300,
  DEATH: -75,
};

function rankIndexFor(xp) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) idx = i;
  return idx;
}
function rankFor(xp) {
  const i = rankIndexFor(xp);
  const next = RANKS[i + 1] || null;
  return {
    index: i,
    name: RANKS[i].name,
    min: RANKS[i].min,
    nextName: next ? next.name : null,
    nextMin: next ? next.min : null,
    progress: next ? Math.min(1, (xp - RANKS[i].min) / (next.min - RANKS[i].min)) : 1,
  };
}

let logSeq = 1;
function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + (logSeq++).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// Applies an XP delta to a player, enforcing:
//  - XP never drops below 0 (Recruit floor)
//  - a fresh promotion is protected from demotion on the player's very next death
//    (that death can only take XP down to the fresh rank's threshold, and consumes the protection)
//  - every change is written to the XP ledger
// Returns the actually-applied delta.
function applyXp(state, player, delta, reason, note) {
  const before = player.xp;
  let applied = delta;
  if (delta < 0 && reason === 'death' && player.freshPromotion) {
    const floor = RANKS[rankIndexFor(before)].min;
    applied = Math.max(delta, -(before - floor));
    player.freshPromotion = false; // protection consumed by this death
  }
  let after = before + applied;
  if (after < 0) after = 0;
  applied = after - before;
  player.xp = after;

  const oldRank = rankIndexFor(before);
  const newRank = rankIndexFor(after);
  if (newRank > oldRank) player.freshPromotion = true;
  if (newRank < oldRank) player.freshPromotion = false;

  state.xpLog.push({
    id: uid('xp'),
    ts: new Date().toISOString(),
    playerId: player.id,
    delta: applied,
    reason,
    note: note || '',
    balance: after,
  });
  return applied;
}

function deathXp(state, player, note) {
  return applyXp(state, player, XP.DEATH, 'death', note || 'Died');
}

module.exports = { RANKS, XP, rankFor, rankIndexFor, applyXp, deathXp, uid };
