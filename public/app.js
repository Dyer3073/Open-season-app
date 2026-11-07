'use strict';
const $ = s => document.querySelector(s);
let S = null; // server state snapshot
let token = localStorage.getItem('os_token') || '';
let myId = localStorage.getItem('os_player') || '';
let map = null, markers = [], watchId = null, lastPos = null;

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  setTimeout(() => { t.hidden = true; }, ms);
}
async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
function nameOf(id) { const p = S && S.players.find(x => x.id === id); return p ? p.name : 'Unknown'; }
function initials(name) { return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function fmtTime(ts) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

// ── login ──
async function loadRoster() {
  const { players } = await api('/api/roster');
  $('#loginPlayer').innerHTML = players.map(p =>
    `<option value="${p.id}" ${p.id === myId ? 'selected' : ''}>${p.name}${p.role !== 'Member' ? ' (' + p.role + ')' : ''}${p.watching ? ' (watching)' : ''}${p.claimed ? ' — claimed' : ''}</option>`).join('');
}
async function doClaim() {
  try {
    const d = await api('/api/claim', 'POST', { playerId: $('#loginPlayer').value, code: $('#loginCode').value, pin: $('#loginPin').value });
    token = d.token; myId = $('#loginPlayer').value;
    localStorage.setItem('os_token', token); localStorage.setItem('os_player', myId);
    enterApp(d.state); toast('Spot claimed. Welcome to the hunt.');
  } catch (e) { $('#loginError').textContent = e.message; }
}
async function doLogin() {
  try {
    const d = await api('/api/login', 'POST', { playerId: $('#loginPlayer').value, pin: $('#loginPin').value });
    token = d.token; myId = $('#loginPlayer').value;
    localStorage.setItem('os_token', token); localStorage.setItem('os_player', myId);
    enterApp(d.state);
  } catch (e) { $('#loginError').textContent = e.message; }
}
function enterApp(state) {
  S = state;
  $('#loginView').hidden = true; $('#appView').hidden = false;
  render(); startLoops();
}

// ── render ──
function render() {
  if (!S) return;
  const L = S.league, me = S.me;
  document.querySelectorAll('.seasonNum').forEach(el => el.textContent = L.season);
  $('#seasonLine').textContent = `Season ${L.season} — ${L.phase.toUpperCase()}${L.platform ? ' • ' + L.platform : ''}${L.weaponClass ? ' • ' + L.weaponClass : ''}${L.pot ? ' • Pot $' + L.pot : ''}`;
  const ms = Date.parse(L.seasonStart) - Date.now();
  $('#countdown').textContent = L.phase === 'setup' ? (ms > 0 ? `Hunt goes live in ${Math.floor(ms / 864e5)}d ${Math.floor(ms / 36e5) % 24}h ${Math.floor(ms / 6e4) % 60}m` : '') : L.phase === 'live' ? 'THE HUNT IS LIVE' : 'SEASON CLOSED';
  $('#meBar').innerHTML = `<b>${me.name}</b> — <span class="badge rank">${me.rank}</span> ${me.xp} XP` +
    (me.nextMin ? `<div class="bar"><i style="width:${Math.round(me.progress * 100)}%"></i></div><span class="hint">${me.nextMin - me.xp} XP to ${me.nextRank}</span>` : ' — top of the ladder') +
    ` • ${me.watching ? 'Watching' : me.out ? 'OUT' : me.alive ? 'Alive' : 'Dead'} • ${me.seasonKills} kills`;
  renderMap(); renderBoard(); renderChat(); renderMe(); renderAdmin(); renderRules();
}

function renderMap() {
  const me = S.me;
  $('#shareToggle').checked = !!me.sharing;
  $('#shareNote').textContent = me.inSafeZone ? 'You are inside one of your safe zones — your pin is hidden.' :
    me.sharing ? 'Sharing is ON. Your pin shows to the league while the app is open. Turning it off mid-season puts you OUT.' :
    'Sharing is off. Only you can see you.';
  // hunter list
  $('#hunterList').innerHTML = S.players.filter(p => p.claimed || p.position).map(p => {
    const right = p.position ? '📍 on the map' : p.inSafeZone && p.id === me.id ? 'safe zone' : p.sharing ? 'sharing — no fix yet' : 'not sharing';
    return `<div class="hunter"><span><b>${p.name}</b> <span class="sub">${p.rank} • ${p.alive && !p.out ? 'alive' : 'out'}</span></span><span class="sub">${right}</span></div>`;
  }).join('') || '<p class="hint">Nobody is sharing yet.</p>';
  // zones
  $('#zoneList').innerHTML = (me.safeZones || []).map(z =>
    `<div class="hunter"><span>${z.label.toUpperCase()} — ${z.lat.toFixed(4)}, ${z.lng.toFixed(4)} (${z.radius} m)</span><button class="ghost small" onclick="delZone('${z.id}')">Remove</button></div>`).join('');
  drawMap();
}
function drawMap() {
  const pins = S.players.filter(p => p.position);
  const center = pins.length ? [pins[0].position.lat, pins[0].position.lng] : [40.5889, -83.1283]; // Marion, OH
  if (window.L) {
    $('#map').hidden = false; $('#mapFallback').hidden = true;
    if (!map) {
      map = L.map('map').setView(center, 12);
      L.tileLayer('https://{s}.`tile.openstreetmap.org/{z}/{x}/{y}.png`,/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap © CARTO', maxZoom: 19 }).addTo(map);
    }
    markers.forEach(m => map.removeLayer(m)); markers = [];
    const zoneLayer = (S.me.safeZones || []).forEach(z => markers.push(L.circle([z.lat, z.lng], { radius: z.radius, color: '#f96d00', fillColor: '#f96d00', fillOpacity: 0.1 }).addTo(map)));
    pins.forEach(p => {
      const icon = L.divIcon({ className: '', html: `<div class="pin">${initials(p.name)}</div>`, iconSize: [30, 30] });
      markers.push(L.marker([p.position.lat, p.position.lng], { icon }).addTo(map).bindPopup(`<b>${p.name}</b><br>${p.rank} • ${p.seasonKills} kills`));
    });
    if (pins.length) map.setView([pins[0].position.lat, pins[0].position.lng], Math.max(map.getZoom(), 12));
    setTimeout(() => map.invalidateSize(), 60);
  } else {
    // No-tiles fallback grid
    $('#map').hidden = true;
    const fb = $('#mapFallback'); fb.hidden = false;
    if (!pins.length) { fb.innerHTML = '<p class="hint" style="padding:12px">Map tiles unavailable — fallback grid. No hunters are sharing a position right now.</p>'; return; }
    const lats = pins.map(p => p.position.lat), lngs = pins.map(p => p.position.lng);
    const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLn = Math.min(...lngs), maxLn = Math.max(...lngs);
    const px = (v, a, b) => b - a < 1e-9 ? 50 : 8 + ((v - a) / (b - a)) * 84;
    fb.innerHTML = (S.me.safeZones || []).map(z => `<div class="zone" style="left:${px(z.lng, minLn, maxLn)}%;top:${100 - px(z.lat, minLa, maxLa)}%;width:90px;height:90px"></div>`).join('') +
      pins.map(p => `<div class="pin" style="left:${px(p.position.lng, minLn, maxLn)}%;top:${100 - px(p.position.lat, minLa, maxLa)}%" title="${p.name}">${initials(p.name)}</div>`).join('');
  }
}

