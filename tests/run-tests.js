'use strict';

// Open Season — integration test suites.
// Round 2: the Reverse Kill card is retired; the KILL CANCEL card replaces it
// (void via offsetting ledger entries + 24h immunity, killer override burns
// his own card). Suites cover: setup phase, scrimmage cancel/override flow,
// the live kill → cancel → override economy with exact XP math, bounty
// restore/re-collect, proof photos, immunity claim rejection, danger
// proximity alerts (+ privacy + cooldown), feed reactions, callsigns /
// avatars, walkthrough flag, superlatives at season close, achievement
// pay-once semantics, and full Web Push crypto verification (VAPID JWT
// signature + aes128gcm decryption), including the cancel/override pushes.
//
// Round 4 adds Suite 6: safe-zone entry announcements (label-only public
// status, no coordinate leakage, once per stay, 15-min re-entry cooldown)
// and automatic driving mode (device-speed and position-derived paths,
// 2-fix sustained enter/exit, pin hiding, claim rejection, danger-alert
// suppression, and the iron rule that driving NEVER eliminates — live or
// scrimmage).
//
// Round 5 adds Suite 7: the stale-backup reminder (downloads stamp
// league.lastBackupAt; admins-only backup block in the payload; stale when
// missing/>7 days during a live season or scrimmage, quiet in plain setup;
// per-admin 24h snooze) and the self-service test push (own subscriptions
// only, targeted/accepted counts, dead-sub pruning, payload decryption).
//
// Round 6 adds Suite 8: Hunt Mode — the toggle + sharing cascade (on turns
// sharing on, off leaves it untouched), watching/dead hunters refused, the
// anonymous hunt-start blast (transition-only, never to self, 30-min
// cooldown under toggle spam, suppressed in plain setup, allowed in
// scrimmage, one anonymous feed entry per blast), the server-side fresh
// vs stale hunting marker, safe-zone/driving interplay while hunting, and
// old-save/restore loads with the new fields defaulted. The blast
// cooldown is env-shortened to 4 s on the live instance.
//
// Round 7 adds Suite 9: the league ping (named push + feed, recipients =
// other claimed/alive/non-watching hunters, per-hunter 60-min cooldown —
// env-shortened to 4 s — with a 429 + retryAfterMs, dead/watching senders
// refused, allowed in setup) and the Location Check (admin settings with
// range validation, snapshot-at-start semantics, live vs scrimmage target
// snapshots, check-in by plain / safe-zone-hidden / driving fixes, the
// no-location-data payload assertion, interval reminders to stragglers
// only, sleep catch-up = exactly one reminder, live deadline elimination
// with the XP ledger untouched and exactly-once processing, scrimmage
// deadline with zero eliminations, kill-mid-call targets skipped, cancel
// voiding, and quiet close when a scrimmage ends mid-call). The check
// scheduler tick is env-shortened to 300 ms; call timelines are driven
// by doctoring stored timestamps through backup/restore.
//
// Run:  node tests/run-tests.js
// Spawns throwaway servers on scratch ports with temp DATA_DIRs. No network
// beyond localhost. Exits non-zero if any check fails.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const APP_DIR = path.join(__dirname, '..');
let passed = 0, failed = 0, suiteName = '';
function suite(name) { suiteName = name; console.log(`\n══ ${name} ══`); }
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ' — got ' + JSON.stringify(extra) : ''}`); }
}

async function startServer(port, seasonStartIso, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-test-'));
  const child = spawn('node', ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SEASON_START_ISO: seasonStartIso, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(`[server ${port}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/roster'); if (r.ok) return { child, base, dataDir }; } catch (_) { }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('server did not start on ' + port);
}

async function req(base, token, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
// Raw-body request (backup download / restore upload don't go through the
// JSON body helper — restore bodies are whole files).
async function rawReq(base, token, method, p, rawBody) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: rawBody,
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
async function claim(base, id) {
  const r = await req(base, null, 'POST', '/api/claim', { playerId: id, code: 'BOYZ-2027', pin: '1234' });
  if (r.status !== 200) throw new Error(`claim ${id} failed: ${JSON.stringify(r.json)}`);
  return r.json.token;
}
const me = (state, id) => state.players.find(p => p.id === id);
const ach = (state, id, achId) => { const p = me(state, id); const a = p && p.achievements.find(x => x.id === achId); return a ? a.earned : undefined; };
const achEntries = (state, id) => (state.xpLog || []).filter(e => e.playerId === id && e.reason === 'achievement');
const ledger = (state, id, reason) => (state.xpLog || []).filter(e => e.playerId === id && e.reason === reason);

const F = 'christian-dyer', V = 'isaiah-twigg', A = 'david-brockmen', B = 'korben-beecham', C = 'wilber-flores', D = 'memphis-seadler', WATCH = 'bryce-harmon';
// 1×1 transparent PNG, used as a valid proof photo.
const PNG = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };

