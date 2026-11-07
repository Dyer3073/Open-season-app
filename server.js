'use strict';

// Open Season — Private Group App (standalone, zero-dependency)
// One Node http server: JSON API + static PWA from /public.
// All game rules are enforced here, server-side. Persistence via lib/store.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const { RANKS, XP, rankFor, applyXp, deathXp, uid } = require('./lib/xp');

const PORT = process.env.PORT || 3000;
const LEAGUE_CODE = process.env.LEAGUE_CODE || 'BOYZ-2027';
const ADMIN_RESET_CODE = process.env.ADMIN_RESET_CODE || ''; // founder emergency reset (set in Render env)
const REVERSE_WINDOW_MS = 24 * 60 * 60 * 1000;

let state = store.load();
const save = () => store.save(state);

// ── helpers ──────────────────────────────────────────────────────────────────
function phase() {
  if (state.league.phase === 'closed') return 'closed';
  return Date.now() >= Date.parse(state.league.seasonStart) ? 'live' : 'setup';
}
function playerById(id) { return state.players.find(p => p.id === id) || null; }
function hashPin(pin, id) { return crypto.createHash('sha256').update(String(pin) + '::' + id).digest('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function inOwnSafeZone(p) {
  if (!p.position) return false;
  return p.safeZones.some(z => haversineM(p.position.lat, p.position.lng, z.lat, z.lng) <= (z.radius || 150));
}
function feed(kind, text, playerId) {
  state.messages.push({ id: uid('msg'), ts: new Date().toISOString(), playerId: playerId || null, kind, text });
}
function publicPlayer(p, viewer) {
  const isSelf = viewer && viewer.id === p.id;
  const visible = p.sharing && p.position && !inOwnSafeZone(p) && !p.out;
  const rk = rankFor(p.xp);
  return {
    id: p.id, name: p.name, role: p.role, watching: p.watching, claimed: p.claimed,
    xp: p.xp, rank: rk.name, rankMin: rk.min, nextRank: rk.nextName, nextMin: rk.nextMin, progress: rk.progress,
    alive: p.alive, out: p.out, seasonKills: p.seasonKills, sharing: p.sharing,
    position: visible ? { lat: p.position.lat, lng: p.position.lng, ts: p.position.ts } : null,
    inSafeZone: isSelf ? inOwnSafeZone(p) : false,
    reverseCard: isSelf ? p.reverseCard : undefined,
    safeZones: isSelf ? p.safeZones : undefined,
  };
}
function publicKill(k, viewer) {
  const hideKiller = k.stealth && k.status === 'pending' && viewer && viewer.id !== k.killerId && viewer.role !== 'Founder' && viewer.role !== 'Vice';
  return { ...k, killerId: hideKiller ? null : k.killerId, killerHidden: !!hideKiller };
}
function snapshot(viewer) {
  return {
    league: { ...state.league, phase: phase(), reverseWindowHours: 24 },
    me: viewer ? publicPlayer(viewer, viewer) : null,
    players: state.players.map(p => publicPlayer(p, viewer)),
    messages: state.messages.slice(-300),
    kills: state.kills.map(k => publicKill(k, viewer)),
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
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── kill resolution ──────────────────────────────────────────────────────────
// Applies a confirmed kill: victim dies (-75), killer paid (+100 / +125 stealth
// / +50 marked-man bonus). A later reverse does NOT claw any of this back.
function resolveKill(k, via) {
  const killer = playerById(k.killerId);
  const victim = playerById(k.victimId);
  k.status = 'confirmed';
  k.confirmedAt = new Date().toISOString();
  k.reverseExpiresAt = new Date(Date.now() + REVERSE_WINDOW_MS).toISOString();
  victim.alive = false;
  killer.seasonKills += 1;
  const base = k.stealth ? XP.STEALTH_KILL : XP.KILL;
  applyXp(state, killer, base, k.stealth ? 'stealth-kill' : 'kill', `Killed ${victim.name}${via ? ' (' + via + ')' : ''}`);
  if (state.league.markedManId === victim.id) {
    applyXp(state, killer, XP.MARKED_MAN_BONUS, 'marked-man-bonus', `Took out the marked man (${victim.name})`);
  }
  deathXp(state, victim, `Killed by ${killer.name}`);
  feed('kill', `${killer.name} took out ${victim.name}. ${victim.name} has 24 hours to play a Reverse Kill card.`, killer.id);
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const body = method === 'POST' || method === 'DELETE' ? await readBody(req).catch(() => null) : {};
  if (body === null) return json(res, 400, { error: 'Bad JSON' });

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
    p.pinHash = hashPin(body.pin, p.id);
    p.token = newToken();
    p.joinedAt = new Date().toISOString();
    feed('system', `${p.name} joined the league.`, p.id);
    save();
    return json(res, 200, { token: p.token, state: snapshot(p) });
  }

  if (method === 'POST' && url.pathname === '/api/login') {
    const p = playerById(body.playerId);
    if (!p || !p.claimed) return json(res, 404, { error: 'Spot not claimed yet' });
    if (p.pinHash !== hashPin(body.pin || '', p.id)) return json(res, 403, { error: 'Wrong PIN' });
    p.token = newToken();
    save();
    return json(res, 200, { token: p.token, state: snapshot(p) });
  }

  // everything below requires auth
  const me = auth(req);
  if (!me) return json(res, 401, { error: 'Not logged in' });

  if (method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot(me));

  if (method === 'POST' && url.pathname === '/api/logout') { me.token = null; save(); return json(res, 200, { ok: true }); }

  if (method === 'POST' && url.pathname === '/api/messages') {
    const text = String(body.text || '').trim().slice(0, 1000);
    if (!text) return json(res, 400, { error: 'Empty message' });
    const m = { id: uid('msg'), ts: new Date().toISOString(), playerId: me.id, kind: 'chat', text };
    state.messages.push(m);
    save();
    return json(res, 200, { message: m, state: snapshot(me) });
  }

  if (method === 'POST' && url.pathname === '/api/sharing') {
    const on = !!body.on;
    me.sharing = on;
    if (!on) me.position = null;
    // League rule: turning sharing off mid-season (while alive and in) = out.
    if (!on && phase() === 'live' && me.alive && !me.watching) {
      me.out = true; me.alive = false;
      feed('system', `${me.name} turned location off mid-season and is OUT.`, me.id);
    }
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  if (method === 'POST' && url.pathname === '/api/position') {
    const { lat, lng } = body;
    if (typeof lat !== 'number' || typeof lng !== 'number') return json(res, 400, { error: 'lat/lng required' });
    if (!me.sharing) return json(res, 400, { error: 'Turn location sharing on first' });
    me.position = { lat, lng, ts: new Date().toISOString() };
    save();
    return json(res, 200, { inSafeZone: inOwnSafeZone(me), state: snapshot(me) });
  }

  if (method === 'POST' && url.pathname === '/api/safe-zones') {
    const { label, lat, lng } = body;
    if (!['home', 'work', 'church'].includes(label)) return json(res, 400, { error: 'label must be home, work, or church' });
    if (typeof lat !== 'number' || typeof lng !== 'number') return json(res, 400, { error: 'lat/lng required' });
    me.safeZones = me.safeZones.filter(z => z.label !== label);
    me.safeZones.push({ id: uid('zone'), label, lat, lng, radius: Math.min(1000, Math.max(50, Number(body.radius) || 150)) });
    save();
    return json(res, 200, { state: snapshot(me) });
  }
  if (method === 'DELETE' && seg[1] === 'safe-zones' && seg[2]) {
    me.safeZones = me.safeZones.filter(z => z.id !== seg[2]);
    save();
    return json(res, 200, { state: snapshot(me) });
  }

  // ── kills ──
  if (method === 'POST' && url.pathname === '/api/kills') {
    if (phase() !== 'live') return json(res, 403, { error: 'Kill claims are locked until the season goes live (January 1, 2027).' });
    const victim = playerById(body.victimId);
    if (!victim || victim.id === me.id) return json(res, 400, { error: 'Pick another hunter as your target' });
    if (me.watching || victim.watching) return json(res, 400, { error: 'Watching members are not in the hunt' });
    if (!me.alive || me.out) return json(res, 400, { error: 'You are out — dead men tell no tales' });
    if (!victim.alive || victim.out) return json(res, 400, { error: 'That hunter is already out' });
    if (state.kills.some(k => k.killerId === me.id && k.victimId === victim.id && k.status === 'pending')) {
      return json(res, 409, { error: 'You already have a pending claim on that hunter' });
    }
    const k = {
      id: uid('kill'), killerId: me.id, victimId: victim.id, stealth: !!body.stealth,
      status: 'pending', createdAt: new Date().toISOString(), confirmedAt: null,
      reverseExpiresAt: new Date(Date.now() + REVERSE_WINDOW_MS).toISOString(),
    };
    state.kills.push(k);
    feed('system', k.stealth ? `A stealth kill was claimed on ${victim.name} — awaiting confirmation.` : `${me.name} claimed a kill on ${victim.name} — awaiting confirmation.`, me.id);
    save();
    return json(res, 200, { kill: publicKill(k, me), state: snapshot(me) });
  }

  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'confirm') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'pending') return json(res, 404, { error: 'No pending claim with that id' });
    if (k.victimId !== me.id) return json(res, 403, { error: 'Only the victim can confirm' });
    resolveKill(k, 'confirmed by victim');
    save();
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
  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'reverse') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'confirmed') return json(res, 404, { error: 'No confirmed kill to reverse' });
    if (k.victimId !== me.id) return json(res, 403, { error: 'Only the victim can play a Reverse Kill' });
    if (!me.reverseCard) return json(res, 400, { error: 'Your Reverse Kill card is spent' });
    if (Date.now() > Date.parse(k.reverseExpiresAt)) return json(res, 400, { error: 'The 24-hour Reverse window has closed' });
    const killer = playerById(k.killerId);
    // Reverse scores as its OWN kill: victim +150, killer dies -75. Original kill XP is NOT clawed back.
    me.reverseCard = false;
    me.alive = true;
    me.seasonKills += 1;
    killer.alive = false;
    applyXp(state, me, XP.REVERSE_KILL, 'reverse-kill', `Reversed a kill on ${killer.name}`);
    deathXp(state, killer, `Reverse Kill by ${me.name}`);
    k.status = 'reversed';
    k.reverseExpiresAt = new Date(Date.now() + REVERSE_WINDOW_MS).toISOString(); // counter-reverse window
    feed('kill', `REVERSE KILL — ${me.name} played the card. ${killer.name} dies instead. ${killer.name} has 24 hours to counter-reverse.`, me.id);
    save();
    return json(res, 200, { state: snapshot(me) });
  }
  if (method === 'POST' && seg[1] === 'kills' && seg[2] && seg[3] === 'counter-reverse') {
    const k = state.kills.find(x => x.id === seg[2]);
    if (!k || k.status !== 'reversed') return json(res, 404, { error: 'No reversed kill to counter' });
    if (k.killerId !== me.id) return json(res, 403, { error: 'Only the reversed killer can counter-reverse' });
    if (!me.reverseCard) return json(res, 400, { error: 'Your Reverse Kill card is spent' });
    if (Date.now() > Date.parse(k.reverseExpiresAt)) return json(res, 400, { error: 'The counter-reverse window has closed' });
    const victim = playerById(k.victimId);
    // Original kill stands: victim dies again (-75 charged again), killer lives.
    // Killer is NOT paid again. Both cards are now spent.
    me.reverseCard = false;
    me.alive = true;
    victim.alive = false;
    deathXp(state, victim, `Counter-reverse by ${me.name} — original kill stands`);
    k.status = 'counter-reversed';
    feed('kill', `COUNTER-REVERSE — ${me.name} played his card. The original kill stands and ${victim.name} is out. Both cards are spent.`, me.id);
    save();
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

    if (method === 'POST' && seg[2] === 'settings') {
      if ('platform' in body) state.league.platform = body.platform || null;
      if ('weaponClass' in body) state.league.weaponClass = body.weaponClass || null;
      if ('pot' in body) state.league.pot = Math.max(0, Number(body.pot) || 0);
      if ('markedManId' in body) state.league.markedManId = body.markedManId || null;
      feed('system', `Season setup updated by ${me.name}: platform ${state.league.platform || '—'}, class ${state.league.weaponClass || '—'}, pot $${state.league.pot}, marked man ${state.league.markedManId ? playerById(state.league.markedManId).name : '—'}.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'settle-kill') {
      const k = state.kills.find(x => x.id === body.killId);
      if (!k || k.status !== 'disputed') return json(res, 404, { error: 'No disputed kill with that id' });
      if (k.killerId === me.id || k.victimId === me.id) return json(res, 403, { error: 'A party to the kill cannot settle it — the other admin does' });
      if (body.outcome === 'confirm') { resolveKill(k, `settled by ${me.name}`); }
      else if (body.outcome === 'reject') {
        k.status = 'rejected';
        feed('system', `${me.name} rejected the disputed kill claim on ${playerById(k.victimId).name}. No kill, no XP.`, me.id);
      } else return json(res, 400, { error: 'outcome must be confirm or reject' });
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'event-win') {
      const p = playerById(body.playerId);
      if (!p) return json(res, 404, { error: 'Player not found' });
      applyXp(state, p, XP.EVENT_WIN, 'event-win', body.note || `Combo event win recorded by ${me.name}`);
      feed('xp', `${p.name} won a combo event: +${XP.EVENT_WIN} XP.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'adjust-xp') {
      const p = playerById(body.playerId);
      const delta = Number(body.delta);
      if (!p || !Number.isFinite(delta) || delta === 0) return json(res, 400, { error: 'playerId and a non-zero delta are required' });
      const applied = applyXp(state, p, delta, 'adjust', body.note || `Manual adjust by ${me.name}`);
      feed('xp', `${me.name} adjusted ${p.name}'s XP by ${applied > 0 ? '+' : ''}${applied}${body.note ? ' — ' + body.note : ''}.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    if (method === 'POST' && seg[2] === 'close-season') {
      const alive = state.players.filter(p => !p.watching && p.alive && !p.out);
      let lastMan = body.lastManId ? playerById(body.lastManId) : (alive.length === 1 ? alive[0] : null);
      if (!lastMan) return json(res, 400, { error: 'Name the Last Man (lastManId) — more than one hunter is still alive (Reckoning result)' });
      const deadliest = state.players.filter(p => !p.watching).sort((a, b) => b.seasonKills - a.seasonKills)[0];
      applyXp(state, lastMan, XP.LAST_MAN, 'last-man', `Last Man — Season ${state.league.season}`);
      feed('xp', `SEASON ${state.league.season} CLOSED — ${lastMan.name} is the LAST MAN: +${XP.LAST_MAN} XP.`, me.id);
      if (deadliest && deadliest.seasonKills > 0) {
        applyXp(state, deadliest, XP.DEADLIEST_MAN, 'deadliest-man', `Deadliest Man — Season ${state.league.season} (${deadliest.seasonKills} kills)`);
        feed('xp', `${deadliest.name} is Deadliest Man with ${deadliest.seasonKills} kills: +${XP.DEADLIEST_MAN} XP.`, me.id);
      }
      // Reset the season; career XP and ranks carry over untouched.
      state.league.season += 1;
      const y = new Date().getUTCFullYear();
      state.league.seasonStart = `${y + 1}-01-01T05:00:00.000Z`;
      state.league.phase = 'setup';
      state.league.markedManId = lastMan.id; // champion starts next season marked (champion's privilege: he also picks platform/class via settings)
      state.kills = [];
      state.players.forEach(p => { p.alive = true; p.out = false; p.seasonKills = 0; p.reverseCard = true; p.sharing = false; p.position = null; });
      feed('system', `Season ${state.league.season} setup is open. ${lastMan.name} starts as the marked man and picks the platform/class.`, me.id);
      save();
      return json(res, 200, { state: snapshot(me) });
    }
    return json(res, 404, { error: 'Unknown admin route' });
  }

  return json(res, 404, { error: 'Unknown route' });
}

// ── static PWA ───────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { console.error(e); json(res, 500, { error: 'Server error' }); });
  } else serveStatic(req, res, url);
});
server.listen(PORT, () => console.log(`Open Season app listening on :${PORT} (data: ${store.FILE})`));