function renderBoard() {
  const hunters = S.players.filter(p => !p.watching);
  const row = p => `<tr><td><b>${p.name}</b><br><span class="hint">${p.rank} • ${p.xp} XP</span></td><td>${p.seasonKills}</td><td><span class="badge ${p.out || !p.alive ? 'dead' : 'alive'}">${p.out ? 'OUT' : p.alive ? 'ALIVE' : 'DEAD'}</span></td></tr>`;
  $('#huntBoard').innerHTML = `<table><tr><th>Hunter</th><th>Kills</th><th>Status</th></tr>${hunters.filter(p => p.alive && !p.out).map(row).join('')}${hunters.filter(p => !p.alive || p.out).map(row).join('')}</table>`;
  const career = [...S.players].sort((a, b) => b.xp - a.xp);
  $('#careerBoard').innerHTML = `<table><tr><th>#</th><th>Hunter</th><th>Rank</th><th>XP</th></tr>${career.map((p, i) => `<tr><td>${i + 1}</td><td>${p.name}${p.watching ? ' <span class="hint">(watching)</span>' : ''}</td><td><span class="badge rank">${p.rank}</span></td><td>${p.xp}</td></tr>`).join('')}</table>`;
  // action center: things waiting on me
  const me = S.me, acts = [];
  S.kills.filter(k => k.status === 'pending' && k.victimId === me.id).forEach(k => {
    acts.push(`<div class="action"><b>Kill claimed on you</b> by ${k.killerHidden ? 'a stealth hunter' : nameOf(k.killerId)}. Confirm it, or dispute it and let the Founder/Vice settle it.<br><button class="danger" onclick="killAct('${k.id}','confirm')">Confirm — I\'m out</button><button class="ghost small" onclick="killAct('${k.id}','dispute')">Dispute</button></div>`);
  });
  S.kills.filter(k => k.status === 'confirmed' && k.victimId === me.id && me.reverseCard).forEach(k => {
    acts.push(`<div class="action"><b>You were killed by ${nameOf(k.killerId)}.</b> Your Reverse Kill card is live until ${fmtTime(k.reverseExpiresAt)}.<br><button class="primary small" onclick="killAct('${k.id}','reverse')">↩ Play Reverse Kill</button></div>`);
  });
  S.kills.filter(k => k.status === 'reversed' && k.killerId === me.id && me.reverseCard).forEach(k => {
    acts.push(`<div class="action"><b>Your kill was REVERSED by ${nameOf(k.victimId)}.</b> Counter-reverse by ${fmtTime(k.reverseExpiresAt)} or stay dead.<br><button class="primary small" onclick="killAct('${k.id}','counter-reverse')">↩ Counter-Reverse</button></div>`);
  });
  if (me.role === 'Founder' || me.role === 'Vice') {
    S.kills.filter(k => k.status === 'disputed' && k.killerId !== me.id && k.victimId !== me.id).forEach(k => {
      acts.push(`<div class="action"><b>Disputed kill:</b> ${nameOf(k.killerId)} → ${nameOf(k.victimId)}. You settle it.<br><button class="danger" onclick="settleKill('${k.id}','confirm')">Kill stands</button><button class="ghost small" onclick="settleKill('${k.id}','reject')">Reject claim</button></div>`);
    });
  }
  $('#actionCenter').innerHTML = acts.join('');
}