// ─────────────────────────────────────────────────────────────────────────────
async function suiteSetup() {
  suite('Suite 1 — setup phase, scrimmage cancel/override, payload shape, push subscribe');
  const { child, base, dataDir } = await startServer(3411, '2027-01-01T05:00:00.000Z');
  try {
    const roster = await req(base, null, 'GET', '/api/roster');
    check('roster has 16 players', roster.json.players.length === 16, roster.json.players.length);
    const bad = await req(base, null, 'POST', '/api/claim', { playerId: F, code: 'WRONG', pin: '1234' });
    check('claim with wrong league code → 403', bad.status === 403, bad.status);
    const tF = await claim(base, F), tV = await claim(base, V), tB = await claim(base, B);
    let tA = await claim(base, A);
    const badPin = await req(base, null, 'POST', '/api/login', { playerId: A, pin: '9999' });
    check('login with wrong PIN → 403', badPin.status === 403, badPin.status);
    const login = await req(base, null, 'POST', '/api/login', { playerId: A, pin: '1234' });
    check('login with correct PIN → 200', login.status === 200, login.status);
    tA = login.json.token; // NOTE: login rotates the session token (pre-existing app behavior) — the claim token is dead from here on

    let st = (await req(base, tF, 'GET', '/api/state')).json;
    check('phase is setup', st.league.phase === 'setup', st.league.phase);
    check('payload: bounties + archive arrays present', Array.isArray(st.bounties) && Array.isArray(st.archive));
    check('payload: 11 achievement defs', st.achievementDefs.length === 11, st.achievementDefs.length);
    check('payload: Kill Cancel + Override achievements replace the Reverse ones',
      st.achievementDefs.some(a => a.id === 'kill-cancel') && st.achievementDefs.some(a => a.id === 'override') &&
      !st.achievementDefs.some(a => a.id === 'reverse-kill') && !st.achievementDefs.some(a => a.id === 'counter-reverse'));
    check('payload: ranks carry insignia + descriptions', st.ranks.every(r => r.insignia && typeof r.desc === 'string' && r.desc.length > 5));
    check('payload: players carry stats + achievements', st.players.every(p => p.stats && Array.isArray(p.achievements) && p.achievements.length === 11));
    check('payload: league.scrimmage false, cancel window 24h', st.league.scrimmage === false && st.league.cancelWindowHours === 24);
    check('payload: duck + achievement XP in table, REVERSE_KILL gone', st.xpTable.DUCK_OF_SHAME === -50 && st.xpTable.ACHIEVEMENT === 25 && st.xpTable.REVERSE_KILL === undefined);
    check('payload: my card shows Kill Cancel in hand + walkthrough unseen', st.me.killCancelCard === true && st.me.walkthroughSeen === false);
    check('payload: daysSurvived is null during setup', st.me.daysSurvived === null, st.me.daysSurvived);

    // walkthrough dismissal persists on the player record
    st = (await req(base, tF, 'POST', '/api/walkthrough', { seen: true })).json.state;
    check('walkthrough: seen flag persists', st.me.walkthroughSeen === true);

    // tutorial assets ship in public/
    const mp4 = await fetch(base + '/kill-cancel-tutorial.mp4');
    check('static: kill-cancel-tutorial.mp4 served', mp4.status === 200, mp4.status);
    const png = await fetch(base + '/kill-cancel-tutorial.png');
    check('static: kill-cancel-tutorial.png served', png.status === 200, png.status);

    const locked = await req(base, tF, 'POST', '/api/kills', { victimId: A });
    check('kill claim locked in setup → 403', locked.status === 403, locked.status);

    // location: sharing + position visible to others, safe zone hides it
    await req(base, tF, 'POST', '/api/sharing', { on: true });
    await req(base, tF, 'POST', '/api/position', { lat: 40.5, lng: -83.1 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('shared position visible to another player, with timestamp', !!me(st, F).position && typeof me(st, F).position.ts === 'string', me(st, F).position);
    await req(base, tF, 'POST', '/api/safe-zones', { label: 'home', lat: 40.5, lng: -83.1, radius: 150 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('position inside own safe zone is hidden from others', me(st, F).position === null, me(st, F).position);
    check('no danger alerts in plain setup', st.messages.every(m => m.kind !== 'danger'));

    // push subscribe plumbing
    const key = await req(base, tF, 'GET', '/api/push/key');
    check('GET /api/push/key returns a VAPID public key', key.status === 200 && typeof key.json.publicKey === 'string' && key.json.publicKey.length > 80, key.json);
    check('vapid.json persisted in DATA_DIR', fs.existsSync(path.join(dataDir, 'vapid.json')));
    const badSub = await req(base, tA, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'x' } });
    check('subscribe with missing keys → 400', badSub.status === 400, badSub.status);
    const goodSub = await req(base, tA, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'http://127.0.0.1:9/dead', keys: { p256dh: 'BP' + 'A'.repeat(84), auth: 'AAAAAAAAAAAAAAAAAAAAAA' } } });
    check('subscribe with full subscription → 200', goodSub.status === 200, goodSub.status);

    // ── scrimmage ──
    let r = await req(base, tA, 'POST', '/api/admin/scrimmage', { on: true });
    check('non-admin cannot toggle scrimmage → 403', r.status === 403, r.status);
    r = await req(base, tF, 'POST', '/api/admin/scrimmage', { on: true });
    check('founder opens scrimmage', r.status === 200 && r.json.state.league.scrimmage === true);
    const claimKill = await req(base, tF, 'POST', '/api/kills', { victimId: A, stealth: false });
    check('scrimmage unlocks kill claims during setup', claimKill.status === 200, claimKill.status);
    const killId = claimKill.json.kill.id;
    r = await req(base, tA, 'POST', `/api/kills/${killId}/confirm`, {});
    st = r.json.state;
    check('scrimmage kill resolves: victim down, killer practice kill counted', me(st, A).alive === false && me(st, F).scrimmageKills === 1 && me(st, F).seasonKills === 0);
    check('scrimmage pays NO XP and writes NO ledger', me(st, F).xp === 0 && me(st, A).xp === 0 && (st.xpLog || []).length === 0, st.xpLog);
    check('scrimmage death is not an OUT', me(st, A).out === false);
    check('scrimmage unlocks NO achievements', me(st, F).achievements.every(a => !a.earned));
    // sharing off mid-scrimmage must not eliminate
    await req(base, tA, 'POST', '/api/sharing', { on: true });
    r = await req(base, tA, 'POST', '/api/sharing', { on: false });
    check('sharing off during scrimmage does not eliminate', me(r.json.state, A).out === false && me(r.json.state, A).alive === false);
    // Kill Cancel in scrimmage: void + immunity, still zero XP
    r = await req(base, tA, 'POST', `/api/kills/${killId}/cancel`, {});
    st = r.json.state;
    check('scrimmage cancel: kill voided, victim back up with immunity, practice kill un-counted', me(st, A).alive === true && !!me(st, A).immuneUntil && me(st, F).scrimmageKills === 0 && me(st, A).xp === 0 && (st.xpLog || []).length === 0);
    check('scrimmage: claims on an immune hunter are rejected → 400', (await req(base, tF, 'POST', '/api/kills', { victimId: A })).status === 400);
    // Override in scrimmage: the kill stands again, both cards spent
    r = await req(base, tF, 'POST', `/api/kills/${killId}/counter-cancel`, {});
    st = r.json.state;
    check('scrimmage override: original kill stands, immunity gone, still no XP', me(st, F).alive === true && me(st, A).alive === false && me(st, A).immuneUntil === null && me(st, F).scrimmageKills === 1 && (st.xpLog || []).length === 0);
    r = await req(base, tF, 'POST', '/api/admin/scrimmage', { on: false });
    st = r.json.state;
    check('ending scrimmage resets practice board clean', st.league.scrimmage === false && st.kills.length === 0 && st.players.every(p => p.alive && !p.out && p.scrimmageKills === 0 && p.xp === 0 && p.immuneUntil === null) && st.me.killCancelCard === true);
    check('kill claims locked again after scrimmage ends', (await req(base, tF, 'POST', '/api/kills', { victimId: A })).status === 403);
  } finally { child.kill(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suiteLive() {
  suite('Suite 2 — live season: kills, Kill Cancel, override, photos, danger, reactions, superlatives');
  const { child, base } = await startServer(3412, '2000-01-01T05:00:00.000Z');
  try {
    const tF = await claim(base, F), tV = await claim(base, V), tA = await claim(base, A),
      tB = await claim(base, B), tC = await claim(base, C), tD = await claim(base, D);
    let st = (await req(base, tF, 'GET', '/api/state')).json;
    check('phase is live with past season start', st.league.phase === 'live', st.league.phase);
    check('days survived already counting in a live season', me(st, A).daysSurvived > 0, me(st, A).daysSurvived);

    // bounty validation
    check('non-admin bounty → 403', (await req(base, tA, 'POST', '/api/admin/bounty', { targetId: B, amount: 100 })).status === 403);
    check('bounty below 25 → 400', (await req(base, tF, 'POST', '/api/admin/bounty', { targetId: B, amount: 10 })).status === 400);
    check('bounty above 500 → 400', (await req(base, tF, 'POST', '/api/admin/bounty', { targetId: B, amount: 501 })).status === 400);
    check('bounty on watching member → 400', (await req(base, tF, 'POST', '/api/admin/bounty', { targetId: WATCH, amount: 100 })).status === 400);
    await req(base, tF, 'POST', '/api/admin/bounty', { targetId: B, amount: 100, note: 'test' });
    st = (await req(base, tV, 'POST', '/api/admin/bounty', { targetId: B, amount: 150 })).json.state;
    check('bounties stack on a target', st.bounties.length === 2 && me(st, B).bountyTotal === 250, me(st, B).bountyTotal);

    // marked man = memphis
    await req(base, tF, 'POST', '/api/admin/settings', { markedManId: D });

    // photo validation (before any real claim)
    check('proof photo with a bad mime → 400', (await req(base, tA, 'POST', '/api/kills', { victimId: C, photo: { mime: 'image/gif', data: PNG.data } })).status === 400);
    check('proof photo over 2.5 MB → 400', (await req(base, tA, 'POST', '/api/kills', { victimId: C, photo: { mime: 'image/png', data: Buffer.alloc(2_700_000, 7).toString('base64') } })).status === 400);

    // Kill 1: david takes korben (plain, with proof photo) → +100 kill, +250 bounties, +25 first-kill, +25 bounty-hunter
    const k1 = await req(base, tA, 'POST', '/api/kills', { victimId: B, stealth: false, photo: PNG });
    check('live kill claim with photo → 200', k1.status === 200 && k1.json.kill.photo && k1.json.kill.photo.data === PNG.data, k1.status);
    await req(base, tB, 'POST', `/api/kills/${k1.json.kill.id}/confirm`, {});
    st = (await req(base, tF, 'GET', '/api/state')).json; // founder snapshot carries the ledger
    check('kill 1: killer XP = 100 + 250 bounty + 2×25 achievements = 400', me(st, A).xp === 400, me(st, A).xp);
    check('kill 1: bounties consumed', st.bounties.length === 0 && me(st, B).bountyTotal === 0);
    check('kill 1: victim floored at 0 XP, dead, days survived recorded', me(st, B).xp === 0 && me(st, B).alive === false && me(st, B).daysSurvived > 0);
    check('kill 1: achievements earned (first-kill, bounty-hunter)', ach(st, A, 'first-kill') === true && ach(st, A, 'bounty-hunter') === true && ach(st, A, 'stealth-kill') === false);
    check('kill 1: photo rides the kill record', (() => { const k = st.kills.find(x => x.id === k1.json.kill.id); return k && k.photo && k.photo.mime === 'image/png'; })());
    check('kill 1: ledger achievement entries for david = 2 × +25', achEntries(st, A).length === 2 && achEntries(st, A).every(e => e.delta === 25), achEntries(st, A).length);
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('refetching state never re-pays achievements', me(st, A).xp === 400, me(st, A).xp);

    // Kill Cancel: korben voids kill 1 — everything unwinds, he is immune
    st = (await req(base, tB, 'POST', `/api/kills/${k1.json.kill.id}/cancel`, {})).json.state;
    check('cancel: victim alive again, immune, +25 Kill Cancel achievement → 25 XP', me(st, B).alive === true && !!me(st, B).immuneUntil && me(st, B).xp === 25, [me(st, B).alive, me(st, B).xp]);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('cancel: killer XP clawed back 400 − 100 kill − 250 bounty = 50', me(st, A).xp === 50, me(st, A).xp);
    check('cancel: season kill un-counted, bounties restored to the board', me(st, A).seasonKills === 0 && st.bounties.length === 2 && me(st, B).bountyTotal === 250);
    check('cancel: offsetting ledger entries written (2 clawbacks for killer, refund for victim)',
      ledger(st, A, 'kill-cancel').length === 2 && ledger(st, A, 'kill-cancel').reduce((a, e) => a + e.delta, 0) === -350 &&
      ledger(st, B, 'kill-cancel').length === 1 && ledger(st, B, 'kill-cancel-played').length === 1);
    check('cancel: stats net to nothing (killer kills 0, victim deaths 0)', me(st, A).stats.kills === 0 && me(st, A).stats.bountyCollections === 0 && me(st, B).stats.deaths === 0 && me(st, B).stats.killCancels === 1);
    check('cancel: kill status canceled, banner in feed', st.kills.find(k => k.id === k1.json.kill.id).status === 'canceled' && st.messages.some(m => m.kind === 'cancel'));
    check('cancel: claims on the immune victim are rejected → 400', (await req(base, tA, 'POST', '/api/kills', { victimId: B })).status === 400);
    check('cancel: cannot cancel the same kill twice → 404', (await req(base, tB, 'POST', `/api/kills/${k1.json.kill.id}/cancel`, {})).status === 404);

    // Override: david burns his own card — the kill stands again
    st = (await req(base, tA, 'POST', `/api/kills/${k1.json.kill.id}/counter-cancel`, {})).json.state;
    check('override: killer re-credited 50 + 100 restored + 250 bounty re-collected + 25 Override ach = 425', me(st, A).xp === 425, me(st, A).xp);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('override: victim dead again, immunity dropped, death re-charged to the floor (25 → 0)', me(st, B).alive === false && me(st, B).immuneUntil === null && me(st, B).xp === 0, [me(st, B).alive, me(st, B).xp]);
    check('override: kill stands in the tallies, bounties consumed again', me(st, A).seasonKills === 1 && st.bounties.length === 0 && me(st, A).stats.kills === 1 && me(st, A).stats.overrides === 1 && me(st, B).stats.deaths === 1);
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('override: killer\'s own card shows spent', st.me.killCancelCard === false);
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('override: victim\'s own card shows spent too (both cards gone)', st.me.killCancelCard === false);
    check('override: the canceled-then-restored kill cannot be canceled again → 404', (await req(base, tB, 'POST', `/api/kills/${k1.json.kill.id}/cancel`, {})).status === 404);

    // Kill 2: wilber stealth-kills memphis (the marked man), with a photo → dispute → vice settles confirm
    const k2 = await req(base, tC, 'POST', '/api/kills', { victimId: D, stealth: true, photo: PNG });
    st = (await req(base, tB, 'GET', '/api/state')).json;
    const seenByB = st.kills.find(k => k.id === k2.json.kill.id);
    check('stealth killer + photo hidden from third parties pre-confirmation', seenByB.killerId === null && seenByB.killerHidden === true && seenByB.photo === undefined, seenByB);
    st = (await req(base, tD, 'GET', '/api/state')).json;
    check('stealth photo IS visible to the victim (claim resolution)', (() => { const k = st.kills.find(x => x.id === k2.json.kill.id); return k && k.photo && k.photo.data === PNG.data; })());
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('stealth killer visible to admin pre-confirmation', st.kills.find(k => k.id === k2.json.kill.id).killerId === C);
    await req(base, tD, 'POST', `/api/kills/${k2.json.kill.id}/dispute`, {});
    check('a non-admin cannot settle a kill', (await req(base, tC, 'POST', '/api/admin/settle-kill', { killId: k2.json.kill.id, outcome: 'confirm' })).status === 403);
    st = (await req(base, tV, 'POST', '/api/admin/settle-kill', { killId: k2.json.kill.id, outcome: 'confirm' })).json.state;
    check('kill 2: stealth + marked bonus + 3 achievements → wilber 125+50+75 = 250', me(st, C).xp === 250, me(st, C).xp);
    check('kill 2: achievements (first, stealth, marked-man)', ach(st, C, 'first-kill') && ach(st, C, 'stealth-kill') && ach(st, C, 'marked-man-kill'));
    check('kill 2: memphis dead at floor 0', me(st, D).xp === 0 && me(st, D).alive === false, me(st, D).xp);

    // Kill Cancel 2: memphis voids it — wilber keeps ONLY his achievement pay
    st = (await req(base, tD, 'POST', `/api/kills/${k2.json.kill.id}/cancel`, {})).json.state;
    check('cancel 2: memphis alive + immune, +25 achievement → 25', me(st, D).alive === true && !!me(st, D).immuneUntil && me(st, D).xp === 25, me(st, D).xp);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('cancel 2: wilber clawed back to exactly his 3 achievement payments (250 − 125 − 50 = 75)', me(st, C).xp === 75 && achEntries(st, C).length === 3, me(st, C).xp);
    check('cancel 2: canceled kill counts for nothing (season kills 0, career stealth 0, victim deaths 0)', me(st, C).seasonKills === 0 && me(st, C).stats.stealthKills === 0 && me(st, C).stats.kills === 0 && me(st, D).stats.deaths === 0);

    // ── danger proximity alerts ──
    await req(base, tA, 'POST', '/api/sharing', { on: true });
    await req(base, tA, 'POST', '/api/position', { lat: 40.0, lng: -83.0 });
    await req(base, tC, 'POST', '/api/sharing', { on: true });
    await req(base, tC, 'POST', '/api/position', { lat: 40.005, lng: -83.0 }); // ~0.35 mi from david
    st = (await req(base, tA, 'GET', '/api/state')).json;
    const dangerFor = (s) => s.messages.filter(m => m.kind === 'danger');
    check('danger: nearby hunter triggers a private alert for me', dangerFor(st).length === 1, dangerFor(st).length);
    st = (await req(base, tC, 'GET', '/api/state')).json;
    check('danger: the other hunter is alerted too', dangerFor(st).length === 1, dangerFor(st).length);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('danger: alerts are private — the founder sees none of them', dangerFor(st).length === 0, dangerFor(st).length);
    check('danger: alert names nobody', dangerFor((await req(base, tA, 'GET', '/api/state')).json).every(m => !/wilber|david|korben/i.test(m.text)));
    await req(base, tC, 'POST', '/api/position', { lat: 40.0051, lng: -83.0 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('danger: 30-minute pair cooldown — second close update stays quiet', dangerFor(st).length === 1, dangerFor(st).length);
    await req(base, tD, 'POST', '/api/sharing', { on: true });
    await req(base, tD, 'POST', '/api/position', { lat: 41.0, lng: -83.0 }); // ~69 mi away
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('danger: a far-away hunter triggers nothing', dangerFor(st).length === 1, dangerFor(st).length);

    // ── feed reactions ──
    const targetMsg = st.messages.find(m => m.id === 'sys-welcome') || st.messages[0];
    st = (await req(base, tA, 'POST', `/api/messages/${targetMsg.id}/react`, { emoji: '🔥' })).json.state;
    check('reaction: 🔥 lands with my id', (() => { const m = st.messages.find(x => x.id === targetMsg.id); return m.reactions && (m.reactions['🔥'] || []).includes(A); })());
    st = (await req(base, tA, 'POST', `/api/messages/${targetMsg.id}/react`, { emoji: '🔥' })).json.state;
    check('reaction: same emoji again toggles it off', (() => { const m = st.messages.find(x => x.id === targetMsg.id); return !m.reactions || !(m.reactions['🔥'] || []).length; })());
    check('reaction: emoji outside the set → 400', (await req(base, tA, 'POST', `/api/messages/${targetMsg.id}/react`, { emoji: '💩' })).status === 400);

    // ── callsigns + avatars ──
    st = (await req(base, tA, 'POST', '/api/profile', { callsign: 'Viper' })).json.state;
    check('callsign: set and public', me(st, A).callsign === 'Viper' && st.me.callsign === 'Viper');
    check('callsign: over 16 chars → 400', (await req(base, tA, 'POST', '/api/profile', { callsign: 'ThisCallsignIsTooLong' })).status === 400);
    check('callsign: markup → 400', (await req(base, tA, 'POST', '/api/profile', { callsign: '<script>' })).status === 400);
    st = (await req(base, tA, 'POST', '/api/profile', { avatar: '🐺' })).json.state;
    check('avatar: single emoji accepted', me(st, A).avatar === '🐺');
    check('avatar: plain text → 400', (await req(base, tA, 'POST', '/api/profile', { avatar: 'abc' })).status === 400);
    st = (await req(base, tF, 'POST', '/api/admin/callsign', { playerId: A, callsign: '' })).json.state;
    check('callsign: founder can reset it', me(st, A).callsign === null);
    check('callsign: non-admin reset → 403', (await req(base, tA, 'POST', '/api/admin/callsign', { playerId: B, callsign: '' })).status === 403);

    // Kill 3: memphis claims the founder; founder (a party) cannot settle his own kill
    const k3 = await req(base, tD, 'POST', '/api/kills', { victimId: F, stealth: false });
    await req(base, tF, 'POST', `/api/kills/${k3.json.kill.id}/dispute`, {});
    check('an admin who is a party to the kill cannot settle it', (await req(base, tF, 'POST', '/api/admin/settle-kill', { killId: k3.json.kill.id, outcome: 'confirm' })).status === 403);
    st = (await req(base, tV, 'POST', '/api/admin/settle-kill', { killId: k3.json.kill.id, outcome: 'confirm' })).json.state;
    check('kill 3: vice settles; memphis 25 + 100 + 25 first-kill = 150; founder dead at floor 0', me(st, D).xp === 150 && me(st, F).xp === 0 && me(st, F).alive === false, [me(st, D).xp, me(st, F).xp]);

    // Duck of Shame
    st = (await req(base, tF, 'POST', '/api/admin/duck', { playerId: B })).json.state;
    check('duck at 0 XP floors at 0, duck counted', me(st, B).xp === 0 && me(st, B).stats.ducks === 1, me(st, B).stats);
    await req(base, tF, 'POST', '/api/admin/adjust-xp', { playerId: B, delta: 100, note: 'test grant' });
    st = (await req(base, tF, 'POST', '/api/admin/duck', { playerId: B })).json.state;
    check('duck costs exactly −50 XP (100 → 50), second duck counted', me(st, B).xp === 50 && me(st, B).stats.ducks === 2, me(st, B).xp);
    check('duck produced a duck feed entry', st.messages.some(m => m.kind === 'duck' && m.text.includes('DUCK OF SHAME')));

    // Event win + achievement pays once even when the win repeats
    st = (await req(base, tF, 'POST', '/api/admin/event-win', { playerId: D })).json.state;
    check('event win: +300 and Combo Champion +25 → 475', me(st, D).xp === 475 && ach(st, D, 'event-win') === true, me(st, D).xp);
    st = (await req(base, tF, 'POST', '/api/admin/event-win', { playerId: D })).json.state;
    check('second event win pays +300 again but NOT the achievement again → 775', me(st, D).xp === 775 && achEntries(st, D).length === 3, me(st, D).xp);

    // Close season 1 — wilber named Last Man. Deadliest is a 1–1 tie between
    // david (kill 1, restored by override) and memphis (kill 3); roster order
    // breaks it to david. Wilber's stealth kill was canceled → Sneakiest null.
    st = (await req(base, tF, 'POST', '/api/admin/close-season', { lastManId: C })).json.state;
    check('archive: one record with season, last man, deadliest, standings', st.archive.length === 1 && st.archive[0].season === 1 && st.archive[0].lastManId === C && st.archive[0].deadliestId === A && st.archive[0].deadliestKills === 1 && st.archive[0].standings.length === 15, st.archive[0] && [st.archive[0].deadliestId, st.archive[0].deadliestKills]);
    check('archive: superlatives (first blood david, most wanted korben 250, duck magnet korben 2, sneakiest null)',
      st.archive[0].superlatives.firstBlood.playerId === A &&
      st.archive[0].superlatives.mostWanted.playerId === B && st.archive[0].superlatives.mostWanted.bountyXp === 250 &&
      st.archive[0].superlatives.duckMagnet.playerId === B && st.archive[0].superlatives.duckMagnet.ducks === 2 &&
      st.archive[0].superlatives.sneakiest === null, st.archive[0].superlatives);
    check('archive: standings capture kills + fate + days', (() => { const s = st.archive[0].standings; const d = s.find(x => x.playerId === A), b = s.find(x => x.playerId === B); return d.kills === 1 && d.alive === true && b.kills === 0 && b.alive === false && b.daysSurvived > 0; })());
    check('close: wilber 75 + 500 last-man + 25 last-man ach + 25 survivor = 625', me(st, C).xp === 625, me(st, C).xp);
    check('close: david 425 + 250 deadliest + 25 deadliest ach + 25 survivor = 725', me(st, A).xp === 725, me(st, A).xp);
    check('close: memphis 775 + 25 survivor = 800; vice survivor 25; korben untouched at 50', me(st, D).xp === 800 && me(st, V).xp === 25 && me(st, B).xp === 50, [me(st, D).xp, me(st, V).xp, me(st, B).xp]);
    check('close: season increments, board resets, cards restored, phase back to setup', st.league.season === 2 && st.kills.length === 0 && st.players.every(p => p.alive && p.seasonKills === 0 && p.immuneUntil === null) && st.me.killCancelCard === true && st.league.phase === 'setup');
    check('close: achievement feed banners exist', st.messages.some(m => m.kind === 'achievement'));
    check('close: wilber achievement ledger entries = 5', achEntries(st, C).length === 5, achEntries(st, C).map(e => e.note));

    // Close season 2 the same way — Last Man XP pays again (existing rule),
    // but the ACHIEVEMENT xp must not pay a second time.
    st = (await req(base, tF, 'POST', '/api/admin/close-season', { lastManId: C })).json.state;
    check('re-close: archive grows to 2 seasons', st.archive.length === 2, st.archive.length);
    check('re-close: achievement entries for wilber STILL 5 (paid once, ever)', achEntries(st, C).length === 5, achEntries(st, C).length);
    check('re-close: wilber got the +500 title pay again but no achievement re-pay = 1125', me(st, C).xp === 1125, me(st, C).xp);
  } finally { child.kill(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Web Push helpers: fabricate a subscription, decrypt a received push.
function makeSub(origin, pathName) {
  const ua = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const uaJwk = ua.publicKey.export({ format: 'jwk' });
  const uaPoint = Buffer.concat([Buffer.from([0x04]), Buffer.from(uaJwk.x, 'base64url'), Buffer.from(uaJwk.y, 'base64url')]);
  const auth = crypto.randomBytes(16);
  return {
    sub: { endpoint: `${origin}${pathName}`, keys: { p256dh: uaPoint.toString('base64url'), auth: auth.toString('base64url') } },
    privateKey: ua.privateKey, uaPoint, auth,
  };
}
function decryptPush(body, ctx) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const secret = crypto.diffieHellman({ privateKey: ctx.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: asPub.subarray(1, 33).toString('base64url'), y: asPub.subarray(33, 65).toString('base64url') }, format: 'jwk' }) });
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ctx.uaPoint, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, ctx.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  let plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  plain = plain.subarray(0, plain.length - 1); // strip the 0x02 record delimiter
  return JSON.parse(plain.toString('utf8'));
}
async function waitForPush(received, pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = received.find((m, i) => pred(m, i));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}
// Poll an arbitrary (sync or async) condition until it returns truthy.
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 120));
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
async function suitePush() {
  suite('Suite 3 — Web Push protocol (VAPID JWT + aes128gcm decryption)');
  const { child, base, dataDir } = await startServer(3413, '2027-01-01T05:00:00.000Z');
  const received = [];
  const fake = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => { received.push({ url: rq.url, headers: rq.headers, body: Buffer.concat(chunks) }); rs.writeHead(201); rs.end('ok'); });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakePort = fake.address().port;
  const origin = `http://127.0.0.1:${fakePort}`;
  try {
    const tF = await claim(base, F), tA = await claim(base, A);
    const ctxA = makeSub(origin, '/push/abc');
    const r = await req(base, tA, 'POST', '/api/push/subscribe', { subscription: ctxA.sub });
    check('fabricated subscription accepted', r.status === 200, r.status);

    const { publicKey } = (await req(base, tF, 'GET', '/api/push/key')).json;
    await req(base, tF, 'POST', '/api/admin/settings', { markedManId: A });
    const msg = await waitForPush(received, m => m.url === '/push/abc');
    check('marked-man push delivered to the push service', !!msg, received.length);
    check('push headers: aes128gcm + vapid auth', msg.headers['content-encoding'] === 'aes128gcm' && String(msg.headers.authorization || '').startsWith('vapid t='), msg.headers['content-encoding']);
    const authz = String(msg.headers.authorization);
    const jwt = authz.slice('vapid t='.length, authz.indexOf(','));
    const usedKey = authz.slice(authz.indexOf(', k=') + 4);
    check('authorization carries the server VAPID public key', usedKey === publicKey);
    const [h, p, s] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    check('JWT aud is the push-service origin, exp in future', payload.aud === origin && payload.exp > Date.now() / 1000, payload);
    const srvPub = Buffer.from(publicKey, 'base64url');
    const srvKeyObj = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: srvPub.subarray(1, 33).toString('base64url'), y: srvPub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
    const sigOk = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: srvKeyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    check('JWT ES256 signature verifies against the public key', sigOk === true);
    const note = decryptPush(msg.body, ctxA);
    check('aes128gcm body decrypts to the marked-man notification', note.tag === 'marked-man' && /marked/i.test(note.title + note.body), note);

    // bounty push (f)
    const before = received.length;
    await req(base, tF, 'POST', '/api/admin/bounty', { targetId: A, amount: 100 });
    const bPush = await waitForPush(received, (m, i) => i >= before && m.url === '/push/abc');
    check('bounty-on-you push delivered', !!bPush, received.length);
    await req(base, tA, 'POST', '/api/push/unsubscribe', { endpoint: ctxA.sub.endpoint });
    const n = received.length;
    await req(base, tF, 'POST', '/api/admin/settings', { markedManId: B });
    await req(base, tF, 'POST', '/api/admin/settings', { markedManId: A });
    await new Promise(r2 => setTimeout(r2, 500));
    check('no push after unsubscribe', received.length === n, received.length);
    check('vapid.json persisted for restart survival', fs.existsSync(path.join(dataDir, 'vapid.json')));
  } finally { child.kill(); fake.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suitePushCancel() {
  suite('Suite 4 — Web Push: Kill Cancel + Override notifications');
  const { child, base } = await startServer(3414, '2000-01-01T05:00:00.000Z');
  const received = [];
  const fake = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => { received.push({ url: rq.url, headers: rq.headers, body: Buffer.concat(chunks) }); rs.writeHead(201); rs.end('ok'); });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  try {
    const tA = await claim(base, A), tB = await claim(base, B);
    const ctxA = makeSub(origin, '/push/killer'), ctxB = makeSub(origin, '/push/victim');
    await req(base, tA, 'POST', '/api/push/subscribe', { subscription: ctxA.sub });
    await req(base, tB, 'POST', '/api/push/subscribe', { subscription: ctxB.sub });
    const k = await req(base, tA, 'POST', '/api/kills', { victimId: B, stealth: false });
    await req(base, tB, 'POST', `/api/kills/${k.json.kill.id}/confirm`, {});
    const confirmedPush = await waitForPush(received, m => m.url === '/push/killer');
    check('kill-confirmed push reached the killer', !!confirmedPush && decryptPush(confirmedPush.body, ctxA).tag === 'kill-confirmed');
    received.length = 0;
    await req(base, tB, 'POST', `/api/kills/${k.json.kill.id}/cancel`, {});
    const cancelPush = await waitForPush(received, m => m.url === '/push/killer');
    check('kill-CANCELED push reached the killer', !!cancelPush, received.length);
    if (cancelPush) {
      const note = decryptPush(cancelPush.body, ctxA);
      check('cancel push says the kill was canceled + immunity', note.tag === 'kill-canceled' && /cancel/i.test(note.title + note.body), note);
    }
    received.length = 0;
    await req(base, tA, 'POST', `/api/kills/${k.json.kill.id}/counter-cancel`, {});
    const overPush = await waitForPush(received, m => m.url === '/push/victim');
    check('cancel-OVERRIDDEN push reached the victim', !!overPush, received.length);
    if (overPush) {
      const note = decryptPush(overPush.body, ctxB);
      check('override push says the kill stands', note.tag === 'cancel-overridden' && /override/i.test(note.title + note.body), note);
    }
  } finally { child.kill(); fake.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suiteBackup() {
  suite('Suite 5 — league backup / restore (Round 3)');
  // 1 MB restore cap on this instance so the oversize rejection is cheap to test.
  const { child, base } = await startServer(3415, '2000-01-01T05:00:00.000Z', { RESTORE_MAX_BYTES: '1000000' });
  try {
    const tF0 = await claim(base, F), tV = await claim(base, V), tA = await claim(base, A);
    await claim(base, B);

    // auth gates: members and strangers are refused both ways
    check('backup: non-admin member → 403', (await rawReq(base, tA, 'GET', '/api/admin/backup')).status === 403);
    check('backup: unauthenticated → 401', (await rawReq(base, null, 'GET', '/api/admin/backup')).status === 401);
    check('restore: non-admin member → 403', (await rawReq(base, tA, 'POST', '/api/admin/restore', '{}')).status === 403);
    check('restore: unauthenticated → 401', (await rawReq(base, null, 'POST', '/api/admin/restore', '{}')).status === 401);

    // build a league worth backing up: XP + ledger, chat, a bounty, an archive
    await req(base, tF0, 'POST', '/api/admin/event-win', { playerId: A });
    await req(base, tA, 'POST', '/api/messages', { text: 'backup checkpoint' });
    await req(base, tF0, 'POST', '/api/admin/bounty', { targetId: B, amount: 100 });
    let st = (await req(base, tF0, 'POST', '/api/admin/close-season', { lastManId: A })).json.state;
    check('setup for backup: season archived', st.archive.length === 1 && st.archive[0].lastManId === A, st.archive.length);
    const want = {
      xpA: me(st, A).xp, xpLogLen: st.xpLog.length, bountyHistoryLen: 1,
    };
    check('setup for backup: ledger + XP are non-trivial', want.xpA > 500 && want.xpLogLen > 3, [want.xpA, want.xpLogLen]);

    // file-based VAPID keys exist once the push key is served
    const key1 = (await req(base, tF0, 'GET', '/api/push/key')).json.publicKey;
    check('push key served (vapid.json generated)', typeof key1 === 'string' && key1.length > 80);

    // ── take the backup ──
    const dl = await rawReq(base, tF0, 'GET', '/api/admin/backup');
    check('backup download → 200', dl.status === 200, dl.status);
    check('backup filename is open-season-backup-YYYYMMDD-HHmm.json', /attachment; filename="open-season-backup-\d{8}-\d{4}\.json"/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));
    const backup = JSON.parse(dl.text);
    check('backup carries the format marker + version', backup.format === 'open-season-backup' && backup.version === 1, [backup.format, backup.version]);
    check('backup contains the full ledger', Array.isArray(backup.state.xpLog) && backup.state.xpLog.length === want.xpLogLen && backup.state.xpLog.some(e => e.playerId === A && e.reason === 'event-win'));
    check('backup contains the archive + bounty history', backup.state.archive.length === 1 && backup.state.bountyHistory.length === want.bountyHistoryLen);
    check('backup contains PIN hashes (claims/PINs survive a restore)', typeof backup.state.players.find(p => p.id === A).pinHash === 'string' && backup.state.players.find(p => p.id === A).pinHash.length > 20);
    check('backup embeds the VAPID keypair block', !!backup.vapid && backup.vapid.publicKey === key1 && typeof backup.vapid.privateKey === 'string', backup.vapid && backup.vapid.publicKey);

    // founder re-login AFTER the backup: his live token now differs from the
    // one inside the backup — the restore must carry the live one over.
    const tF = (await req(base, null, 'POST', '/api/login', { playerId: F, pin: '1234' })).json.token;
    check('founder re-login rotated his token', typeof tF === 'string' && tF !== tF0);

    // mutate the league away from the backup
    st = (await req(base, tF, 'POST', '/api/admin/event-win', { playerId: A })).json.state;
    await req(base, tA, 'POST', '/api/messages', { text: 'after backup' });
    st = (await req(base, tF, 'POST', '/api/admin/bounty', { targetId: B, amount: 150 })).json.state;
    const mutatedXpA = me(st, A).xp;
    check('mutations landed (XP moved, a bounty is up)', mutatedXpA === want.xpA + 300 && st.bounties.length === 1, [mutatedXpA, st.bounties.length]);

    // ── rejected restores change nothing ──
    let r = await rawReq(base, tF, 'POST', '/api/admin/restore', 'this is not json {{{');
    check('restore: malformed JSON → 400', r.status === 400, r.status);
    r = await rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify({ format: 'open-season-backup', version: 1, state: { league: {}, players: [{ id: 'x', name: 'X' }] } }));
    check('restore: state missing required collections → 400', r.status === 400, r.status);
    r = await rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify({ format: 'something-else', version: 1, state: backup.state }));
    check('restore: wrong format marker → 400', r.status === 400, r.status);
    r = await rawReq(base, tF, 'POST', '/api/admin/restore', 'x'.repeat(1_100_000));
    check('restore: over the size cap → 413', r.status === 413, r.status);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('rejected restores left the league untouched', me(st, A).xp === mutatedXpA && st.bounties.length === 1 && st.messages.some(m => m.text === 'after backup'));

    // ── the real restore (with a swapped VAPID block, to prove keys restore) ──
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pj = kp.publicKey.export({ format: 'jwk' }), dj = kp.privateKey.export({ format: 'jwk' });
    const newPub = Buffer.concat([Buffer.from([0x04]), Buffer.from(pj.x, 'base64url'), Buffer.from(pj.y, 'base64url')]).toString('base64url');
    const restoreObj = JSON.parse(dl.text);
    restoreObj.vapid = { publicKey: newPub, privateKey: Buffer.from(dj.d, 'base64url').toString('base64url') };
    r = await rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify(restoreObj));
    check('restore: valid backup → 200', r.status === 200, [r.status, r.text.slice(0, 160)]);

    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('restore: the restoring admin stays signed in (token carried over)', !!st.me && st.me.id === F);
    check('restore: the pre-login token from the backup era is NOT resurrected for the founder', (await req(base, tF0, 'GET', '/api/state')).status === 401);
    check('restore: XP rolled back to the backed-up value', me(st, A).xp === want.xpA, [me(st, A).xp, want.xpA]);
    check('restore: chat rolled back (checkpoint in, post-backup message out)',
      st.messages.some(m => m.text === 'backup checkpoint') && !st.messages.some(m => m.text === 'after backup'));
    check('restore: a restore notice was posted to the feed', st.messages.some(m => m.kind === 'system' && /restored from a backup/i.test(m.text)));
    check('restore: post-backup bounty is gone', st.bounties.length === 0, st.bounties.length);
    check('restore: archive intact (season 1, last man david)', st.archive.length === 1 && st.archive[0].lastManId === A, st.archive.length);
    check('restore: a session live at backup time (member claim token) still works', (await req(base, tA, 'GET', '/api/state')).status === 200);
    const relogin = await req(base, null, 'POST', '/api/login', { playerId: A, pin: '1234' });
    check('restore: PIN login still works (PIN hashes restored)', relogin.status === 200, relogin.status);
    const key2 = (await req(base, tF, 'GET', '/api/push/key')).json.publicKey;
    check('restore: VAPID keys restored — push key is now the backup\'s key', key2 === newPub && key2 !== key1);
    const dl2 = await rawReq(base, tF, 'GET', '/api/admin/backup');
    const backup2 = JSON.parse(dl2.text);
    check('restore: a fresh backup matches the restored state (ledger + bounty history rolled back)',
      backup2.state.xpLog.length === want.xpLogLen && backup2.state.bountyHistory.length === want.bountyHistoryLen,
      [backup2.state.xpLog.length, backup2.state.bountyHistory.length]);

    // the Vice can restore too (same admin convention as close-season)
    r = await rawReq(base, tV, 'POST', '/api/admin/restore', dl.text);
    check('restore: vice can restore the original backup → 200', r.status === 200, r.status);
    const key3 = (await req(base, tV, 'GET', '/api/push/key')).json.publicKey;
    check('restore: original VAPID keys back in force after vice restore', key3 === key1, key3 && key3.slice(0, 16));
  } finally { child.kill(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suiteZonesDriving() {
  suite('Suite 6 — safe-zone announcements + automatic driving mode (Round 4)');
  // 1.5 s announcement cooldown on this instance (env override) so the
  // re-entry rules are testable without waiting 15 real minutes.
  const { child, base } = await startServer(3416, '2000-01-01T05:00:00.000Z', { ZONE_ANNOUNCE_COOLDOWN_MS: '1500' });
  try {
    const tF = await claim(base, F), tA = await claim(base, A), tB = await claim(base, B),
      tC = await claim(base, C), tD = await claim(base, D);
    const zoneMsgs = st => st.messages.filter(m => m.kind === 'safezone');
    const driveMsgs = (st, who) => st.messages.filter(m => m.kind === 'driving' && (!who || m.text.includes(who)));
    const HOME = { lat: 40.1234, lng: -83.5678 }, FAR = { lat: 40.2, lng: -83.6 };

    // ── safe-zone announcements ──
    await req(base, tA, 'POST', '/api/sharing', { on: true });
    await req(base, tA, 'POST', '/api/safe-zones', { label: 'home', lat: HOME.lat, lng: HOME.lng, radius: 150 });
    let st = (await req(base, tA, 'POST', '/api/position', HOME)).json.state;
    check('zone: entering a safe zone sets the public status with its label', me(st, A).atSafeZone === 'HOME', me(st, A).atSafeZone);
    check('zone: the entry is announced to the feed exactly once, with the label',
      zoneMsgs(st).length === 1 && /at a safe zone — HOME/.test(zoneMsgs(st)[0].text), zoneMsgs(st).map(m => m.text));
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('zone: another hunter sees the label but NO pin', me(st, A).atSafeZone === 'HOME' && me(st, A).position === null);
    check('zone: the hidden hunter\'s coordinates appear NOWHERE in another hunter\'s payload',
      !JSON.stringify(st).includes('40.1234') && !JSON.stringify(st).includes('83.5678'));
    st = (await req(base, tA, 'POST', '/api/position', { lat: 40.12345, lng: -83.56785 })).json.state;
    check('zone: staying inside does not re-announce (one per continuous stay)', zoneMsgs(st).length === 1 && me(st, A).atSafeZone === 'HOME', zoneMsgs(st).length);
    st = (await req(base, tA, 'POST', '/api/position', FAR)).json.state;
    check('zone: leaving all zones clears the status, silently (no exit entry)', me(st, A).atSafeZone === null && zoneMsgs(st).length === 1);
    st = (await req(base, tA, 'POST', '/api/position', HOME)).json.state;
    check('zone: re-entry inside the cooldown shows the status but stays quiet', me(st, A).atSafeZone === 'HOME' && zoneMsgs(st).length === 1, zoneMsgs(st).length);
    await req(base, tA, 'POST', '/api/position', FAR);
    await new Promise(r => setTimeout(r, 1700)); // outlast the (test) 1.5 s cooldown
    st = (await req(base, tA, 'POST', '/api/position', HOME)).json.state;
    check('zone: re-entry after the cooldown announces again', zoneMsgs(st).length === 2, zoneMsgs(st).length);
    // labels are per-hunter and per-zone: wilber's church announces CHURCH
    await req(base, tC, 'POST', '/api/sharing', { on: true });
    await req(base, tC, 'POST', '/api/safe-zones', { label: 'church', lat: 41.5, lng: -84.5, radius: 150 });
    st = (await req(base, tC, 'POST', '/api/position', { lat: 41.5, lng: -84.5 })).json.state;
    check('zone: a different hunter\'s church zone announces CHURCH (own cooldown)',
      me(st, C).atSafeZone === 'CHURCH' && zoneMsgs(st).length === 3 && /at a safe zone — CHURCH/.test(zoneMsgs(st)[2].text), zoneMsgs(st).map(m => m.text));
    // overlapping zones: the FIRST matching zone's label wins; moving to a
    // work-only spot switches the label
    await req(base, tA, 'POST', '/api/safe-zones', { label: 'work', lat: 40.1243, lng: -83.5678, radius: 150 }); // ~100 m north of home — both circles cover HOME
    st = (await req(base, tA, 'POST', '/api/position', HOME)).json.state;
    check('zone: where home and work overlap, the first matching zone labels the status', me(st, A).atSafeZone === 'HOME', me(st, A).atSafeZone);
    st = (await req(base, tA, 'POST', '/api/position', { lat: 40.1250, lng: -83.5678 })).json.state; // inside work only
    check('zone: moving into a work-only spot switches the label to WORK', me(st, A).atSafeZone === 'WORK', me(st, A).atSafeZone);
    st = (await req(base, tA, 'POST', '/api/position', FAR)).json.state;
    check('zone: status clears again on the way out (setup for the driving half)', me(st, A).atSafeZone === null);

    // ── driving mode, device-reported speed path ──
    await req(base, tB, 'POST', '/api/sharing', { on: true });
    await req(base, tB, 'POST', '/api/position', { lat: 40.0, lng: -83.0, speed: 0 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('driving: a parked hunter is visible and not driving', !!me(st, B).position && me(st, B).driving === false);
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.001, lng: -83.0, speed: 12 })).json.state;
    check('driving: ONE fast fix is not enough — speed must be sustained', me(st, B).driving === false && !!me(st, B).position);
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.002, lng: -83.0, speed: 12 })).json.state;
    check('driving: second consecutive fast fix (>9 m/s) enters driving mode', me(st, B).driving === true);
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('driving: the driver\'s pin is hidden from the league', me(st, B).position === null && me(st, B).driving === true);
    check('driving: exactly one feed entry for the trip so far', driveMsgs(st, 'Korben').length === 1 && /is driving/.test(driveMsgs(st, 'Korben')[0].text), driveMsgs(st).map(m => m.text));
    check('driving: entering driving mode in a LIVE season does not eliminate the driver', me(st, B).out === false && me(st, B).alive === true);
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.003, lng: -83.0, speed: 13 })).json.state;
    check('driving: further fast fixes do not re-post the entry', driveMsgs(st, 'Korben').length === 1, driveMsgs(st).length);
    const claimOnDriver = await req(base, tA, 'POST', '/api/kills', { victimId: B });
    check('driving: a kill claim against a driving hunter is rejected (target is driving)',
      claimOnDriver.status === 400 && /driving/i.test(claimOnDriver.json.error || ''), [claimOnDriver.status, claimOnDriver.json.error]);
    // danger suppression: david parks ~55 m from korben's hidden position
    await req(base, tA, 'POST', '/api/position', { lat: 40.0025, lng: -83.0, speed: 0 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    const stB = (await req(base, tB, 'GET', '/api/state')).json;
    check('driving: danger alerts are suppressed TO and FROM a driver',
      st.messages.every(m => m.kind !== 'danger') && stB.messages.every(m => m.kind !== 'danger'));
    // exit: two slow fixes restore the pin
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.0035, lng: -83.0, speed: 1 })).json.state;
    check('driving: one slow fix does not end the trip', me(st, B).driving === true);
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.0036, lng: -83.0, speed: 0 })).json.state;
    check('driving: second slow fix (<2 m/s) exits driving mode', me(st, B).driving === false);
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('driving: the pin returns once he stops', !!me(st, B).position);
    // safe zone + driving together: both statuses set, zone label present
    await req(base, tB, 'POST', '/api/safe-zones', { label: 'home', lat: 40.0036, lng: -83.0, radius: 150 });
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.0037, lng: -83.0, speed: 12 })).json.state;
    check('precedence: saving a zone while standing in it lights the zone status', me(st, B).atSafeZone === 'HOME', me(st, B).atSafeZone);
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.0038, lng: -83.0, speed: 12 })).json.state;
    check('precedence: driving inside a safe zone carries BOTH statuses (zone label is the display one)',
      me(st, B).driving === true && me(st, B).atSafeZone === 'HOME' && me(st, B).position === null, [me(st, B).driving, me(st, B).atSafeZone]);
    await req(base, tB, 'POST', '/api/position', { lat: 40.0038, lng: -83.0, speed: 0 });
    st = (await req(base, tB, 'POST', '/api/position', { lat: 40.0038, lng: -83.0, speed: 0 })).json.state;
    check('precedence: stopping clears driving; the safe-zone status (and hidden pin) remains',
      me(st, B).driving === false && me(st, B).atSafeZone === 'HOME' && me(st, B).position === null);

    // ── driving mode, position-derived speed fallback (no speed field) ──
    await req(base, tD, 'POST', '/api/sharing', { on: true });
    st = (await req(base, tD, 'POST', '/api/position', { lat: 42.0, lng: -84.0 })).json.state;
    check('derived: a first fix with no speed history cannot enter driving', me(st, D).driving === false);
    st = (await req(base, tD, 'POST', '/api/position', { lat: 42.002, lng: -84.0 })).json.state;
    check('derived: one position-derived fast reading is not enough', me(st, D).driving === false);
    st = (await req(base, tD, 'POST', '/api/position', { lat: 42.004, lng: -84.0 })).json.state;
    check('derived: two derived fast readings enter driving mode', me(st, D).driving === true && driveMsgs(st, 'Memphis').length === 1);
    await req(base, tD, 'POST', '/api/position', { lat: 42.004, lng: -84.0 });
    st = (await req(base, tD, 'POST', '/api/position', { lat: 42.004, lng: -84.0 })).json.state;
    check('derived: stationary derived fixes (0 m/s) exit driving mode', me(st, D).driving === false);
    check('derived: memphis was never eliminated either', me(st, D).out === false && me(st, D).alive === true);
  } finally { child.kill(); }

  // ── scrimmage: driving never eliminates there either ──
  const s2 = await startServer(3417, '2027-01-01T05:00:00.000Z');
  try {
    const tF = await claim(s2.base, F), tA = await claim(s2.base, A);
    await req(s2.base, tF, 'POST', '/api/admin/scrimmage', { on: true });
    await req(s2.base, tA, 'POST', '/api/sharing', { on: true });
    await req(s2.base, tA, 'POST', '/api/position', { lat: 40.0, lng: -83.0, speed: 12 });
    let st = (await req(s2.base, tA, 'POST', '/api/position', { lat: 40.001, lng: -83.0, speed: 12 })).json.state;
    check('scrimmage: driving mode engages during practice', me(st, A).driving === true);
    check('scrimmage: a driving hunter is NOT eliminated', me(st, A).out === false && me(st, A).alive === true);
    await req(s2.base, tA, 'POST', '/api/position', { lat: 40.001, lng: -83.0, speed: 0 });
    st = (await req(s2.base, tA, 'POST', '/api/position', { lat: 40.001, lng: -83.0, speed: 0 })).json.state;
    check('scrimmage: stopping clears driving, still nobody out', me(st, A).driving === false && me(st, A).out === false);
  } finally { s2.child.kill(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suiteRound5() {
  suite('Suite 7 — backup reminder + test push (Round 5)');
  const { child, base } = await startServer(3418, '2000-01-01T05:00:00.000Z');
  const received = [];
  const fake = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => {
      received.push({ url: rq.url, headers: rq.headers, body: Buffer.concat(chunks) });
      if (rq.url === '/push/gone') { rs.writeHead(410); rs.end('gone'); } // a dead subscription
      else { rs.writeHead(201); rs.end('ok'); }
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  try {
    const tF = await claim(base, F), tV = await claim(base, V), tA = await claim(base, A),
      tB = await claim(base, B), tC = await claim(base, C);

    // ── reminder: live season, no backup ever taken ──
    let st = (await req(base, tF, 'GET', '/api/state')).json;
    check('reminder: admin payload carries the backup block — never backed up → stale',
      !!st.backup && st.backup.lastBackupAt === null && st.backup.stale === true, st.backup);
    check('reminder: the league payload itself does not leak lastBackupAt', st.league.lastBackupAt === undefined);
    st = (await req(base, tV, 'GET', '/api/state')).json;
    check('reminder: the vice sees the stale flag too', !!st.backup && st.backup.stale === true);
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('reminder: regular hunters get NO backup block and no stamp (no admin info leak)',
      st.backup === undefined && st.league.lastBackupAt === undefined);

    // ── snooze: per-admin, 24h ──
    check('snooze: a non-admin cannot snooze → 403', (await req(base, tA, 'POST', '/api/admin/backup-snooze', {})).status === 403);
    st = (await req(base, tF, 'POST', '/api/admin/backup-snooze', {})).json.state;
    check('snooze: the founder snoozing hides HIS reminder', !!st.backup && st.backup.stale === false, st.backup);
    st = (await req(base, tV, 'GET', '/api/state')).json;
    check('snooze: the vice is NOT snoozed by the founder', st.backup.stale === true);

    // ── a download stamps lastBackupAt and clears stale for everyone ──
    const dl = await rawReq(base, tF, 'GET', '/api/admin/backup');
    check('stamp: backup download → 200', dl.status === 200, dl.status);
    const bk = JSON.parse(dl.text);
    check('stamp: the backup file itself records league.lastBackupAt', typeof bk.state.league.lastBackupAt === 'string', bk.state.league.lastBackupAt);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('stamp: lastBackupAt is fresh in the founder payload', typeof st.backup.lastBackupAt === 'string' && Date.now() - Date.parse(st.backup.lastBackupAt) < 60000, st.backup.lastBackupAt);
    check('stamp: the fresh backup clears stale for the founder', st.backup.stale === false);
    st = (await req(base, tV, 'GET', '/api/state')).json;
    check('stamp: the fresh backup clears stale for the vice too', st.backup.stale === false);

    // ── age-based staleness: restore a copy whose stamp is 8 days old ──
    const old = JSON.parse(dl.text);
    old.state.league.lastBackupAt = new Date(Date.now() - 8 * 864e5).toISOString();
    for (const p of old.state.players) p.backupSnoozeUntil = 0; // an old league backup carries no live snoozes
    const rr = await rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify(old));
    check('age: restoring the 8-day-old-stamp backup → 200', rr.status === 200, rr.status);
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('age: a last backup older than 7 days reads stale again in a live season',
      !!st.backup && st.backup.stale === true && Date.now() - Date.parse(st.backup.lastBackupAt) > 7 * 864e5, st.backup);

    // ── test push: own subscriptions only ──
    const noSub = await req(base, tC, 'POST', '/api/push/test', {});
    check('test push: no subscription → 400 "Turn notifications on first"',
      noSub.status === 400 && /Turn notifications on first/.test(noSub.json.error || ''), [noSub.status, noSub.json.error]);
    check('test push: unauthenticated → 401', (await req(base, null, 'POST', '/api/push/test', {})).status === 401);
    const ctxA = makeSub(origin, '/push/a'), ctxB = makeSub(origin, '/push/b'), ctxGone = makeSub(origin, '/push/gone');
    await req(base, tA, 'POST', '/api/push/subscribe', { subscription: ctxA.sub });
    await req(base, tB, 'POST', '/api/push/subscribe', { subscription: ctxB.sub });
    await req(base, tB, 'POST', '/api/push/subscribe', { subscription: ctxGone.sub });
    let tp = await req(base, tA, 'POST', '/api/push/test', {});
    check('test push: A targets exactly his 1 subscription, 1 accepted',
      tp.status === 200 && tp.json.targeted === 1 && tp.json.accepted === 1, tp.json);
    const hitA = await waitForPush(received, m => m.url === '/push/a');
    check('test push: A\'s endpoint received a push', !!hitA, received.map(m => m.url));
    if (hitA) {
      const note = decryptPush(hitA.body, ctxA);
      check('test push: it decrypts to the canned test notification',
        note.tag === 'test-push' && note.title === '🏹 Open Season' && /Test push/.test(note.body), note);
    }
    check('test push: B received NOTHING from A\'s test', received.every(m => m.url !== '/push/b' && m.url !== '/push/gone'), received.map(m => m.url));
    tp = await req(base, tB, 'POST', '/api/push/test', {});
    check('test push: B targets 2 (one live, one dead) — 1 accepted, 1 pruned',
      tp.status === 200 && tp.json.targeted === 2 && tp.json.accepted === 1 && tp.json.pruned === 1, tp.json);
    const hitB = await waitForPush(received, m => m.url === '/push/b');
    check('test push: B\'s live endpoint received his test', !!hitB && decryptPush(hitB.body, ctxB).tag === 'test-push');
    tp = await req(base, tB, 'POST', '/api/push/test', {});
    check('test push: the dead (410) subscription stays pruned — B now targets 1',
      tp.status === 200 && tp.json.targeted === 1 && tp.json.accepted === 1 && tp.json.pruned === 0, tp.json);
  } finally { child.kill(); fake.close(); }

  // ── setup phase: the reminder stays quiet until data actually matters ──
  const s2 = await startServer(3419, '2027-01-01T05:00:00.000Z');
  try {
    const tF = await claim(s2.base, F);
    let st = (await req(s2.base, tF, 'GET', '/api/state')).json;
    check('setup: backup block present for admins but NOT stale in plain setup (even with no backup ever)',
      !!st.backup && st.backup.lastBackupAt === null && st.backup.stale === false, st.backup);
    st = (await req(s2.base, tF, 'POST', '/api/admin/scrimmage', { on: true })).json.state;
    check('setup: scrimmage ON makes a missing backup stale (practice data matters too)', st.backup.stale === true, st.backup);
    st = (await req(s2.base, tF, 'POST', '/api/admin/scrimmage', { on: false })).json.state;
    check('setup: scrimmage OFF quiets the reminder again', st.backup.stale === false, st.backup);
  } finally { s2.child.kill(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suiteHuntMode() {
  suite('Suite 8 — Hunt Mode: toggle, anonymous blast, freshness, safety interplay (Round 6)');
  // 4-second blast cooldown on the live instance (env override) so the
  // 30-minute window's expiry is testable inside the suite.
  const { child, base } = await startServer(3420, '2000-01-01T05:00:00.000Z', { HUNT_BLAST_COOLDOWN_MS: '4000' });
  const received = [];
  const fake = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => { received.push({ url: rq.url, headers: rq.headers, body: Buffer.concat(chunks) }); rs.writeHead(201); rs.end('ok'); });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  const at = url => received.filter(m => m.url === url);
  const huntFeed = st => st.messages.filter(m => m.kind === 'hunt');
  try {
    const tF = await claim(base, F), tA = await claim(base, A), tB = await claim(base, B),
      tC = await claim(base, C), tW = await claim(base, WATCH);
    const ctxF = makeSub(origin, '/push/founder'), ctxA = makeSub(origin, '/push/hunter'), ctxB = makeSub(origin, '/push/other');
    await req(base, tF, 'POST', '/api/push/subscribe', { subscription: ctxF.sub });
    await req(base, tA, 'POST', '/api/push/subscribe', { subscription: ctxA.sub });
    await req(base, tB, 'POST', '/api/push/subscribe', { subscription: ctxB.sub });

    check('hunt: a watching member cannot hunt → 400', (await req(base, tW, 'POST', '/api/hunt-mode', { on: true })).status === 400);

    // ── the first transition: cascade + blast ──
    const t0 = Date.now();
    let r = await req(base, tA, 'POST', '/api/hunt-mode', { on: true });
    let st = r.json.state;
    check('hunt: enabling Hunt Mode turns sharing ON with it and stamps the start',
      r.status === 200 && r.json.blasted === true && st.me.huntingOn === true && st.me.sharing === true && typeof st.me.huntStartedAt === 'string', [r.status, r.json.blasted, st.me.huntingOn, st.me.sharing]);
    check('hunt: no marker yet without a position fix', me((await req(base, tB, 'GET', '/api/state')).json, A).hunting === false);
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt: exactly ONE anonymous feed entry for the blast',
      huntFeed(st).length === 1 && huntFeed(st)[0].text === '🎯 Someone started hunting.' && huntFeed(st)[0].playerId === null && !/david/i.test(huntFeed(st)[0].text), huntFeed(st).map(m => m.text));
    const blastB = await waitForPush(received, m => m.url === '/push/other');
    const blastF = await waitForPush(received, m => m.url === '/push/founder');
    check('hunt: the blast reached the OTHER claimed hunters', !!blastB && !!blastF);
    check('hunt: the blast NEVER goes to the hunter himself', at('/push/hunter').length === 0, at('/push/hunter').length);
    if (blastB) {
      const note = decryptPush(blastB.body, ctxB);
      check('hunt: blast payload is the canned warning, tag hunt-start',
        note.title === '🏹 Open Season' && note.body === "⚠️ Someone's hunting. Open the app — your pin goes live." && note.tag === 'hunt-start', note);
      check('hunt: blast payload carries NO name or identifier of the hunter',
        !/david/i.test(JSON.stringify(note)) && !JSON.stringify(note).includes(A), JSON.stringify(note));
    }
    await req(base, tA, 'POST', '/api/position', { lat: 40.0, lng: -83.0 });
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt: with a fresh fix, the 🎯 marker shows for the league', me(st, A).hunting === true && !!me(st, A).position);

    // ── no-op re-save + toggle spam inside the cooldown: nothing re-fires ──
    r = await req(base, tA, 'POST', '/api/hunt-mode', { on: true });
    check('hunt: re-saving ON (no transition) does not blast again', r.json.blasted === false);
    r = await req(base, tA, 'POST', '/api/hunt-mode', { on: false });
    check('hunt: turning OFF leaves the sharing toggle untouched', r.json.state.me.huntingOn === false && r.json.state.me.sharing === true, [r.json.state.me.huntingOn, r.json.state.me.sharing]);
    r = await req(base, tA, 'POST', '/api/hunt-mode', { on: true });
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt: off→on inside the 30-min cooldown stays quiet (no blast, no second feed entry)',
      r.json.blasted === false && huntFeed(st).length === 1 && at('/push/other').length === 1, [r.json.blasted, huntFeed(st).length, at('/push/other').length]);

    // ── safe zone + driving while hunting: the pin still hides ──
    await req(base, tA, 'POST', '/api/safe-zones', { label: 'home', lat: 40.0, lng: -83.0, radius: 150 });
    st = (await req(base, tA, 'POST', '/api/position', { lat: 40.0, lng: -83.0 })).json.state;
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt+zone: hunting inside a safe zone — pin hidden, zone label public, marker still honest',
      me(st, A).position === null && me(st, A).atSafeZone === 'HOME' && me(st, A).hunting === true, [me(st, A).position, me(st, A).atSafeZone, me(st, A).hunting]);
    await req(base, tA, 'POST', '/api/position', { lat: 41.0, lng: -84.0 });
    await req(base, tA, 'POST', '/api/position', { lat: 41.001, lng: -84.0, speed: 12 });
    st = (await req(base, tA, 'POST', '/api/position', { lat: 41.002, lng: -84.0, speed: 12 })).json.state;
    check('hunt+driving: driving mode engages while hunting', me(st, A).driving === true);
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt+driving: the driver\'s pin is hidden from the league', me(st, A).position === null && me(st, A).driving === true);
    check('hunt+driving: a kill claim against a hunting driver is still rejected', (await req(base, tB, 'POST', '/api/kills', { victimId: A })).status === 400);
    await req(base, tA, 'POST', '/api/position', { lat: 41.002, lng: -84.0, speed: 0 });
    st = (await req(base, tA, 'POST', '/api/position', { lat: 41.002, lng: -84.0, speed: 0 })).json.state;
    check('hunt+driving: stopping restores the pin, the hunt never eliminated him', me(st, A).driving === false && me(st, A).alive === true && me(st, A).out === false);

    // ── cooldown expiry: a fresh transition blasts again ──
    const wait1 = 4600 - (Date.now() - t0);
    if (wait1 > 0) await new Promise(r2 => setTimeout(r2, wait1));
    await req(base, tA, 'POST', '/api/hunt-mode', { on: false });
    const t1 = Date.now();
    r = await req(base, tA, 'POST', '/api/hunt-mode', { on: true });
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt: after the cooldown, a new transition blasts again (feed entry #2)',
      r.json.blasted === true && huntFeed(st).length === 2, [r.json.blasted, huntFeed(st).length]);
    await waitForPush(received, (m, i) => m.url === '/push/other' && at('/push/other').length >= 2);
    check('hunt: the second blast pushed the others again', at('/push/other').length === 2, at('/push/other').length);
    // …but a no-op re-save AFTER the cooldown still doesn't (transition-only)
    const wait2 = 4600 - (Date.now() - t1);
    if (wait2 > 0) await new Promise(r2 => setTimeout(r2, wait2));
    r = await req(base, tA, 'POST', '/api/hunt-mode', { on: true });
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('hunt: even past the cooldown, a no-op re-save never blasts (off→on transitions only)',
      r.json.blasted === false && huntFeed(st).length === 2 && at('/push/other').length === 2, [r.json.blasted, huntFeed(st).length, at('/push/other').length]);

    // ── death ends the hunt; the dead cannot hunt ──
    await req(base, tA, 'POST', '/api/hunt-mode', { on: true }); // already on — stays on into the kill
    const kd = await req(base, tB, 'POST', '/api/kills', { victimId: A, stealth: false });
    await req(base, tA, 'POST', `/api/kills/${kd.json.kill.id}/confirm`, {});
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('hunt: death clears the hunt (persisted flag + start)', st.me.huntingOn === false && st.me.huntStartedAt === null && me(st, A).hunting === false, [st.me.huntingOn, st.me.huntStartedAt]);
    check('hunt: a dead hunter cannot hunt → 400', (await req(base, tA, 'POST', '/api/hunt-mode', { on: true })).status === 400);

    // ── freshness: a persisted flag with a stale pin reads NOT hunting ──
    await req(base, tB, 'POST', '/api/hunt-mode', { on: true });
    await req(base, tB, 'POST', '/api/position', { lat: 42.0, lng: -84.0 });
    st = (await req(base, tC, 'GET', '/api/state')).json;
    check('fresh: korben hunting with a fresh fix reads hunting to the league', me(st, B).hunting === true);
    const huntFeedBefore = huntFeed(st).length;
    const dl = await rawReq(base, tF, 'GET', '/api/admin/backup');
    const bk = JSON.parse(dl.text);
    const bRec = bk.state.players.find(p => p.id === B);
    bRec.position.ts = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // a 15-minute-old fix
    const rr = await rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify(bk));
    check('fresh: restoring the doctored backup → 200', rr.status === 200, rr.status);
    st = (await req(base, tC, 'GET', '/api/state')).json;
    check('fresh: 15 min without a fix — the marker is stale even though the flag persisted',
      me(st, B).hunting === false && !!me(st, B).position, me(st, B).hunting);
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('fresh: the hunter himself still sees his hunt ON (flag survives; only the marker stales)',
      st.me.huntingOn === true && st.me.hunting === false, [st.me.huntingOn, st.me.hunting]);
    check('fresh: the stale-out is quiet — no new feed entries about it', huntFeed((await req(base, tC, 'GET', '/api/state')).json).length === huntFeedBefore);

    // ── old saves: a backup with NO round-6 fields loads with defaults ──
    const dl2 = await rawReq(base, tF, 'GET', '/api/admin/backup');
    const old = JSON.parse(dl2.text);
    for (const p of old.state.players) { delete p.hunting; delete p.huntStartedAt; delete p.lastBlastAt; delete p.huntHintSeen; }
    const rr2 = await rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify(old));
    check('old-save: a pre-Round-6 backup restores → 200', rr2.status === 200, rr2.status);
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('old-save: new fields default (hunting off, hint unseen)', st.me.huntingOn === false && st.me.hunting === false && st.me.huntHintSeen === false, [st.me.huntingOn, st.me.huntHintSeen]);
    r = await req(base, tB, 'POST', '/api/hunt-mode', { on: true });
    check('old-save: Hunt Mode works on the defaulted record', r.status === 200 && r.json.state.me.huntingOn === true && r.json.state.me.sharing === true, r.status);
  } finally { child.kill(); fake.close(); }

  // ── plain setup: the toggle works, the blast does not ──
  const s2 = await startServer(3421, '2027-01-01T05:00:00.000Z');
  const received2 = [];
  const fake2 = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => { received2.push({ url: rq.url, body: Buffer.concat(chunks) }); rs.writeHead(201); rs.end('ok'); });
  });
  await new Promise(r => fake2.listen(0, '127.0.0.1', r));
  const origin2 = `http://127.0.0.1:${fake2.address().port}`;
  try {
    const tF = await claim(s2.base, F), tA = await claim(s2.base, A);
    const ctxF = makeSub(origin2, '/push/setup-founder');
    await req(s2.base, tF, 'POST', '/api/push/subscribe', { subscription: ctxF.sub });
    let r = await req(s2.base, tA, 'POST', '/api/hunt-mode', { on: true });
    let st = r.json.state;
    check('setup: Hunt Mode turns on locally (flag + sharing cascade + start stamp)',
      r.status === 200 && st.me.huntingOn === true && st.me.sharing === true && typeof st.me.huntStartedAt === 'string', [r.status, st.me.huntingOn, st.me.sharing]);
    check('setup: NO blast in plain setup (blasted=false, feed silent)', r.json.blasted === false && st.messages.every(m => m.kind !== 'hunt'));
    await new Promise(r2 => setTimeout(r2, 600));
    check('setup: NO push went out either', received2.length === 0, received2.length);
    await req(s2.base, tA, 'POST', '/api/position', { lat: 40.0, lng: -83.0 });
    st = (await req(s2.base, tF, 'GET', '/api/state')).json;
    check('setup: the fresh 🎯 marker still shows during setup', me(st, A).hunting === true);
    r = await req(s2.base, tA, 'POST', '/api/hunt-mode', { on: false });
    check('setup: turning OFF leaves sharing untouched here too', r.json.state.me.huntingOn === false && r.json.state.me.sharing === true);
    // scrimmage counts as hunt-open: the blast fires
    await req(s2.base, tF, 'POST', '/api/admin/scrimmage', { on: true });
    r = await req(s2.base, tA, 'POST', '/api/hunt-mode', { on: true });
    st = r.json.state;
    check('setup+scrimmage: the blast fires in scrimmage (feed entry posted)', r.json.blasted === true && st.messages.filter(m => m.kind === 'hunt').length === 1, [r.json.blasted, st.messages.filter(m => m.kind === 'hunt').length]);
    const sb = await waitForPush(received2, m => m.url === '/push/setup-founder');
    check('setup+scrimmage: the founder got the anonymous blast push', !!sb && !/david/i.test(JSON.stringify(decryptPush(sb.body, ctxF))), received2.length);
  } finally { s2.child.kill(); fake2.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function suiteRound7() {
  suite('Suite 9 — league ping + Location Check (Round 7)');
  // Tick at 300 ms and a 4-second ping cooldown (env overrides) so the
  // scheduler and the cooldown are exercisable inside the suite.
  const { child, base } = await startServer(3422, '2000-01-01T05:00:00.000Z', { CHECK_TICK_MS: '300', PING_COOLDOWN_MS: '4000' });
  const received = [];
  const fake = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => { received.push({ url: rq.url, headers: rq.headers, body: Buffer.concat(chunks) }); rs.writeHead(201); rs.end('ok'); });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  const bodiesAt = (url, ctx) => received.filter(m => m.url === url).map(m => { try { return decryptPush(m.body, ctx); } catch (_) { return null; } }).filter(Boolean);
  const remindersTo = (url, ctx) => bodiesAt(url, ctx).filter(n => n.tag === 'location-check' && /Still waiting/.test(n.body));
  const checkFeed = st => st.messages.filter(m => m.kind === 'check');
  const target = (st, id) => st.checkCall ? st.checkCall.targets.find(t => t.id === id) : undefined;
  // Doctor the stored league through a backup → mutate → restore round-trip.
  async function doctor(tF, mutate) {
    const dl = await rawReq(base, tF, 'GET', '/api/admin/backup');
    const bk = JSON.parse(dl.text);
    mutate(bk.state);
    return rawReq(base, tF, 'POST', '/api/admin/restore', JSON.stringify(bk));
  }
  try {
    const tF = await claim(base, F), tV = await claim(base, V), tA = await claim(base, A),
      tB = await claim(base, B), tC = await claim(base, C), tD = await claim(base, D), tW = await claim(base, WATCH);
    const ctxF = makeSub(origin, '/push/f'), ctxA = makeSub(origin, '/push/a'), ctxB = makeSub(origin, '/push/b'),
      ctxC = makeSub(origin, '/push/c'), ctxD = makeSub(origin, '/push/d');
    await req(base, tF, 'POST', '/api/push/subscribe', { subscription: ctxF.sub });
    await req(base, tA, 'POST', '/api/push/subscribe', { subscription: ctxA.sub });
    await req(base, tB, 'POST', '/api/push/subscribe', { subscription: ctxB.sub });
    await req(base, tC, 'POST', '/api/push/subscribe', { subscription: ctxC.sub });
    await req(base, tD, 'POST', '/api/push/subscribe', { subscription: ctxD.sub });

    // ── the ping ──
    check('ping: a watching member cannot ping → 400', (await req(base, tW, 'POST', '/api/ping', {})).status === 400);
    let r = await req(base, tA, 'POST', '/api/ping', {});
    let st = r.json.state;
    check('ping: a hunter pings the league — every other in-game hunter is a recipient', r.status === 200 && r.json.pinged === 5, [r.status, r.json.pinged]);
    check('ping: exactly one NAMED feed entry', st.messages.filter(m => m.kind === 'ping').length === 1 && st.messages.find(m => m.kind === 'ping').text === '📍 David Brockmen pinged the league for a location update.', st.messages.filter(m => m.kind === 'ping').map(m => m.text));
    const pingB = await waitForPush(received, m => m.url === '/push/b');
    check('ping: the push reached another hunter', !!pingB);
    if (pingB) {
      const note = decryptPush(pingB.body, ctxB);
      check('ping: payload decrypts — tag league-ping, body NAMES the sender',
        note.tag === 'league-ping' && note.body === '📍 David Brockmen pinged the league — open the app to update your location.', note);
    }
    check('ping: the sender himself receives no ping push', bodiesAt('/push/a', ctxA).filter(n => n.tag === 'league-ping').length === 0);
    r = await req(base, tA, 'POST', '/api/ping', {});
    check('ping: a second ping inside the cooldown → 429 with the remaining wait',
      r.status === 429 && typeof r.json.retryAfterMs === 'number' && r.json.retryAfterMs > 0 && r.json.retryAfterMs <= 4000, [r.status, r.json.retryAfterMs]);
    await new Promise(r2 => setTimeout(r2, 4400));
    r = await req(base, tA, 'POST', '/api/ping', {});
    check('ping: after the cooldown the ping lands again', r.status === 200 && r.json.state.messages.filter(m => m.kind === 'ping').length === 2, r.status);

    // ── check settings ──
    check('check-settings: a non-admin is refused → 403', (await req(base, tA, 'POST', '/api/admin/check-settings', { intervalMin: 10, deadlineMin: 60 })).status === 403);
    check('check-settings: interval below 5 → 400', (await req(base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 4, deadlineMin: 60 })).status === 400);
    check('check-settings: interval above 120 → 400', (await req(base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 121, deadlineMin: 60 })).status === 400);
    check('check-settings: deadline below 15 → 400', (await req(base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 10, deadlineMin: 14 })).status === 400);
    check('check-settings: deadline above 480 → 400', (await req(base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 10, deadlineMin: 481 })).status === 400);
    r = await req(base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 5, deadlineMin: 15 });
    st = r.json.state;
    check('check-settings: a valid save lands and rides the admin payload', r.status === 200 && st.checkSettings.intervalMin === 5 && st.checkSettings.deadlineMin === 15, st.checkSettings);
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('check-settings: regular hunters never receive the settings block', st.checkSettings === undefined && st.checkCall === null && st.pingCooldownMs === 4000, [st.checkSettings, st.checkCall, st.pingCooldownMs]);

    // ── call #1: start, snapshot, targets ──
    check('check-call: a non-admin cannot start a call → 403', (await req(base, tA, 'POST', '/api/admin/check-call/start', {})).status === 403);
    for (const t of [tA, tB, tC, tD]) await req(base, t, 'POST', '/api/sharing', { on: true });
    r = await req(base, tF, 'POST', '/api/admin/check-call/start', {});
    st = r.json.state;
    check('check-call: the founder starts a call', r.status === 200 && !!st.checkCall, r.status);
    check('check-call: payload block — starter named, LIVE mode, snapshot settings (5 / 15)',
      st.checkCall.startedByName === 'Christian Dyer' && st.checkCall.mode === 'live' && st.checkCall.intervalMin === 5 && st.checkCall.deadlineMin === 15, st.checkCall && [st.checkCall.mode, st.checkCall.intervalMin, st.checkCall.deadlineMin]);
    check('check-call: LIVE target snapshot = alive hunters with sharing ON (not the vice, not the founder, not watching)',
      st.checkCall.targets.map(t => t.id).sort().join(',') === [A, B, C, D].sort().join(',') && st.checkCall.targets.every(t => t.checkedIn === false && t.checkedInAt === null), st.checkCall.targets.map(t => t.id));
    check('check-call: the public block carries NO location data', !/"lat"|"lng"/.test(JSON.stringify(st.checkCall)), JSON.stringify(st.checkCall).slice(0, 120));
    check('check-call: the start feed entry names the admin and the window',
      checkFeed(st).some(m => m.text === '📍 Christian Dyer called a LOCATION CHECK — 15 min to check in.'), checkFeed(st).map(m => m.text));
    for (const [url, ctx, who] of [['/push/a', ctxA, 'A'], ['/push/b', ctxB, 'B'], ['/push/c', ctxC, 'C'], ['/push/d', ctxD, 'D']]) {
      const hit = await waitForPush(received, m => m.url === url && bodiesAt(url, ctx).some(n => n.tag === 'location-check'));
      check(`check-call: the start push reached target ${who}`, !!hit);
    }
    const startD = bodiesAt('/push/d', ctxD).find(n => n.tag === 'location-check');
    check('check-call: the start push body carries the deadline', !!startD && startD.body === '📍 LOCATION CHECK — open the app and update your location. You have 15 minutes.', startD);
    check('check-call: the non-target founder got NO start push', bodiesAt('/push/f', ctxF).filter(n => n.tag === 'location-check').length === 0);
    check('check-call: a second start while one is active → 400', (await req(base, tV, 'POST', '/api/admin/check-call/start', {})).status === 400);
    await new Promise(r2 => setTimeout(r2, 800));
    check('check-call: no reminders before the first interval elapses', remindersTo('/push/d', ctxD).length === 0, remindersTo('/push/d', ctxD).length);

    // ── check-ins: plain, safe-zone-hidden, driving ──
    await req(base, tA, 'POST', '/api/position', { lat: 40.31415, lng: -83.27182 });
    st = (await req(base, tB, 'GET', '/api/state')).json;
    check('check-in: a plain fix checks the hunter in', target(st, A).checkedIn === true && typeof target(st, A).checkedInAt === 'string', target(st, A));
    check('check-in: the block still leaks no coordinates after fixes land', !JSON.stringify(st.checkCall).includes('40.31415'));
    await req(base, tB, 'POST', '/api/safe-zones', { label: 'home', lat: 40.5, lng: -83.5, radius: 150 });
    await req(base, tB, 'POST', '/api/position', { lat: 40.5, lng: -83.5 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('check-in: a safe-zone-hidden fix still checks in (pin hidden, server saw the fix)',
      me(st, B).position === null && target(st, B).checkedIn === true, [me(st, B).position, target(st, B)]);
    await req(base, tC, 'POST', '/api/position', { lat: 41.0, lng: -84.0, speed: 12 });
    await req(base, tC, 'POST', '/api/position', { lat: 41.001, lng: -84.0, speed: 12 });
    st = (await req(base, tA, 'GET', '/api/state')).json;
    check('check-in: a driving hunter checks in too (driving mode on, fix received)',
      me(st, C).driving === true && target(st, C).checkedIn === true, [me(st, C).driving, target(st, C)]);

    // ── settings snapshot: editing settings mid-call changes nothing ──
    r = await req(base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 30, deadlineMin: 120 });
    st = r.json.state;
    check('check-call: settings edits land for the NEXT call but the running call keeps its snapshot',
      st.checkSettings.intervalMin === 30 && st.checkCall.intervalMin === 5 && st.checkCall.deadlineMin === 15, [st.checkSettings.intervalMin, st.checkCall.intervalMin, st.checkCall.deadlineMin]);

    // ── reminders: stragglers only, on the interval ──
    let rr = await doctor(tF, s => { s.league.checkCall.lastReminderAtMs = Date.now() - 5 * 60000 - 5000; });
    check('doctor: reminder-due restore → 200', rr.status === 200, rr.status);
    const rem1 = await waitFor(() => remindersTo('/push/d', ctxD).length === 1);
    check('reminder: the straggler got exactly one when the interval came due', !!rem1);
    if (rem1) check('reminder: body counts down the remaining minutes', /Still waiting — \d+ min left to check in or you're OUT\./.test(remindersTo('/push/d', ctxD)[0].body), remindersTo('/push/d', ctxD)[0]);
    check('reminder: checked-in hunters got none', remindersTo('/push/a', ctxA).length === 0 && remindersTo('/push/b', ctxB).length === 0 && remindersTo('/push/c', ctxC).length === 0,
      [remindersTo('/push/a', ctxA).length, remindersTo('/push/b', ctxB).length, remindersTo('/push/c', ctxC).length]);

    // ── sleep catch-up: three missed intervals collapse into ONE reminder ──
    rr = await doctor(tF, s => { s.league.checkCall.lastReminderAtMs = Date.now() - 3 * 5 * 60000 - 5000; });
    check('doctor: slept-through restore → 200', rr.status === 200, rr.status);
    await waitFor(() => remindersTo('/push/d', ctxD).length === 2);
    await new Promise(r2 => setTimeout(r2, 900));
    check('catch-up: a long sleep yields ONE catch-up reminder, never a burst', remindersTo('/push/d', ctxD).length === 2, remindersTo('/push/d', ctxD).length);

    // ── the deadline: a live straggler is OUT, exactly once, no XP ──
    st = (await req(base, tF, 'GET', '/api/state')).json;
    const xpLogLen = (st.xpLog || []).length, dXp = me(st, D).xp;
    rr = await doctor(tF, s => {
      s.league.checkCall.deadlineAtMs = Date.now() - 1000;
      s.league.checkCall.deadlineAt = new Date(Date.now() - 1000).toISOString();
    });
    check('doctor: deadline-passed restore → 200', rr.status === 200, rr.status);
    const outState = await waitFor(async () => { const s2 = (await req(base, tF, 'GET', '/api/state')).json; return me(s2, D).out ? s2 : null; });
    check('deadline: the straggler is OUT (and not merely dead-flagged)', !!outState && me(outState, D).alive === false && me(outState, D).out === true, outState && [me(outState, D).alive, me(outState, D).out]);
    st = outState;
    check('deadline: the checked-in hunters are untouched', [A, B, C].every(id => me(st, id).alive && !me(st, id).out));
    check('deadline: exactly one public elimination entry, naming the straggler',
      checkFeed(st).filter(m => /never checked in/.test(m.text)).length === 1 && checkFeed(st).some(m => m.text === '☠️ Memphis Seadler never checked in — OUT.'), checkFeed(st).map(m => m.text));
    const outPushes = bodiesAt('/push/d', ctxD).filter(n => n.tag === 'check-out');
    check('deadline: the eliminated hunter got the ☠️ push', outPushes.length === 1 && outPushes[0].body === "☠️ You didn't check in — you're OUT.", outPushes);
    check('deadline: NO XP changed hands — the ledger is exactly as it was',
      (st.xpLog || []).length === xpLogLen && me(st, D).xp === dXp, [(st.xpLog || []).length, xpLogLen, me(st, D).xp, dXp]);
    check('deadline: the call is closed', st.checkCall === null, st.checkCall);
    await new Promise(r2 => setTimeout(r2, 900));
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('deadline: extra ticks never re-process — still one entry, one push',
      checkFeed(st).filter(m => /never checked in/.test(m.text)).length === 1 && bodiesAt('/push/d', ctxD).filter(n => n.tag === 'check-out').length === 1);
    check('ping: an eliminated hunter cannot ping → 400', (await req(base, tD, 'POST', '/api/ping', {})).status === 400);

    // ── call #2: a target killed mid-call is skipped at the deadline ──
    r = await req(base, tF, 'POST', '/api/admin/check-call/start', {});
    st = r.json.state;
    check('call #2: starts against the survivors (new 30/120 snapshot)',
      r.status === 200 && st.checkCall.targets.map(t => t.id).sort().join(',') === [A, B, C].sort().join(',') && st.checkCall.deadlineMin === 120, st.checkCall && st.checkCall.targets.map(t => t.id));
    await req(base, tB, 'POST', '/api/position', { lat: 40.6, lng: -83.6 });
    await req(base, tC, 'POST', '/api/position', { lat: 41.0, lng: -84.0, speed: 0 });
    const kd = await req(base, tB, 'POST', '/api/kills', { victimId: A, stealth: false });
    await req(base, tA, 'POST', `/api/kills/${kd.json.kill.id}/confirm`, {});
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('call #2: the kill landed mid-call — the target is dead by other means', me(st, A).alive === false && !!target(st, A));
    rr = await doctor(tF, s => {
      s.league.checkCall.deadlineAtMs = Date.now() - 1000;
      s.league.checkCall.deadlineAt = new Date(Date.now() - 1000).toISOString();
    });
    await waitFor(async () => { const s2 = (await req(base, tF, 'GET', '/api/state')).json; return s2.checkCall === null ? s2 : null; });
    await new Promise(r2 => setTimeout(r2, 600));
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('call #2: the deadline skipped the kill victim — no check elimination, no ☠️ push for him',
      !checkFeed(st).some(m => /never checked in/.test(m.text) && /David/.test(m.text)) && bodiesAt('/push/a', ctxA).filter(n => n.tag === 'check-out').length === 0, checkFeed(st).map(m => m.text));
    check('call #2: the checked-in hunters survive the deadline', me(st, B).alive && !me(st, B).out && me(st, C).alive && !me(st, C).out);

    // ── call #3: the vice can start; cancel voids everything ──
    r = await req(base, tV, 'POST', '/api/admin/check-call/start', {});
    check('call #3: the VICE can call a check', r.status === 200 && r.json.state.checkCall.startedByName === 'Isaiah Twigg', [r.status, r.json.state.checkCall && r.json.state.checkCall.startedByName]);
    r = await req(base, tF, 'POST', '/api/admin/check-call/cancel', {});
    st = r.json.state;
    check('cancel: the call is off, with the called-off entry in the feed',
      r.status === 200 && st.checkCall === null && checkFeed(st).some(m => m.text === '📍 Location check called off.'), [r.status, checkFeed(st).map(m => m.text)]);
    check('cancel: cancelling with nothing running → 400', (await req(base, tF, 'POST', '/api/admin/check-call/cancel', {})).status === 400);
    await new Promise(r2 => setTimeout(r2, 800));
    st = (await req(base, tF, 'GET', '/api/state')).json;
    check('cancel: nobody was eliminated by the canceled call', me(st, B).alive && !me(st, B).out && me(st, C).alive && !me(st, C).out && checkFeed(st).filter(m => /never checked in/.test(m.text)).length === 1);
  } finally { child.kill(); fake.close(); }

  // ── plain setup: start refused; scrimmage: practice deadline, quiet close ──
  const s2 = await startServer(3423, '2027-01-01T05:00:00.000Z', { CHECK_TICK_MS: '300', PING_COOLDOWN_MS: '4000' });
  async function doctor2(tF, mutate) {
    const dl = await rawReq(s2.base, tF, 'GET', '/api/admin/backup');
    const bk = JSON.parse(dl.text);
    mutate(bk.state);
    return rawReq(s2.base, tF, 'POST', '/api/admin/restore', JSON.stringify(bk));
  }
  try {
    const tF = await claim(s2.base, F), tA = await claim(s2.base, A), tB = await claim(s2.base, B);
    // old saves: strip every Round 7 field and restore — defaults throughout
    const rr0 = await doctor2(tF, s => {
      delete s.league.checkSettings; delete s.league.checkCall;
      for (const p of s.players) delete p.lastPingAt;
    });
    check('old-save: a pre-Round-7 backup restores → 200', rr0.status === 200, rr0.status);
    let st = (await req(s2.base, tF, 'GET', '/api/state')).json;
    check('old-save: check settings default to 15 / 60, no call active',
      st.checkSettings.intervalMin === 15 && st.checkSettings.deadlineMin === 60 && st.checkCall === null, st.checkSettings);
    let r = await req(s2.base, tA, 'POST', '/api/ping', {});
    check('ping: works in plain setup too (lastPingAt defaulted on the old save)', r.status === 200 && r.json.state.messages.some(m => m.kind === 'ping'), r.status);
    check('check-call: starting in plain setup → 400', (await req(s2.base, tF, 'POST', '/api/admin/check-call/start', {})).status === 400);
    await req(s2.base, tF, 'POST', '/api/admin/check-settings', { intervalMin: 5, deadlineMin: 15 });
    await req(s2.base, tF, 'POST', '/api/admin/scrimmage', { on: true });
    r = await req(s2.base, tF, 'POST', '/api/admin/check-call/start', {});
    st = r.json.state;
    check('scrimmage call: starts, mode scrimmage, targets = EVERYBODY claimed and in (sharing irrelevant)',
      r.status === 200 && st.checkCall.mode === 'scrimmage' && st.checkCall.targets.map(t => t.id).sort().join(',') === [F, A, B].sort().join(','), st.checkCall && [st.checkCall.mode, st.checkCall.targets.map(t => t.id)]);
    await req(s2.base, tA, 'POST', '/api/sharing', { on: true });
    await req(s2.base, tA, 'POST', '/api/position', { lat: 40.2, lng: -83.2 });
    st = (await req(s2.base, tF, 'GET', '/api/state')).json;
    check('scrimmage call: a fix checks in here too', st.checkCall.targets.find(t => t.id === A).checkedIn === true);
    const rr = await doctor2(tF, s => {
      s.league.checkCall.deadlineAtMs = Date.now() - 1000;
      s.league.checkCall.deadlineAt = new Date(Date.now() - 1000).toISOString();
    });
    check('doctor: scrimmage deadline restore → 200', rr.status === 200, rr.status);
    const over = await waitFor(async () => { const s3 = (await req(s2.base, tF, 'GET', '/api/state')).json; return s3.checkCall === null ? s3 : null; });
    check('scrimmage deadline: the call closed', !!over);
    st = over || (await req(s2.base, tF, 'GET', '/api/state')).json;
    const overEntry = checkFeed(st).find(m => /Scrimmage check over/.test(m.text));
    check('scrimmage deadline: ONE wrap-up entry naming who WOULD have been out',
      checkFeed(st).filter(m => /Scrimmage check over/.test(m.text)).length === 1 && !!overEntry && /would have been out/.test(overEntry.text) && /Korben Beecham/.test(overEntry.text) && /Christian Dyer/.test(overEntry.text) && !/David/.test(overEntry.text), checkFeed(st).map(m => m.text));
    check('scrimmage deadline: NOBODY was eliminated', [F, A, B].every(id => me(st, id).alive && !me(st, id).out), [F, A, B].map(id => [me(st, id).alive, me(st, id).out]));
    // quiet close: end the scrimmage mid-call
    r = await req(s2.base, tF, 'POST', '/api/admin/check-call/start', {});
    check('scrimmage call #2: starts', r.status === 200 && !!r.json.state.checkCall, r.status);
    r = await req(s2.base, tF, 'POST', '/api/admin/scrimmage', { on: false });
    st = r.json.state;
    check('quiet close: ending the scrimmage closes the call with it', st.checkCall === null, st.checkCall);
    await new Promise(r2 => setTimeout(r2, 800));
    st = (await req(s2.base, tF, 'GET', '/api/state')).json;
    check('quiet close: no eliminations, no check-out entries, everyone still standing',
      st.checkCall === null && checkFeed(st).filter(m => /never checked in/.test(m.text)).length === 0 && [F, A, B].every(id => me(st, id).alive && !me(st, id).out), checkFeed(st).map(m => m.text));
  } finally { s2.child.kill(); }
}

(async () => {
  try {
    await suiteSetup();
    await suiteLive();
    await suitePush();
    await suitePushCancel();
    await suiteBackup();
    await suiteZonesDriving();
    await suiteRound5();
    await suiteHuntMode();
    await suiteRound7();
  } catch (e) { failed++; console.error('\nSUITE ERROR:', e); }
  console.log(`\n════ RESULT: ${passed} passed, ${failed} failed ════`);
  process.exit(failed ? 1 : 0);
})();
