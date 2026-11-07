'use strict';

// Marine career rank ladder (cumulative career XP thresholds) — locked Nov 6, 2026.
// insignia follows actual USMC enlisted structure (verified Nov 7, 2026):
// chevrons stack 1→3, rockers 1→4 for the SNCOs; center emblems — crossed
// rifles for Lance Corporal–Master Sergeant AND Gunnery Sergeant (the
// bursting bomb belongs to Master Gunnery Sergeant only), diamond for First
// Sergeant, star for Sergeant Major. PFC wears one chevron with NO rifles —
// the crossed rifles first appear at Lance Corporal (that's the real PFC/LCpl
// distinction). App-only ranks: Recruit = empty patch (recruits rate no
// insignia), Boot = dog tags, Private = one hollow chevron.
const RANKS = [
  { name: 'Recruit', min: 0, insignia: { chev: 0, rock: 0, emblem: 'empty' }, desc: 'No insignia, no mercy — everyone starts at zero.' },
  { name: 'Boot', min: 100, insignia: { chev: 0, rock: 0, emblem: 'tags' }, desc: 'Fresh out of boot camp. Dog tags on, eyes open.' },
  { name: 'Private', min: 250, insignia: { chev: 1, rock: 0, emblem: 'none', hollow: true }, desc: 'First step up — an outline chevron, not yet filled in.' },
  { name: 'PFC', min: 450, insignia: { chev: 1, rock: 0, emblem: 'none' }, desc: 'One chevron up. A Marine now, not a recruit.' },
  { name: 'Lance Corporal', min: 700, insignia: { chev: 1, rock: 0, emblem: 'rifles' }, desc: 'One chevron over crossed rifles — top of the junior ranks.' },
  { name: 'Corporal', min: 1000, insignia: { chev: 2, rock: 0, emblem: 'rifles' }, desc: 'First NCO rank. The blood stripe starts here.' },
  { name: 'Sergeant', min: 1400, insignia: { chev: 3, rock: 0, emblem: 'rifles' }, desc: 'Three up. The backbone of the Corps.' },
  { name: 'Staff Sergeant', min: 1900, insignia: { chev: 3, rock: 1, emblem: 'rifles' }, desc: 'First rocker — a staff NCO now.' },
  { name: 'Gunnery Sergeant', min: 2500, insignia: { chev: 3, rock: 2, emblem: 'rifles' }, desc: 'Two rockers. "Gunny" — the expert everyone listens to.' },
  { name: 'Master Sergeant', min: 3200, insignia: { chev: 3, rock: 3, emblem: 'rifles' }, desc: 'Three rockers, crossed rifles — the senior technical path (E-8).' },
  { name: 'First Sergeant', min: 4000, insignia: { chev: 3, rock: 3, emblem: 'diamond' }, desc: "The diamond — the commander's right hand (E-8)." },
  { name: 'Master Gunnery Sergeant', min: 5000, insignia: { chev: 3, rock: 4, emblem: 'bomb' }, desc: 'Four rockers and the bursting bomb — master of the trade (E-9).' },
  { name: 'Sergeant Major', min: 6500, insignia: { chev: 3, rock: 4, emblem: 'star' }, desc: 'The star — senior enlisted advisor. Top of the ladder (E-9).' },
];

const XP = {
  KILL: 100,
  STEALTH_KILL: 125,
  MARKED_MAN_BONUS: 50,
  LAST_MAN: 500,
  DEADLIEST_MAN: 250,
  EVENT_WIN: 300,
  DEATH: -75,
  DUCK_OF_SHAME: -50,
  ACHIEVEMENT: 25, // paid once per achievement per player (see server awardAchievements)
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
// `killId` (optional) links the entry to a kill record so Kill Cancel clawbacks
// and re-credits can be netted out of career stats (see lib/achievements.js).
// Returns the actually-applied delta.
function applyXp(state, player, delta, reason, note, killId) {
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
    killId: killId || null,
    balance: after,
  });
  return applied;
}

function deathXp(state, player, note, killId) {
  return applyXp(state, player, XP.DEATH, 'death', note || 'Died', killId);
}

module.exports = { RANKS, XP, rankFor, rankIndexFor, applyXp, deathXp, uid };
