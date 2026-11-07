'use strict';

// ── Career stats + achievements ──────────────────────────────────────────────
// Stats are DERIVED from the XP ledger (state.xpLog), the live board, and the
// season archive (state.archive). Ledger entries written by a kill carry that
// kill's id, so a kill that was voided by a Kill Cancel (and not restored by
// an override) nets out of every career count: a canceled kill counts for
// NOTHING, exactly as if it never happened — the ledger keeps the audit trail.
// Season-scope counts (Deadliest Man, superlatives) come from the server's
// season counters instead, which are decremented on cancel / restored on
// override the same way.
// Each achievement pays +25 career XP the FIRST time it unlocks — payment
// lives in server.js (awardAchievements), which records paid ids on
// player.achievementAwards so recomputation here can never double-pay. (If a
// kill is canceled AFTER its achievements were paid, the achievement XP is
// NOT clawed back — only the kill's own XP effects are voided.)
// No achievement is XP-threshold-based, so paying XP for one can never unlock
// another (no feedback loop). Scrimmage play never writes ledger entries, so
// it can never unlock anything here.
// Kill Cancels and Overrides are recorded as zero-XP ledger markers
// ('kill-cancel-played' / 'override') so they stay countable after the
// season's kill list is wiped at close.

// Kill ids whose effects are currently voided FOR THIS PLAYER: clawed back by
// a Kill Cancel ('kill-cancel' entries) and not since re-credited by an
// override ('kill-restored' entries).
function voidedKillIds(state, playerId) {
  const log = state.xpLog || [];
  const voided = new Set();
  for (const e of log) {
    if (e.playerId !== playerId || !e.killId) continue;
    if (e.reason === 'kill-cancel') voided.add(e.killId);
    if (e.reason === 'kill-restored') voided.delete(e.killId);
  }
  return voided;
}

function playerStats(state, player) {
  const log = (state.xpLog || []).filter(e => e.playerId === player.id);
  const voided = voidedKillIds(state, player.id);
  const live = e => !(e.killId && voided.has(e.killId));
  const count = reason => log.filter(e => e.reason === reason).length;
  const netCount = reason => log.filter(e => e.reason === reason && live(e)).length;
  const archive = state.archive || [];
  let maxSeasonKills = player.seasonKills || 0;
  let survivor = false;
  for (const rec of archive) {
    const row = (rec.standings || []).find(s => s.playerId === player.id);
    if (row) {
      if (row.kills > maxSeasonKills) maxSeasonKills = row.kills;
      if (row.alive) survivor = true;
    }
  }
  // Deaths: every 'death' entry, minus the kills whose death charge was
  // refunded by a Kill Cancel (one 'kill-cancel' refund entry per canceled
  // kill). An override re-charges with a fresh 'death' entry for the same
  // kill, which lands the count back at exactly 1 for that kill.
  const refundedDeaths = new Set(log.filter(e => e.reason === 'kill-cancel' && e.killId).map(e => e.killId)).size;
  return {
    kills: netCount('kill'),
    stealthKills: netCount('stealth-kill'),
    killCancels: count('kill-cancel-played'),
    overrides: count('override'),
    markedManKills: netCount('marked-man-bonus'),
    deaths: count('death') - refundedDeaths,
    eventWins: count('event-win'),
    ducks: count('duck-of-shame'),
    bountyCollections: netCount('bounty'),
    bountyXp: log.filter(e => e.reason === 'bounty' && live(e)).reduce((a, e) => a + e.delta, 0),
    lastManTitles: count('last-man'),
    deadliestTitles: count('deadliest-man'),
    maxSeasonKills,
    survivor,
  };
}
// career kills = every kill that currently stands, scored as killer of record
function careerKills(stats) { return stats.kills + stats.stealthKills; }

const ACHIEVEMENTS = [
  { id: 'first-kill', name: 'First Kill', desc: 'Score your first confirmed kill.', test: s => careerKills(s) >= 1 },
  { id: 'stealth-kill', name: 'Silent Killer', desc: 'Land a confirmed stealth kill.', test: s => s.stealthKills >= 1 },
  { id: 'kill-cancel', name: 'Kill Cancel', desc: 'Play your Kill Cancel card and void a kill on you — nobody dies, and you walk away immune.', test: s => s.killCancels >= 1 },
  { id: 'override', name: 'Override', desc: 'Burn your own Kill Cancel to override a cancel — your kill stands.', test: s => s.overrides >= 1 },
  { id: 'marked-man-kill', name: 'Giant Slayer', desc: 'Take out the marked man.', test: s => s.markedManKills >= 1 },
  { id: 'five-kill-season', name: 'Reaper', desc: 'Score 5 kills in a single season.', test: s => s.maxSeasonKills >= 5 },
  { id: 'bounty-hunter', name: 'Bounty Hunter', desc: 'Collect a bounty on a kill.', test: s => s.bountyCollections >= 1 },
  { id: 'event-win', name: 'Combo Champion', desc: 'Win a Da Boyz combo event (+300 XP).', test: s => s.eventWins >= 1 },
  { id: 'season-survivor', name: 'Survivor', desc: 'Still alive when a season closes.', test: s => s.survivor },
  { id: 'last-man', name: 'Last Man', desc: 'Be the last hunter standing at season close.', test: s => s.lastManTitles >= 1 },
  { id: 'deadliest-man', name: 'Deadliest Man', desc: 'Finish a season with the most kills.', test: s => s.deadliestTitles >= 1 },
];

function achievementsFor(state, player) {
  const stats = playerStats(state, player);
  return {
    stats,
    list: ACHIEVEMENTS.map(a => ({ id: a.id, name: a.name, desc: a.desc, earned: !!a.test(stats) })),
  };
}

module.exports = { ACHIEVEMENTS, playerStats, achievementsFor, careerKills, voidedKillIds };