function renderChat() {
  const fid = $('#feed');
  fid.innerHTML = S.messages.map(m => {
    const who = m.playerId ? nameOf(m.playerId) : 'OPEN SEASON';
    return `<div class="msg ${m.kind}"><span class="when">${fmtTime(m.ts)}</span><span class="who">${who}</span> — ${escapeHtml(m.text)}</div>`;
  }).join('');
  fid.scrollTop = fid.scrollHeight;
  const me = S.me;
  const targets = S.players.filter(p => !p.watching && p.id !== me.id && p.alive && !p.out);
  $('#killVictim').innerHTML = targets.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  $('#killBtn').disabled = S.league.phase !== 'live' || !me.alive || me.out || me.watching;
  $('#killNote').textContent = S.league.phase !== 'live' ? 'Kill claims unlock when the season goes live (Jan 1, 2027).' : me.watching ? 'Watching members do not hunt.' : !me.alive || me.out ? 'You are out for this season.' : 'Your target confirms or disputes. Stealth keeps your name hidden until confirmation.';
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderMe() {
  const me = S.me;
  $('#myCard').innerHTML = `<div class="card"><div class="big">${me.name}</div>
    <p><span class="badge rank">${me.rank}</span> ${me.xp} XP ${me.nextMin ? `— ${me.nextMin - me.xp} XP to ${me.nextRank}` : '— top rank'}</p>
    <div class="bar"><i style="width:${Math.round(me.progress * 100)}%"></i></div>
    <p class="hint">${me.role}${me.watching ? ' • Watching' : ''} • Season kills: ${me.seasonKills} • Status: ${me.out ? 'OUT' : me.alive ? 'Alive' : 'Dead'}</p></div>`;
  $('#reversePanel').innerHTML = `<h3>Reverse Kill card</h3><p>${me.reverseCard ? '🟠 <b>IN HAND</b> — one per season. Play it within 24 hours of a confirmed kill on you and your killer dies instead.' : '⚫ <b>SPENT</b> for this season.'}</p>`;
}

function renderAdmin() {
  const me = S.me, el = $('#adminPanel');
  if (me.role !== 'Founder' && me.role !== 'Vice') { el.innerHTML = ''; return; }
  const L = S.league;
  const opts = S.players.filter(p => !p.watching).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  el.innerHTML = `<div class="card"><h3>Founder / Vice controls</h3>
    <label>Platform</label><input id="admPlatform" value="${L.platform || ''}" placeholder="Nerf / airsoft / water / foam">
    <label>Class</label><input id="admClass" value="${L.weaponClass || ''}" placeholder="Handguns / Rifles / Snipers / Shotguns / Explosives / Melee">
    <label>Pot ($ per man)</label><input id="admPot" type="number" value="${L.pot || 0}">
    <label>Marked man</label><select id="admMarked"><option value="">— none —</option>${S.players.filter(p => !p.watching).map(p => `<option value="${p.id}" ${L.markedManId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}</select>
    <button class="primary" onclick="saveSettings()">Save season setup</button>
    <hr>
    <label>Record combo event win (+300 XP)</label><div class="row"><select id="admWinPlayer">${opts}</select><button class="primary small" onclick="eventWin()">Record</button></div>
    <label>Manual XP adjust (note required)</label>
    <div class="row"><select id="admAdjPlayer">${opts}</select><input id="admAdjDelta" type="number" placeholder="±XP" style="flex:.5"></div>
    <input id="admAdjNote" placeholder="Why — e.g. correction, Duck of Shame">
    <button class="ghost" onclick="adjustXp()">Apply adjust</button>
    <hr>
    <button class="danger" onclick="closeSeason()">Close season — pay Last Man / Deadliest Man & reset</button>
    <p class="hint">Close asks you to name the Last Man if more than one hunter is still standing (the Reckoning result). Career XP and ranks carry over.</p></div>`;
}
function renderRules() {
  $('#rulesCard').innerHTML = `<h3>The ranks — Marine ladder</h3>
    <table><tr><th>Rank</th><th>Career XP</th></tr>${S.ranks.map(r => `<tr><td>${r.name}</td><td>${r.min}</td></tr>`).join('')}</table>
    <h3>XP</h3><p>Kill +${S.xpTable.KILL} • Stealth kill +${S.xpTable.STEALTH_KILL} • Reverse Kill +${S.xpTable.REVERSE_KILL} • Marked man bonus +${S.xpTable.MARKED_MAN_BONUS} • Last Man +${S.xpTable.LAST_MAN} • Deadliest Man +${S.xpTable.DEADLIEST_MAN} • Event win +${S.xpTable.EVENT_WIN} • Death ${S.xpTable.DEATH}. Dying can demote you — but never below Recruit, and a fresh promotion survives your next death.</p>
    <h3>Core rules</h3><p>One life per season. Stealth kills stay hidden until confirmed. Dead men tell no tales. Reverse Kill: one card per season, 24-hour window, counter-reverse spends both cards, no Reverse at the Reckoning. Safe zones: no hits at work, church, while driving, by entering a home uninvited, or during official events. Public = water/Nerf only. Turning location off mid-season = out.</p>`;
}

// ── actions ──
async function refresh() { try { const d = await api('/api/state'); S = d; render(); } catch (e) { /* session may be gone */ } }
let loopsStarted = false;
function startLoops() {
  if (loopsStarted) return; loopsStarted = true;
  setInterval(refresh, 15000);
  setInterval(() => { if (S) render(); }, 60000); // countdown tick
}
async function killAct(id, act) {
  try { const d = await api(`/api/kills/${id}/${act}`, 'POST', {}); S = d.state; render(); toast('Done.'); } catch (e) { toast(e.message); }
}
async function settleKill(id, outcome) {
  try { const d = await api('/api/admin/settle-kill', 'POST', { killId: id, outcome }); S = d.state; render(); toast('Settled.'); } catch (e) { toast(e.message); }
}
async function saveSettings() {
  try { const d = await api('/api/admin/settings', 'POST', { platform: $('#admPlatform').value, weaponClass: $('#admClass').value, pot: Number($('#admPot').value), markedManId: $('#admMarked').value || null }); S = d.state; render(); toast('Season setup saved.'); } catch (e) { toast(e.message); }
}
async function eventWin() {
  try { const d = await api('/api/admin/event-win', 'POST', { playerId: $('#admWinPlayer').value }); S = d.state; render(); toast('+300 XP recorded.'); } catch (e) { toast(e.message); }
}
async function adjustXp() {
  try { const d = await api('/api/admin/adjust-xp', 'POST', { playerId: $('#admAdjPlayer').value, delta: Number($('#admAdjDelta').value), note: $('#admAdjNote').value }); S = d.state; render(); toast('XP adjusted.'); } catch (e) { toast(e.message); }
}
async function closeSeason() {
  const alive = S.players.filter(p => !p.watching && p.alive && !p.out);
  let lastManId = alive.length === 1 ? alive[0].id : '';
  if (!lastManId) {
    const pick = prompt('More than one hunter still stands. Type the Last Man\'s exact name (Reckoning winner):');
    const found = S.players.find(p => p.name.toLowerCase() === String(pick || '').toLowerCase());
    if (!found) { toast('No match — season not closed.'); return; }
    lastManId = found.id;
  }
  if (!confirm('Close the season? Last Man and Deadliest Man get paid, then the board resets (career XP stays).')) return;
  try { const d = await api('/api/admin/close-season', 'POST', { lastManId }); S = d.state; render(); toast('Season closed and reset.'); } catch (e) { toast(e.message); }
}
async function delZone(id) {
  try { const d = await api('/api/safe-zones/' + id, 'DELETE', {}); S = d.state; render(); } catch (e) { toast(e.message); }
}

// geolocation: while sharing is on and the app is open, send fixes
function ensureWatch() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(async pos => {
    lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (S && S.me.sharing) {
      try { const d = await api('/api/position', 'POST', lastPos); S = d.state; render(); } catch (e) { /* silent */ }
    }
  }, () => { }, { enableHighAccuracy: true, maximumAge: 30000 });
}

// ── wire up ──
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.pane').forEach(p => p.hidden = true);
  $('#pane-' + b.dataset.tab).hidden = false;
  if (b.dataset.tab === 'map') setTimeout(() => { if (map) map.invalidateSize(); else drawMap(); }, 80);
}));
$('#claimBtn').addEventListener('click', doClaim);
$('#loginBtn').addEventListener('click', doLogin);
$('#chatSend').addEventListener('click', async () => {
  const text = $('#chatText').value.trim(); if (!text) return;
  try { const d = await api('/api/messages', 'POST', { text }); S = d.state; $('#chatText').value = ''; render(); } catch (e) { toast(e.message); }
});
$('#killBtn').addEventListener('click', async () => {
  try { const d = await api('/api/kills', 'POST', { victimId: $('#killVictim').value, stealth: $('#killStealth').checked }); S = d.state; render(); toast('Kill claimed — waiting on your target.'); } catch (e) { toast(e.message); }
});
$('#shareToggle').addEventListener('change', async e => {
  const on = e.target.checked;
  if (on) ensureWatch();
  try { const d = await api('/api/sharing', 'POST', { on }); S = d.state; render(); if (on && lastPos) { const p = await api('/api/position', 'POST', lastPos); S = p.state; render(); } if (!on && S.me.out) toast('You are OUT — location off mid-season ends your season.'); } catch (err) { toast(err.message); }
});
$('#zoneHereBtn').addEventListener('click', () => {
  if (lastPos) { $('#zoneLat').value = lastPos.lat; $('#zoneLng').value = lastPos.lng; }
  else if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => { $('#zoneLat').value = p.coords.latitude; $('#zoneLng').value = p.coords.longitude; }, () => toast('No location fix yet — allow location or type coordinates.'));
});
$('#zoneAddBtn').addEventListener('click', async () => {
  try { const d = await api('/api/safe-zones', 'POST', { label: $('#zoneLabel').value, lat: Number($('#zoneLat').value), lng: Number($('#zoneLng').value), radius: 150 }); S = d.state; render(); toast('Safe zone saved.'); } catch (e) { toast(e.message); }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST', {}); } catch (e) { }
  localStorage.removeItem('os_token'); location.reload();
});
window.killAct = killAct; window.settleKill = settleKill; window.saveSettings = saveSettings;
window.eventWin = eventWin; window.adjustXp = adjustXp; window.closeSeason = closeSeason; window.delZone = delZone;

(async function boot() {
  await loadRoster();
  if (token) { try { const d = await api('/api/state'); enterApp(d); ensureWatch(); return; } catch (e) { token = ''; localStorage.removeItem('os_token'); } }
})();
