'use strict';
const $ = s => document.querySelector(s);
let S = null; // server state snapshot
let token = localStorage.getItem('os_token') || '';
let myId = localStorage.getItem('os_player') || '';
let map = null, markers = [], watchId = null, lastPos = null, geoErrShown = false;
// Hunt Mode (Round 6): wake lock handle + position-post throttle state.
let wakeLock = null, lastPostAt = 0, lastPostPos = null;

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
// Callsign (when set) is the hunter's public handle; the avatar emoji leads.
function displayName(p) { return p ? (p.callsign || p.name) : 'Unknown'; }
function avatarHtml(p, px = 16) { return p && p.avatar ? `<span class="avatar" style="font-size:${px}px">${p.avatar}</span> ` : ''; }
function immuneLeft(p) {
  if (!p.immuneUntil) return '';
  const ms = Date.parse(p.immuneUntil) - Date.now();
  if (ms <= 0) return '';
  const h = Math.floor(ms / 36e5), m = Math.floor(ms / 6e4) % 60;
  return `🛡 ${h}h ${String(m).padStart(2, '0')}m`;
}
function daysText(p) {
  if (p.daysSurvived == null) return '';
  return p.alive && !p.out ? ` • 🗓 day ${p.daysSurvived}` : ` • 🗓 survived ${p.daysSurvived}d`;
}
function fmtTime(ts) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function playerOf(id) { return S ? S.players.find(x => x.id === id) : null; }

// ── rank insignia (inline SVG, actual USMC enlisted structure, orange on black) ──
function rankSpec(rankName) { const r = S && S.ranks.find(x => x.name === rankName); return r ? r.insignia : { chev: 0, rock: 0, emblem: 'empty' }; }
function insigniaSvg(rankName, px = 26) {
  const spec = rankSpec(rankName) || {};
  const O = '#f96d00';
  if (spec.emblem === 'empty') {
    return `<svg class="insignia" width="${px}" height="${px * 1.3}" viewBox="0 0 64 84" aria-label="${rankName} insignia"><rect x="8" y="6" width="48" height="72" rx="12" fill="#0d0d0d" stroke="${O}" stroke-width="3"/></svg>`;
  }
  if (spec.emblem === 'tags') {
    return `<svg class="insignia" width="${px}" height="${px}" viewBox="0 0 64 64" aria-label="${rankName} insignia"><path d="M14 12 Q32 24 50 12" fill="none" stroke="${O}" stroke-width="1.8"/><g transform="rotate(-14 26 42)"><rect x="19" y="28" width="14" height="25" rx="6.5" fill="${O}"/><circle cx="26" cy="33.5" r="1.9" fill="#0a0a0a"/></g><g transform="rotate(13 40 44)"><rect x="33" y="30" width="14" height="25" rx="6.5" fill="${O}" opacity="0.8"/><circle cx="40" cy="35.5" r="1.9" fill="#0a0a0a"/></g></svg>`;
  }
  const chev = spec.chev || 0, rock = spec.rock || 0;
  let parts = '';
  for (let i = 0; i < chev; i++) {
    const y = 6 + i * 11;
    const d = `M15 ${y + 10} L32 ${y} L49 ${y + 10} L49 ${y + 15.5} L32 ${y + 5.5} L15 ${y + 15.5} Z`;
    parts += spec.hollow ? `<path d="${d}" fill="none" stroke="${O}" stroke-width="2.2"/>` : `<path d="${d}" fill="${O}"/>`;
  }
  const emblemCy = chev ? (6 + chev * 11 + 12) : 20;
  if (spec.emblem === 'rifles') {
    for (const a of [-38, 38]) parts += `<g transform="rotate(${a} 32 ${emblemCy})" fill="${O}"><rect x="30.9" y="${emblemCy - 13}" width="2.2" height="26" rx="1.1"/><rect x="30.3" y="${emblemCy + 7}" width="3.4" height="5.5" rx="1.2"/></g>`;
  } else if (spec.emblem === 'diamond') {
    parts += `<path d="M32 ${emblemCy - 8} L40 ${emblemCy} L32 ${emblemCy + 8} L24 ${emblemCy} Z" fill="${O}"/>`;
  } else if (spec.emblem === 'bomb') {
    parts += `<circle cx="32" cy="${emblemCy + 2}" r="6" fill="${O}"/><path d="M32 ${emblemCy - 4} Q35 ${emblemCy - 9} 39 ${emblemCy - 10}" fill="none" stroke="${O}" stroke-width="2"/><g stroke="${O}" stroke-width="1.8"><path d="M41 ${emblemCy - 12} L44 ${emblemCy - 15}"/><path d="M37 ${emblemCy - 13} L38 ${emblemCy - 17}"/><path d="M44 ${emblemCy - 8} L48 ${emblemCy - 10}"/></g>`;
  } else if (spec.emblem === 'star') {
    let pts = '';
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 3.8 : 9.5, a = Math.PI / 5 * i - Math.PI / 2; pts += `${(32 + r * Math.cos(a)).toFixed(1)},${(emblemCy + r * Math.sin(a)).toFixed(1)} `; }
    parts += `<polygon points="${pts}" fill="${O}"/>`;
  }
  const rockTop = emblemCy + 13;
  for (let j = 0; j < rock; j++) {
    const y = rockTop + j * 6.5;
    parts += `<path d="M16 ${y} Q32 ${y - 7} 48 ${y} L48 ${y + 4.6} Q32 ${y - 2.4} 16 ${y + 4.6} Z" fill="${O}"/>`;
  }
  const h = rock ? rockTop + rock * 6.5 + 6 : emblemCy + 16;
  return `<svg class="insignia" width="${px}" height="${Math.round(px * h / 64)}" viewBox="0 0 64 ${h}" aria-label="${rankName} insignia">${parts}</svg>`;
}
function rankChip(p, px = 15) { return `<span class="badge rank chip">${insigniaSvg(p.rank, px)} ${p.rank}</span>`; }
function haversineMi(aLat, aLng, bLat, bLng) {
  const R = 3959, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function pinAge(ts) {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (sec < 60) return { text: 'just now', stale: false };
  if (sec < 3600) return { text: `${Math.floor(sec / 60)}m ago`, stale: sec > 600 };
  return { text: `${Math.floor(sec / 3600)}h ago`, stale: true };
}

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
  $('#scrimmageBanner').hidden = !L.scrimmage;
  const hb = $('#huntBanner');
  if (me.huntingOn) { hb.hidden = false; hb.textContent = `🔴 YOU'RE LIVE — HUNT MODE${huntElapsedText()}`; } else hb.hidden = true;
  renderCheck();
  $('#meBar').innerHTML = `<b>${avatarHtml(me, 18)}${escapeHtml(displayName(me))}</b> — <span class="tappable" onclick="openRanks()" title="See all ranks">${rankChip(me)}</span> ${me.xp} XP` +
    (me.nextMin ? `<div class="bar"><i style="width:${Math.round(me.progress * 100)}%"></i></div><span class="hint">${me.nextMin - me.xp} XP to ${me.nextRank}</span>` : ' — top of the ladder') +
    ` • ${me.watching ? 'Watching' : me.out ? 'OUT' : me.alive ? 'Alive' : 'Dead'} • ${me.seasonKills} kills${me.huntingOn ? ` • <span class="hunting-badge">🎯 HUNTING</span>` : ''}${immuneLeft(me) ? ` • <span class="shield">${immuneLeft(me)} immune</span>` : ''}${me.atSafeZone ? ` • 🛡 Safe zone — ${me.atSafeZone}` : me.driving ? ' • 🚗 Driving' : ''}`;
  renderMap(); renderBoard(); renderChat(); renderMe(); renderAdmin(); renderRules();
  maybeWalkthrough();
}

function renderMap() {
  const me = S.me;
  $('#shareToggle').checked = !!me.sharing;
  $('#shareNote').textContent = me.atSafeZone ? `You are at a safe zone (${me.atSafeZone}) — your pin is hidden, and the league has been told you're at a safe zone. The zone's location is never shown.` :
    me.inSafeZone ? 'You are inside one of your safe zones — your pin is hidden.' :
    me.driving ? 'Driving mode — your pin is hidden and the league sees 🚗 Driving. It clears on its own when you stop. (Detection only runs while the app is open.)' :
    me.sharing ? 'Sharing is ON. Your pin shows to the league while the app is open. Turning it off mid-season puts you OUT.' :
    'Sharing is off. Only you can see you.';
  // hunter list — distance + pin freshness only for visible positions
  $('#hunterList').innerHTML = S.players.filter(p => p.claimed || p.position).map(p => {
    let right, stale = false;
    if (p.atSafeZone) right = `🛡 At a safe zone — ${p.atSafeZone}`;
    else if (p.driving) right = '🚗 Driving';
    else if (p.position) {
      const age = pinAge(p.position.ts); stale = age.stale;
      const bits = [`📍 ${age.text}${stale ? ' — ⚠ stale' : ''}`];
      if (lastPos && p.id !== me.id) bits.unshift(`${haversineMi(lastPos.lat, lastPos.lng, p.position.lat, p.position.lng).toFixed(1)} mi`);
      right = bits.join(' • ');
    } else right = p.inSafeZone && p.id === me.id ? 'safe zone' : p.sharing ? 'sharing — no fix yet' : 'not sharing';
    const imm = immuneLeft(p);
    return `<div class="hunter tappable${stale ? ' stale' : ''}" onclick="openProfile('${p.id}')"><span>${insigniaSvg(p.rank, 16)} <b>${avatarHtml(p)}${escapeHtml(displayName(p))}</b>${p.hunting ? ` <span class="hunting-badge">🎯 HUNTING</span>` : ''}${p.bountyTotal ? ` <span class="bounty-badge">💰 ${p.bountyTotal}</span>` : ''}${imm ? ` <span class="shield">${imm}</span>` : ''} <span class="sub">${p.rank} • ${p.alive && !p.out ? 'alive' : 'out'}${daysText(p)}</span></span><span class="sub">${right}</span></div>`;
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
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    }
    markers.forEach(m => map.removeLayer(m)); markers = [];
    const zoneLayer = (S.me.safeZones || []).forEach(z => markers.push(L.circle([z.lat, z.lng], { radius: z.radius, color: '#f96d00', fillColor: '#f96d00', fillOpacity: 0.1 }).addTo(map)));
    pins.forEach(p => {
      const icon = L.divIcon({ className: '', html: `<div class="pin${p.hunting ? ' hunting' : ''}">${p.avatar || initials(p.name)}</div>`, iconSize: [30, 30] });
      markers.push(L.marker([p.position.lat, p.position.lng], { icon }).addTo(map).bindPopup(`<b>${escapeHtml(displayName(p))}</b><br>${p.rank} • ${p.seasonKills} kills${p.hunting ? '<br>🎯 Hunting now' : ''}${immuneLeft(p) ? '<br>🛡 Immune ' + immuneLeft(p) : ''}`));
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
      pins.map(p => `<div class="pin${p.hunting ? ' hunting' : ''}" style="left:${px(p.position.lng, minLn, maxLn)}%;top:${100 - px(p.position.lat, minLa, maxLa)}%" title="${escapeHtml(displayName(p))}">${p.avatar || initials(p.name)}</div>`).join('');
  }
}

function renderBoard() {
  const L = S.league;
  const hunters = S.players.filter(p => !p.watching);
  const killsOf = p => L.scrimmage ? (p.scrimmageKills || 0) : p.seasonKills;
  const row = p => `<tr class="tappable" onclick="openProfile('${p.id}')"><td>${insigniaSvg(p.rank, 18)} <b>${avatarHtml(p, 17)}${escapeHtml(displayName(p))}</b>${L.markedManId === p.id ? ' 🎯' : ''}${p.hunting ? ` <span class="hunting-badge">🎯 HUNTING</span>` : ''}${p.bountyTotal ? ` <span class="bounty-badge">💰 ${p.bountyTotal} XP</span>` : ''}${immuneLeft(p) ? ` <span class="shield">${immuneLeft(p)}</span>` : ''}<br><span class="hint">${p.rank} • ${p.xp} XP${daysText(p)}${p.atSafeZone ? ` • 🛡 Safe zone — ${p.atSafeZone}` : p.driving ? ' • 🚗 Driving' : ''}</span></td><td>${killsOf(p)}</td><td><span class="badge ${p.out || !p.alive ? 'dead' : 'alive'}">${p.out ? 'OUT' : p.alive ? 'ALIVE' : 'DEAD'}</span></td></tr>`;
  $('#huntBoard').innerHTML = `<table><tr><th>Hunter</th><th>${L.scrimmage ? 'Practice kills' : 'Kills'}</th><th>Status</th></tr>${hunters.filter(p => p.alive && !p.out).map(row).join('')}${hunters.filter(p => !p.alive || p.out).map(row).join('')}</table>`;
  const career = [...S.players].sort((a, b) => b.xp - a.xp);
  $('#careerBoard').innerHTML = `<table><tr><th>#</th><th>Hunter</th><th>Rank</th><th>XP</th></tr>${career.map((p, i) => `<tr class="tappable" onclick="openProfile('${p.id}')"><td>${i + 1}</td><td>${insigniaSvg(p.rank, 16)} ${avatarHtml(p)}${escapeHtml(displayName(p))}${p.watching ? ' <span class="hint">(watching)</span>' : ''}</td><td>${rankChip(p)}</td><td>${p.xp}</td></tr>`).join('')}</table>`;
  // bounty board
  $('#bountyBoard').innerHTML = S.bounties.length ? `<table><tr><th>Target</th><th>Bounty</th><th>Placed by</th></tr>${S.bounties.map(b => { const t = playerOf(b.targetId); return `<tr class="tappable" onclick="openProfile('${b.targetId}')"><td>${t ? insigniaSvg(t.rank, 16) : ''} <b>${b.targetName}</b>${b.note ? `<br><span class="hint">${escapeHtml(b.note)}</span>` : ''}</td><td><span class="bounty-badge">💰 ${b.amount} XP</span></td><td>${b.placedByName}</td></tr>`; }).join('')}</table><p class="hint">Bounties stack. Whoever confirms the kill on the target collects the whole pile — paid on confirmation, stealth included.</p>`
    : '<p class="hint">No active bounties. The Founder/Vice can put a price on a hunter\'s head from the admin controls.</p>';
  // hall of the fallen
  const arch = [...(S.archive || [])].reverse();
  $('#hallList').innerHTML = arch.length ? arch.map(rec => {
    const sup = rec.superlatives || {};
    const supLine = [
      sup.firstBlood ? `🩸 First Blood: <b>${escapeHtml(sup.firstBlood.name)}</b>` : '',
      sup.sneakiest ? `🥷 Sneakiest: <b>${escapeHtml(sup.sneakiest.name)}</b> (${sup.sneakiest.stealthKills} stealth)` : '',
      sup.mostWanted ? `🎯 Most Wanted: <b>${escapeHtml(sup.mostWanted.name)}</b> (${sup.mostWanted.bountyXp} XP placed on him)` : '',
      sup.duckMagnet ? `🦆 Duck Magnet: <b>${escapeHtml(sup.duckMagnet.name)}</b> (${sup.duckMagnet.ducks} ducks)` : '',
    ].filter(Boolean).join(' • ');
    return `<div class="card"><b>Season ${rec.season}</b> <span class="hint">— closed ${new Date(rec.closedAt).toLocaleDateString()}</span>
    <p>🏆 Last Man: <b>${escapeHtml(rec.lastManName)}</b> • ☠ Deadliest Man: <b>${escapeHtml(rec.deadliestName)}</b> (${rec.deadliestKills} kills)</p>
    ${supLine ? `<p>${supLine}</p>` : ''}
    <table><tr><th>Hunter</th><th>Kills</th><th>Days</th><th>Fate</th></tr>${rec.standings.map(s => `<tr><td>${escapeHtml(s.name)}</td><td>${s.kills}</td><td>${s.daysSurvived != null ? s.daysSurvived : '—'}</td><td>${s.alive ? 'Survived' : 'Fell'}</td></tr>`).join('')}</table></div>`;
  }).join('')
    : '<p class="hint">No seasons in the books yet. Season 1 writes the first page.</p>';
  // action center: things waiting on me
  const me = S.me, acts = [];
  S.kills.filter(k => k.status === 'pending' && k.victimId === me.id).forEach(k => {
    acts.push(`<div class="action"><b>Kill claimed on you</b> by ${k.killerHidden ? 'a stealth hunter' : escapeHtml(displayName(playerOf(k.killerId)))}. Confirm it, or dispute it and let the Founder/Vice settle it.${k.photo ? `<br><img class="proof" src="data:${k.photo.mime};base64,${k.photo.data}" alt="Kill proof">` : ''}<br><button class="danger" onclick="killAct('${k.id}','confirm')">Confirm — I\'m out</button><button class="ghost small" onclick="killAct('${k.id}','dispute')">Dispute</button></div>`);
  });
  S.kills.filter(k => k.status === 'confirmed' && k.victimId === me.id && me.killCancelCard).forEach(k => {
    acts.push(`<div class="action"><b>You were killed by ${escapeHtml(displayName(playerOf(k.killerId)))}.</b> Your Kill Cancel card is live until ${fmtTime(k.cancelExpiresAt)} — void the kill, nobody dies, and you're immune for 24 hours.<br><button class="primary small" onclick="killAct('${k.id}','cancel')">🛡 Play Kill Cancel</button></div>`);
  });
  S.kills.filter(k => k.status === 'canceled' && k.killerId === me.id && me.killCancelCard).forEach(k => {
    acts.push(`<div class="action"><b>Your kill was CANCELED by ${escapeHtml(displayName(playerOf(k.victimId)))}.</b> Burn your own Kill Cancel by ${fmtTime(k.counterExpiresAt)} to override — the kill stands and both cards are gone.<br><button class="primary small" onclick="killAct('${k.id}','counter-cancel')">🔥 Override — kill stands</button></div>`);
  });
  if (me.role === 'Founder' || me.role === 'Vice') {
    S.kills.filter(k => k.status === 'disputed' && k.killerId !== me.id && k.victimId !== me.id).forEach(k => {
      acts.push(`<div class="action"><b>Disputed kill:</b> ${escapeHtml(displayName(playerOf(k.killerId)))} → ${escapeHtml(displayName(playerOf(k.victimId)))}. You settle it.${k.photo ? `<br><img class="proof" src="data:${k.photo.mime};base64,${k.photo.data}" alt="Kill proof">` : ''}<br><button class="danger" onclick="settleKill('${k.id}','confirm')">Kill stands</button><button class="ghost small" onclick="settleKill('${k.id}','reject')">Reject claim</button></div>`);
    });
  }
  $('#actionCenter').innerHTML = acts.join('');
}

const BANNER_KINDS = ['kill', 'bounty', 'duck', 'achievement', 'cancel', 'danger', 'safezone', 'driving', 'hunt', 'ping', 'check'];
const REACTS = ['🔥', '🦆', '🏆', '😂'];
function renderChat() {
  const fid = $('#feed');
  fid.innerHTML = S.messages.map(m => {
    const author = m.playerId ? playerOf(m.playerId) : null;
    const who = author ? `${insigniaSvg(author.rank, 13)} ${avatarHtml(author, 13)}${escapeHtml(displayName(author))}` : 'OPEN SEASON';
    const banner = BANNER_KINDS.includes(m.kind) ? ' banner' : '';
    const kill = m.killId ? S.kills.find(k => k.id === m.killId) : null;
    const photo = kill && kill.photo ? `<br><img class="proof" src="data:${kill.photo.mime};base64,${kill.photo.data}" alt="Kill proof">` : '';
    const reacts = `<div class="reacts">${REACTS.map(e => {
      const ids = (m.reactions && m.reactions[e]) || [];
      return `<button class="react${ids.includes(S.me.id) ? ' mine' : ''}" onclick="reactTo('${m.id}','${e}')">${e}${ids.length ? ' ' + ids.length : ''}</button>`;
    }).join('')}</div>`;
    return `<div class="msg ${m.kind}${banner}"><span class="when">${fmtTime(m.ts)}</span><span class="who">${who}</span> — ${escapeHtml(m.text)}${photo}${reacts}</div>`;
  }).join('');
  fid.scrollTop = fid.scrollHeight;
  const me = S.me, L = S.league, open = L.phase === 'live' || L.scrimmage;
  const targets = S.players.filter(p => !p.watching && p.id !== me.id && p.alive && !p.out && !p.immuneUntil && !p.driving);
  $('#killVictim').innerHTML = targets.map(p => `<option value="${p.id}">${escapeHtml(displayName(p))}</option>`).join('');
  $('#killBtn').disabled = !open || !me.alive || me.out || me.watching;
  $('#killNote').textContent = L.scrimmage ? '🏋 SCRIMMAGE is on — claims are open for practice. Nothing counts: no XP, no real outs.' : L.phase !== 'live' ? 'Kill claims unlock when the season goes live (Jan 1, 2027).' : me.watching ? 'Watching members do not hunt.' : !me.alive || me.out ? 'You are out for this season.' : 'Your target confirms or disputes. Stealth keeps your name hidden until confirmation. Immune hunters (🛡) and driving hunters (🚗) can\'t be claimed on.';
}
async function reactTo(id, emoji) {
  try { const d = await api(`/api/messages/${id}/react`, 'POST', { emoji }); S = d.state; render(); } catch (e) { toast(e.message); }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── profiles ──
function careerKillsOf(p) { const s = p.stats || {}; return (s.kills || 0) + (s.stealthKills || 0); }
function killHistoryHtml(p) {
  const mine = S.kills.filter(k => (k.killerId === p.id || k.victimId === p.id) && ['confirmed', 'overridden', 'canceled'].includes(k.status));
  if (!mine.length) return '';
  const label = k => {
    const other = k.killerId === p.id ? playerOf(k.victimId) : playerOf(k.killerId);
    const what = k.status === 'canceled' ? 'CANCELED — counts for nothing' : k.status === 'overridden' ? 'stood after override' : 'confirmed';
    return `${k.killerId === p.id ? '☠ Took out' : '💀 Taken out by'} ${escapeHtml(displayName(other))}${k.stealth ? ' (stealth)' : ''} — ${what}`;
  };
  return `<h3>Kill history</h3>${mine.map(k => `<div class="killhist"><span>${label(k)}</span>${k.photo ? `<br><img class="proof" src="data:${k.photo.mime};base64,${k.photo.data}" alt="Kill proof">` : ''}</div>`).join('')}`;
}
function profileHtml(p) {
  const s = p.stats || {};
  const status = p.watching ? 'Watching' : p.out ? 'OUT' : p.alive ? 'Alive' : 'Dead';
  const stat = (label, val) => `<div class="stat"><b>${val}</b><span>${label}</span></div>`;
  return `<div class="card">
    <div class="profile-head">${insigniaSvg(p.rank, 76)}
      <div><div class="big">${p.avatar ? p.avatar + ' ' : ''}${escapeHtml(displayName(p))}</div>
      ${p.callsign ? `<p class="hint">${escapeHtml(p.name)}</p>` : ''}
      <p>${rankChip(p, 17)} ${p.xp} XP</p>
      <p class="hint">${p.role}${S.league.markedManId === p.id ? ' • 🎯 MARKED MAN' : ''} • ${status} • Season kills: ${p.seasonKills}${S.league.scrimmage ? ` • Practice kills: ${p.scrimmageKills || 0}` : ''}${p.daysSurvived != null ? ` • ${p.alive && !p.out ? 'on day ' + p.daysSurvived + ' and counting' : 'survived ' + p.daysSurvived + ' days'}` : ''}</p>
      ${immuneLeft(p) ? `<p><span class="shield">🛡 IMMUNE — ${immuneLeft(p)} left</span></p>` : ''}
      ${p.hunting ? `<p><span class="hunting-badge">🎯 HUNTING</span> <span class="hint">out there now — live pin</span></p>` : ''}
      ${p.atSafeZone ? `<p>🛡 At a safe zone — ${p.atSafeZone} <span class="hint">(pin hidden — the zone's location is never shown)</span></p>` : ''}
      ${!p.atSafeZone && p.driving ? `<p>🚗 Driving <span class="hint">(pin hidden until they stop)</span></p>` : ''}
      ${p.bountyTotal ? `<p><span class="bounty-badge">💰 ${p.bountyTotal} XP bounty on this hunter</span></p>` : ''}
      </div></div>
    <div class="bar"><i style="width:${Math.round(p.progress * 100)}%"></i></div>
    <p class="hint">${p.nextMin ? `${p.nextMin - p.xp} XP to ${p.nextRank}` : 'Top of the ladder — Sergeant Major.'}</p>
    <div class="statgrid">
      ${stat('Career kills', careerKillsOf(p))}${stat('Stealth kills', s.stealthKills || 0)}${stat('Kill Cancels', s.killCancels || 0)}
      ${stat('Overrides', s.overrides || 0)}${stat('Deaths', s.deaths || 0)}${stat('Marked-man kills', s.markedManKills || 0)}
      ${stat('Event wins', s.eventWins || 0)}${stat('Bounties collected', s.bountyCollections || 0)}${stat('Ducks of Shame', s.ducks || 0)}
    </div>
    ${killHistoryHtml(p)}
    <h3>Achievements — ${(p.achievements || []).filter(a => a.earned).length}/${(p.achievements || []).length}</h3>
    <div class="achvgrid">${(p.achievements || []).map(a => `<div class="achv ${a.earned ? 'earned' : 'locked'}"><b>${a.earned ? '🏅' : '🔒'} ${a.name}</b><span>${a.desc}</span></div>`).join('')}</div>
  </div>`;
}
function openProfile(id) {
  const p = playerOf(id); if (!p) return;
  $('#overlayBody').innerHTML = profileHtml(p);
  $('#overlay').hidden = false;
}
function openRanks() {
  const me = S.me;
  $('#overlayBody').innerHTML = `<h3>The ladder — tap outside to close</h3>` + S.ranks.map(r => {
    const mine = r.name === me.rank;
    const next = r.min > me.xp ? ` — <span class="hint">${r.min - me.xp} XP to go</span>` : '';
    return `<div class="rankrow${mine ? ' mine' : ''}">${insigniaSvg(r.name, 30)}<div><b>${r.name}</b> <span class="hint">${r.min} XP</span>${mine ? ' <span class="bounty-badge">YOU</span>' : next}<br><span class="hint">${r.desc || ''}</span></div></div>`;
  }).join('');
  $('#overlay').hidden = false;
}
function closeOverlay() { $('#overlay').hidden = true; }

// ── setup checklist (informational only, never blocks play) ──
function renderChecklist() {
  const me = S.me;
  const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const items = [
    { done: true, label: 'Spot claimed', hint: '' },
    { done: installed, label: 'App on your Home Screen', hint: 'iPhone: Safari → Share → Add to Home Screen. Android: Chrome ⋮ → Add to Home screen.' },
    { done: (me.safeZones || []).length > 0, label: 'Safe zone set', hint: 'Add home/work/church on the Map tab — your pin hides there.' },
    { done: !!me.sharing, label: 'Location sharing ON', hint: 'Flip it on the Map tab so the league can see your pin.' },
  ];
  $('#setupChecklist').innerHTML = items.every(i => i.done)
    ? '<div class="card slim-ok">✅ All set — good hunting.</div>'
    : `<div class="card"><h3>Setup checklist</h3>${items.map(i => `<p class="check-item">${i.done ? '☑' : '☐'} <b>${i.label}</b>${!i.done && i.hint ? `<br><span class="hint">${i.hint}</span>` : ''}</p>`).join('')}</div>`;
}

// ── push alerts ──
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
function renderAlerts() {
  const on = localStorage.getItem('os_alerts') === '1';
  $('#alertsCard').innerHTML = `<h3>Kill alerts (push)</h3>
    <p class="hint">Get buzzed when a kill is claimed on you, your kill is confirmed or CANCELED, a cancel gets overridden, a hunter gets within a mile of you, you're marked, or a bounty goes on your head. <b>iPhone:</b> alerts only work once the app is added to the Home Screen.</p>
    <div class="row between"><span>Alerts</span><label class="switch"><input type="checkbox" id="alertsToggle" ${on ? 'checked' : ''} onchange="toggleAlerts(this.checked)"><span class="track"></span></label></div>
    <button class="ghost" onclick="testPush()">Send test push</button>
    <p class="hint">Sends one test notification to this device only — the quickest way to prove your phone is set up.</p>`;
}
async function testPush() {
  try {
    const r = await api('/api/push/test', 'POST', {});
    toast(`Test push sent — ${r.accepted} of ${r.targeted} subscription${r.targeted === 1 ? '' : 's'} accepted. Check your notifications.`);
  } catch (e) { toast(e.message); }
}
async function toggleAlerts(on) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push alerts');
    const reg = await navigator.serviceWorker.ready;
    if (on) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications are blocked for this app');
      const { publicKey } = await api('/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
      await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
      localStorage.setItem('os_alerts', '1');
      toast('Alerts on. The hunt will find you.');
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      else await api('/api/push/unsubscribe', 'POST', {});
      localStorage.removeItem('os_alerts');
      toast('Alerts off.');
    }
  } catch (e) { toast(e.message); }
  renderAlerts();
}

const AVATAR_CHOICES = ['🎯', '💀', '🔥', '🐺', '🦅', '🦊', '🐗', '🦈', '🐍', '🦂', '👻', '🎃', '🤠', '🥷', '😈', '👑', '⚡', '🏹', '🔪', '🚀', '🌪️', '🐲', '🦸', '🧨'];
// ── Hunt Mode card (My Card, Round 6) ──
function renderHunt() {
  const me = S.me, el = $('#huntCard');
  if (!el) return;
  if (me.watching || me.out || !me.alive) { el.innerHTML = ''; releaseWakeLock(); return; }
  const on = !!me.huntingOn;
  // Keep the wake lock in step with the persisted state (e.g. after a
  // reload mid-hunt, or a state refresh that shows the hunt has ended).
  if (on) acquireWakeLock(); else releaseWakeLock();
  el.innerHTML = `<div class="card hunt-card${on ? ' on' : ''}"><div class="row between"><span><b>🎯 HUNT MODE</b><br><span class="hint">${on ? `You're broadcasting — screen awake, GPS hot${huntElapsedText()}.` : 'Heading out? Flip this on: sharing turns on with it, your screen stays awake, your GPS stays hot, and the league gets one anonymous ⚠️ "someone\'s hunting" push.'}</span></span><label class="switch"><input type="checkbox" id="huntToggle" ${on ? 'checked' : ''} onchange="toggleHuntMode(this.checked)"><span class="track"></span></label></div>
  ${on ? '<p class="hint">Hunt Mode keeps the screen on and GPS hot, so it eats battery. It only runs while the app is open on screen — close it and your pin quietly goes stale.</p>' : ''}</div>`;
}
function renderMe() {
  const me = S.me;
  renderHunt();
  renderPing();
  renderChecklist();
  $('#myCard').innerHTML = backupReminderHtml() + profileHtml(me);
  $('#cancelPanel').innerHTML = `<h3>Kill Cancel card</h3><p>${me.killCancelCard ? '🟠 <b>IN HAND</b> — one per season. Play it within 24 hours of a confirmed kill on you: the kill is VOIDED, nobody dies, and you\'re IMMUNE for 24 hours. The killer can burn his own card to override you.' : '⚫ <b>SPENT</b> for this season.'}</p>${immuneLeft(me) ? `<p><span class="shield">🛡 Shield up — ${immuneLeft(me)} of immunity left. No kill claim can land on you.</span></p>` : ''}
    <hr>
    <h3>Your hunter identity</h3>
    <label>Callsign (16 characters max)</label>
    <div class="row"><input id="myCallsign" maxlength="16" placeholder="e.g. Viper" value="${me.callsign ? escapeHtml(me.callsign) : ''}"><button class="primary small" onclick="saveProfile()">Save</button></div>
    <label>Avatar emoji — shows on your pin, the board, and chat</label>
    <div class="emoji-grid">${AVATAR_CHOICES.map(e => `<button class="emoji-pick${me.avatar === e ? ' mine' : ''}" onclick="pickAvatar('${e}')">${e}</button>`).join('')}${me.avatar ? `<button class="emoji-pick" onclick="pickAvatar('')">✕</button>` : ''}</div>
    <hr>
    <h3>Invite the Boyz</h3>
    <p class="hint">One tap copies the join message — paste it into the group chat.</p>
    <button class="ghost" onclick="copyInvite()">📋 Copy invite message</button>`;
  renderAlerts();
}
async function saveProfile() {
  try { const d = await api('/api/profile', 'POST', { callsign: $('#myCallsign').value }); S = d.state; render(); toast('Callsign saved.'); } catch (e) { toast(e.message); }
}
async function pickAvatar(emoji) {
  try { const d = await api('/api/profile', 'POST', { avatar: emoji }); S = d.state; render(); toast(emoji ? 'Avatar set.' : 'Avatar cleared.'); } catch (e) { toast(e.message); }
}
const INVITE_TEXT = `🟠 OPEN SEASON — the Da Boyz hunt app is LIVE: https://open-season.onrender.com
League code: BOYZ-2027
1) Open the link
2) Add it to your Home Screen — iPhone: Safari → Share → Add to Home Screen • Android: Chrome ⋮ → Add to Home screen
3) Claim your spot with the league code and set your PIN
Season 1 starts January 1, 2027. Set your safe zones, turn sharing on, and carry your Kill Cancel card. Good hunting.`;
async function copyInvite() {
  try { await navigator.clipboard.writeText(INVITE_TEXT); toast('Invite copied — paste it in the group chat.'); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = INVITE_TEXT; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Invite copied — paste it in the group chat.'); } catch (_) { toast('Copy failed — the invite text is in the Rules tab.'); }
    ta.remove();
  }
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
    <label>Duck of Shame (−50 XP)</label><div class="row"><select id="admDuckPlayer">${opts}</select><button class="danger small" onclick="duckAward()">Award the Duck 🦆</button></div>
    <label>Callsign reset (clear a hunter's callsign)</label><div class="row"><select id="admCsPlayer">${S.players.map(p => `<option value="${p.id}">${p.name}${p.callsign ? ' — "' + escapeHtml(p.callsign) + '"' : ''}</option>`).join('')}</select><button class="ghost small" onclick="callsignReset()">Clear callsign</button></div>
    <label>Place a bounty (25–500 XP, stacks)</label>
    <div class="row"><select id="admBountyTarget">${opts}</select><input id="admBountyAmt" type="number" min="25" max="500" placeholder="XP" style="flex:.5"></div>
    <input id="admBountyNote" placeholder="Note (optional) — e.g. he knows what he did">
    <button class="ghost" onclick="bountyPlace()">Place bounty 💰</button>
    ${S.bounties.length ? `<div>${S.bounties.map(b => `<div class="hunter"><span>💰 ${b.amount} XP on <b>${b.targetName}</b> <span class="sub">by ${b.placedByName}</span></span><button class="ghost small" onclick="bountyRemove('${b.id}')">Remove</button></div>`).join('')}</div>` : ''}
    <hr>
    <button class="${L.scrimmage ? 'danger' : 'primary'}" onclick="scrimmageToggle()">${L.scrimmage ? 'End scrimmage — reset practice board' : 'Start scrimmage (practice season)'}</button>
    <p class="hint">Scrimmage unlocks kill claims during setup. Everything resolves, but no XP, no ledger, no real outs. Ending it resets the practice board clean.</p>
    <hr>
    <button class="danger" onclick="closeSeason()">Close season — pay Last Man / Deadliest Man & reset</button>
    <p class="hint">Close asks you to name the Last Man if more than one hunter is still standing (the Reckoning result). Career XP and ranks carry over.</p>
    <hr>
    <h3>📍 Location Check</h3>
    ${S.checkCall ? `<p class="hint">A check is <b>RUNNING</b> — called by ${escapeHtml(S.checkCall.startedByName)}, deadline ${fmtTime(S.checkCall.deadlineAt)}. ${S.checkCall.targets.filter(t => t.checkedIn).length}/${S.checkCall.targets.length} checked in so far. Calling it off ends it with no eliminations, ever.</p>
    <button class="danger" onclick="checkCallCancel()">Call off the location check</button>`
    : `<label>Remind stragglers every (minutes, 5–120)</label><input id="admCheckInterval" type="number" min="5" max="120" value="${S.checkSettings ? S.checkSettings.intervalMin : 15}">
    <label>Deadline to check in (minutes, 15–480)</label><input id="admCheckDeadline" type="number" min="15" max="480" value="${S.checkSettings ? S.checkSettings.deadlineMin : 60}">
    <button class="ghost" onclick="checkSettingsSave()">Save check settings</button>
    <button class="primary" onclick="checkCallStart()">📍 Call a LOCATION CHECK</button>
    <p class="hint">Live season: every alive hunter with sharing ON is a target — post any fresh fix before the deadline (the app being open does it; safe-zone and driving fixes count) or he's OUT, with no XP change. Scrimmage: everybody in is a target and nobody can go out — it just names who would have. Settings lock in when the call starts; editing them mid-call never alters a running call.</p>`}
    <hr>
    <h3>League backup</h3>
    ${backupReminderHtml()}
    <p class="hint">Free hosting can wipe this app's storage without warning. A backup is the whole league — claims, PINs, XP, ledger, chat, kills, bounties, archives, push keys — in one file. Download one before risky changes and after big season moments, and keep it somewhere safe (Files, iCloud, email it to yourself).</p>
    <p class="hint">Last backup: ${S.backup && S.backup.lastBackupAt ? fmtTime(S.backup.lastBackupAt) : 'never'}${S.backup && S.backup.stale ? ' — <b>stale</b>' : ''}</p>
    <button class="ghost" onclick="backupDownload()">⬇ Download backup</button>
    <label>Restore from a backup file</label>
    <input type="file" id="admRestoreFile" accept="application/json,.json" hidden onchange="restorePicked(this)">
    <button class="danger" onclick="document.getElementById('admRestoreFile').click()">⬆ Restore from backup</button>
    <p class="hint">Restoring REPLACES the entire current league with the backup — there is no undo. Download a backup of the current league first if you might want it back.</p></div>`;
}
function renderRules() {
  const myAch = S.me.achievements || [];
  $('#rulesCard').innerHTML = `<h3>How the Kill Cancel works — watch it</h3>
    <video class="tutorial" controls playsinline preload="none" poster="/kill-cancel-tutorial.png" src="/kill-cancel-tutorial.mp4"></video>
    <p class="hint">Tag → Kill Cancel voids it (shield up, immune 24h) → the killer can burn his own card to OVERRIDE. <a href="/kill-cancel-tutorial.png" target="_blank" rel="noopener">Open the poster version</a>.</p>
    <button class="ghost" onclick="showWalkthrough()">↻ Replay the quick-start walkthrough</button>
    <h3>The ranks — Marine ladder <span class="hint">(tap yours in the header for the full list)</span></h3>
    <table><tr><th></th><th>Rank</th><th>Career XP</th></tr>${S.ranks.map(r => `<tr class="tappable" onclick="openRanks()"><td>${insigniaSvg(r.name, 20)}</td><td>${r.name}</td><td>${r.min}</td></tr>`).join('')}</table>
    <h3>XP</h3><p>Kill +${S.xpTable.KILL} • Stealth kill +${S.xpTable.STEALTH_KILL} • Marked man bonus +${S.xpTable.MARKED_MAN_BONUS} • Last Man +${S.xpTable.LAST_MAN} • Deadliest Man +${S.xpTable.DEADLIEST_MAN} • Event win +${S.xpTable.EVENT_WIN} • Death ${S.xpTable.DEATH} • Duck of Shame ${S.xpTable.DUCK_OF_SHAME}. Dying can demote you — but never below Recruit, and a fresh promotion survives your next death.</p>
    <p>Bounties: the Founder/Vice can put 25–500 XP on a hunter's head (they stack). Whoever confirms the kill on him collects the whole pile as bonus XP — paid on confirmation, stealth kills included. If that kill is later canceled, the bounty comes back off the killer and returns to the board.</p>
    <h3>Achievements <span class="hint">(+${S.xpTable.ACHIEVEMENT} XP each, paid once at first unlock)</span></h3>
    <div class="achvgrid">${(S.achievementDefs || []).map(d => { const mine = myAch.find(a => a.id === d.id); const earned = mine && mine.earned; return `<div class="achv ${earned ? 'earned' : 'locked'}"><b>${earned ? '🏅' : '🔒'} ${d.name}</b><span>${d.desc}</span></div>`; }).join('')}</div>
    <h3>Core rules</h3><p>One life per season. Stealth kills stay hidden until confirmed. Dead men tell no tales. <b>Kill Cancel:</b> one card per player per season. Play it within 24 hours of a confirmed kill on you and the kill is VOIDED — nobody dies, the kill counts for nothing, and you're IMMUNE to every claim for 24 hours. The killer can burn his own Kill Cancel to override: the kill stands and both cards are gone. No Kill Cancel at the Reckoning. Safe zones: no hits at work, church, while driving, by entering a home uninvited, or during official events. Inside a safe zone your pin hides and the league sees 🛡 At a safe zone — the label only, never the location. While the app is open, sustained speed over ~20 mph switches you to 🚗 Driving: pin hidden, no claims land, until you stop — and driving never puts you out; only turning sharing off does. Public = water/Nerf only. Turning location off mid-season = out. Scrimmage (December practice) never counts.</p>
    <p><b>🎯 Hunt Mode:</b> flip it on from My Card when you head out. It turns sharing on with it, keeps your screen awake and your GPS hot while the app is open, and sends every other hunter ONE anonymous push — "⚠️ Someone's hunting" — no name attached (at most one blast per hunter per 30 minutes; turning it off never blasts). Your 🎯 HUNTING marker only shows while your pin is fresh: close the app and it quietly goes stale — Hunt Mode never puts anyone out. It eats battery, by design: a hot GPS is the whole point.</p>
    <p><b>📍 Pings & Location Checks:</b> any hunter in the game can <b>ping the league</b> from My Card — one named push to every other hunter in the game ("open the app and update your location"), at most once an hour. A <b>Location Check</b> is the Founder/Vice enforcement version: targets (live season: alive hunters with sharing ON; scrimmage: everybody in) get pushed at the call, reminders repeat on the admin-set interval to anyone still missing, and a hunter who hasn't posted a fresh fix by the deadline is <b>OUT</b> — no XP changes hands, because a timeout isn't a kill. Checking in is automatic: having the app open posts fixes, and any fix counts — even one whose pin is hidden in a safe zone or while driving. In scrimmage a check is practice only: at the deadline it just names who WOULD have been out.</p>`;
}

// ── Location Check banner + board (Round 7) ──
// While a call is active EVERY hunter sees the countdown banner and the
// check-in board; your own status rides in the banner. Checking in needs
// no button: having the app open posts a fix, and the fix IS the check-in.
function renderCheck() {
  const cc = S.checkCall, me = S.me;
  const b = $('#checkBanner'), board = $('#checkBoard');
  if (!cc) { b.hidden = true; b.textContent = ''; board.innerHTML = ''; return; }
  const leftMs = Math.max(0, Date.parse(cc.deadlineAt) - Date.now());
  const mm = Math.floor(leftMs / 60000), ss = Math.floor(leftMs / 1000) % 60;
  const mine = cc.targets.find(t => t.id === me.id);
  const status = !mine ? '' : mine.checkedIn ? ' — ✅ You\'re checked in' : ' — ⏳ NOT checked in yet — having the app open checks you in';
  b.hidden = false;
  b.textContent = `📍 LOCATION CHECK — ${mm}:${String(ss).padStart(2, '0')} left${status}`;
  const done = cc.targets.filter(t => t.checkedIn).length;
  board.innerHTML = `<div class="card"><h3>📍 Location Check — called by ${escapeHtml(cc.startedByName)}</h3>
    <p class="hint">${cc.mode === 'scrimmage' ? '🏋 Scrimmage call — practice only: nobody really goes out.' : 'Miss the deadline and you are OUT.'} ${done}/${cc.targets.length} checked in • deadline ${fmtTime(cc.deadlineAt)} • reminders every ${cc.intervalMin} min to anyone still missing.</p>
    ${cc.targets.map(t => `<div class="hunter"><span><b>${escapeHtml(t.name)}</b></span><span class="sub">${t.out ? 'OUT — by other means' : t.checkedIn ? '✅ checked in ' + fmtTime(t.checkedInAt) : '⏳ waiting…'}</span></div>`).join('')}</div>`;
}

// ── League ping (My Card, Round 7) ──
function renderPing() {
  const el = $('#pingCard');
  if (!el) return;
  const me = S.me;
  if (me.watching || me.out || !me.alive) { el.innerHTML = ''; return; }
  const cdMs = S.pingCooldownMs || 3600000;
  const left = cdMs - (Date.now() - (me.lastPingAt || 0));
  el.innerHTML = `<div class="card"><h3>📍 Ping the league</h3>
  <p class="hint">One push to every other hunter in the game — "open the app and update your location" — with your name on it. One ping per ${Math.round(cdMs / 60000)} min; make it count.</p>
  ${left > 0
    ? `<button class="ghost" disabled>📍 Ping cooling down — ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} left</button>`
    : '<button class="primary" onclick="pingLeague()">📍 Ping the league</button>'}</div>`;
}
async function pingLeague() {
  try {
    const d = await api('/api/ping', 'POST', {});
    S = d.state; render();
    toast(`📍 Ping sent — ${d.pinged} hunter${d.pinged === 1 ? '' : 's'} nudged.`);
  } catch (e) { toast(e.message); refresh(); }
}

// ── first-open walkthrough (3 cards, once per hunter, re-openable) ──
function maybeWalkthrough() {
  if (S && S.me && S.me.walkthroughSeen === false) showWalkthrough();
}
function showWalkthrough() {
  $('#walkBody').innerHTML = `<h3>Welcome to the hunt 🏹</h3>
    <div class="walkcard"><b>1 — How a kill works</b><p>Tag a hunter with the season's weapon, then file the claim in Chat (attach the proof photo if you've got it). Your target confirms it — or disputes it and the Founder/Vice settles it. Confirmed kills pay XP and climb you up the Marine ladder.</p></div>
    <div class="walkcard"><b>2 — Safe zones hide you</b><p>Set home, work, and church zones on the Map tab. Inside one, your pin disappears and the league is told you're at a safe zone — never where it is. Moving fast does the same thing: sustained speed over ~20 mph (while the app is open) makes you 🚗 Driving — pin hidden, untouchable, until you stop. And there's no hunting at work, at church, while driving, or by entering a home uninvited. Turning sharing off mid-season puts you OUT.</p></div>
    <div class="walkcard"><b>3 — Your Kill Cancel card</b><p>One per season. Get killed and you have 24 hours to play it: the kill is VOIDED, nobody dies, and you're IMMUNE for 24 hours. But the killer can burn HIS card to override you — then the kill stands and both cards are gone. Carry your card.</p></div>
    <button class="primary" onclick="dismissWalkthrough()">Start hunting</button>
    <button class="ghost" onclick="hideWalkthrough()">Skip for now</button>`;
  $('#walkthrough').hidden = false;
}
function hideWalkthrough() { $('#walkthrough').hidden = true; }
async function dismissWalkthrough() {
  hideWalkthrough();
  try { const d = await api('/api/walkthrough', 'POST', { seen: true }); S = d.state; render(); } catch (e) { /* non-fatal */ }
}

// ── actions ──
async function refresh() { try { const d = await api('/api/state'); S = d; render(); } catch (e) { /* session may be gone */ } }
let loopsStarted = false;
function startLoops() {
  if (loopsStarted) return; loopsStarted = true;
  setInterval(refresh, 15000);
  setInterval(() => { if (S) render(); }, 60000); // countdown tick
  // Hunt Mode heartbeat: while hunting, re-post the last fix on its ~5 s
  // heartbeat even when the GPS itself has gone quiet (parked hunter).
  setInterval(() => { if (S && S.me && S.me.huntingOn) maybePostPosition(); }, 4000);
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
async function duckAward() {
  const id = $('#admDuckPlayer').value;
  if (!confirm(`Award the Duck of Shame to ${nameOf(id)}? −50 XP and a public roasting.`)) return;
  try { const d = await api('/api/admin/duck', 'POST', { playerId: id }); S = d.state; render(); toast('🦆 Duck awarded.'); } catch (e) { toast(e.message); }
}
async function bountyPlace() {
  try { const d = await api('/api/admin/bounty', 'POST', { targetId: $('#admBountyTarget').value, amount: Number($('#admBountyAmt').value), note: $('#admBountyNote').value }); S = d.state; render(); toast('💰 Bounty placed.'); } catch (e) { toast(e.message); }
}
async function bountyRemove(id) {
  try { const d = await api('/api/admin/bounty/' + id, 'DELETE', {}); S = d.state; render(); toast('Bounty pulled.'); } catch (e) { toast(e.message); }
}
async function callsignReset() {
  const id = $('#admCsPlayer').value;
  if (!confirm(`Clear ${nameOf(id)}'s callsign?`)) return;
  try { const d = await api('/api/admin/callsign', 'POST', { playerId: id, callsign: '' }); S = d.state; render(); toast('Callsign cleared.'); } catch (e) { toast(e.message); }
}
async function checkSettingsSave() {
  try { const d = await api('/api/admin/check-settings', 'POST', { intervalMin: Number($('#admCheckInterval').value), deadlineMin: Number($('#admCheckDeadline').value) }); S = d.state; render(); toast('Check settings saved — they apply to the next call.'); } catch (e) { toast(e.message); }
}
async function checkCallStart() {
  if (!confirm('Call a LOCATION CHECK? Targets get pushed now, reminders repeat on the interval, and in a live season anyone who misses the deadline is OUT.')) return;
  try { const d = await api('/api/admin/check-call/start', 'POST', {}); S = d.state; render(); toast('📍 Location check called.'); } catch (e) { toast(e.message); }
}
async function checkCallCancel() {
  if (!confirm('Call off the location check? It ends now and no elimination is ever applied from it.')) return;
  try { const d = await api('/api/admin/check-call/cancel', 'POST', {}); S = d.state; render(); toast('Location check called off.'); } catch (e) { toast(e.message); }
}
async function scrimmageToggle() {
  const on = !S.league.scrimmage;
  if (!on && !confirm('End the scrimmage? The practice board resets clean (real XP and the real board are untouched).')) return;
  try { const d = await api('/api/admin/scrimmage', 'POST', { on }); S = d.state; render(); toast(on ? '🏋 Scrimmage open — nothing counts.' : 'Scrimmage over.'); } catch (e) { toast(e.message); }
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

// ── league backup / restore (Founder/Vice) ──
// Stale-backup reminder banner (Round 5): S.backup only exists for admins;
// its `stale` flag is computed server-side (live season or scrimmage, last
// backup missing/>7 days, this admin not snoozed).
function backupReminderHtml() {
  if (!S.backup || !S.backup.stale) return '';
  return `<div class="backup-warn">⚠️ <b>No recent backup</b> — download one so a server wipe can't kill the season.<div class="row" style="margin-top:8px"><button class="primary small" onclick="backupDownload()">⬇ Download backup</button><button class="ghost small" onclick="snoozeBackup()">Remind me tomorrow</button></div></div>`;
}
async function snoozeBackup() {
  try { const d = await api('/api/admin/backup-snooze', 'POST', {}); S = d.state; render(); toast('Backup reminder snoozed until tomorrow.'); } catch (e) { toast(e.message); }
}
async function backupDownload() {
  try {
    // Authenticated fetch (the endpoint needs the session token), then hand
    // the blob to the browser as a file download under the server's filename.
    const r = await fetch('/api/admin/backup', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || ('HTTP ' + r.status)); }
    const blob = await r.blob();
    const m = String(r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'open-season-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup downloaded — keep it somewhere safe.');
    refresh(); // the download just stamped lastBackupAt — clear the stale-backup reminder
  } catch (e) { toast(e.message); }
}
async function restorePicked(input) {
  const file = input.files && input.files[0];
  input.value = ''; // let the same file be picked again after a cancel
  if (!file) return;
  let text, parsed;
  try { text = await file.text(); } catch (e) { toast('Could not read that file.'); return; }
  try { parsed = JSON.parse(text); } catch (e) { toast('That file is not a valid backup — it is not JSON.'); return; }
  if (!parsed || parsed.format !== 'open-season-backup' || !parsed.state || !parsed.state.league || !Array.isArray(parsed.state.players)) {
    toast('That file is not an Open Season backup.'); return;
  }
  const bs = parsed.state;
  const when = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString() : 'an unknown time';
  const summary = `Season ${bs.league.season} • ${bs.players.filter(p => p.claimed).length} hunters claimed • ${(bs.xpLog || []).length} ledger entries • ${(bs.archive || []).length} archived season(s)`;
  if (!confirm(`RESTORE the league from the backup taken ${when}?\n\n${summary}\n\nThis REPLACES the entire current league — kills, XP, chat, everything — with that backup. There is no undo. Restore it?`)) return;
  try {
    const r = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: text,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    toast('League restored — reloading…');
    setTimeout(() => location.reload(), 700);
  } catch (e) { toast('Restore failed: ' + e.message); }
}

// geolocation: while sharing is on and the app is open, send fixes
function ensureWatch() {
  if (watchId !== null || !navigator.geolocation) return;
  // maximumAge 0 while hunting (GPS stays hot); relaxed otherwise.
  const maxAge = S && S.me && S.me.huntingOn ? 0 : 30000;
  watchId = navigator.geolocation.watchPosition(async pos => {
    // Forward the device-reported speed (m/s) when the phone provides one —
    // the server uses it for Driving mode and falls back to a position-derived
    // estimate when it's null. Detection only runs while the app is open.
    lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, speed: typeof pos.coords.speed === 'number' ? pos.coords.speed : null };
    maybePostPosition();
  }, () => { if (!geoErrShown) { geoErrShown = true; toast('Phone is not sending your location. Allow it for this site: tap the icon in Safari\'s address bar → Website Settings → Location → Allow, then reload.'); } }, { enableHighAccuracy: true, maximumAge: maxAge });
}
// Post the latest fix, throttled while hunting: at most ~every 3 s, and
// only on ≥10 m of movement or a ~5 s heartbeat (the startLoops interval
// drives the heartbeat for a parked hunter whose GPS has gone quiet).
// Not hunting: every fix posts, exactly as before.
let postInFlight = false;
async function maybePostPosition() {
  if (!S || !S.me || !S.me.sharing || !lastPos || postInFlight) return;
  if (S.me.huntingOn) {
    const now = Date.now(), since = now - lastPostAt;
    if (since < 3000) return;
    const moved = lastPostPos ? haversineMi(lastPostPos.lat, lastPostPos.lng, lastPos.lat, lastPos.lng) * 1609.34 : Infinity;
    if (moved < 10 && since < 5000) return;
  }
  postInFlight = true;
  lastPostAt = Date.now(); lastPostPos = { lat: lastPos.lat, lng: lastPos.lng };
  try { const d = await api('/api/position', 'POST', lastPos); S = d.state; render(); } catch (e) { /* silent */ }
  postInFlight = false;
}

// ── Hunt Mode (Round 6): wake lock + toggle ──
// The Wake Lock API is feature-detected and fully graceful: where the
// browser doesn't offer it, Hunt Mode still gets the hot GPS + banner.
async function acquireWakeLock() {
  if (wakeLock) return;
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; /* denied or unsupported — hunt on anyway */ }
}
function releaseWakeLock() {
  const wl = wakeLock; wakeLock = null;
  if (wl) { try { wl.release(); } catch (e) { /* already released */ } }
}
// The browser drops the lock whenever the page hides; re-acquire on return
// while still hunting. When the page is hidden/closed, NOTHING runs — that
// is the web-app limit, and Hunt Mode doesn't pretend otherwise.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S && S.me && S.me.huntingOn) acquireWakeLock();
});
async function toggleHuntMode(on) {
  try {
    const wasSharing = !!(S && S.me && S.me.sharing);
    const d = await api('/api/hunt-mode', 'POST', { on });
    S = d.state; render();
    if (on) {
      acquireWakeLock();
      if (!wasSharing) {
        // The server turned sharing on with Hunt Mode — start the GPS feed.
        ensureWatch();
        if (lastPos) { try { const p = await api('/api/position', 'POST', lastPos); S = p.state; render(); } catch (e) { /* silent */ } }
        toast('🎯 Hunt Mode ON — sharing turned on with it.');
      } else toast('🎯 Hunt Mode ON — you are live.');
      if (S.me && !S.me.huntHintSeen) {
        toast('Hunt Mode keeps your screen on and GPS hot, so it eats battery.', 5200);
        S.me.huntHintSeen = true; // optimistic: the hint never nags twice
        api('/api/hunt-hint', 'POST', {}).catch(() => { });
      }
      maybePostPosition();
    } else {
      releaseWakeLock();
      toast('Hunt Mode off. Sharing stays as it was.');
    }
  } catch (e) { toast(e.message); }
}
function huntElapsedText() {
  const t0 = S && S.me && S.me.huntStartedAt ? Date.parse(S.me.huntStartedAt) : NaN;
  if (!Number.isFinite(t0)) return '';
  const m = Math.max(0, Math.floor((Date.now() - t0) / 60000));
  const h = Math.floor(m / 60);
  return ` — ${h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`} on the hunt`;
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
  try {
    const body = { victimId: $('#killVictim').value, stealth: $('#killStealth').checked };
    const file = $('#killPhoto').files && $('#killPhoto').files[0];
    if (file) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Proof photo must be a JPEG, PNG, or WebP');
      if (file.size > 2.5 * 1024 * 1024) throw new Error('Proof photo is too big — keep it under 2.5 MB');
      body.photo = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => { const s = String(rd.result); resolve({ mime: file.type, data: s.slice(s.indexOf(',') + 1) }); };
        rd.onerror = () => reject(new Error('Could not read that photo'));
        rd.readAsDataURL(file);
      });
    }
    const d = await api('/api/kills', 'POST', body);
    S = d.state; $('#killPhoto').value = ''; render(); toast('Kill claimed — waiting on your target.');
  } catch (e) { toast(e.message); }
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
$('#overlayClose').addEventListener('click', closeOverlay);
$('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeOverlay(); });
window.killAct = killAct; window.settleKill = settleKill; window.saveSettings = saveSettings;
window.eventWin = eventWin; window.adjustXp = adjustXp; window.closeSeason = closeSeason; window.delZone = delZone;
window.openProfile = openProfile; window.openRanks = openRanks; window.closeOverlay = closeOverlay;
window.duckAward = duckAward; window.bountyPlace = bountyPlace; window.bountyRemove = bountyRemove;
window.scrimmageToggle = scrimmageToggle; window.toggleAlerts = toggleAlerts;
window.reactTo = reactTo; window.saveProfile = saveProfile; window.pickAvatar = pickAvatar;
window.copyInvite = copyInvite; window.callsignReset = callsignReset;
window.showWalkthrough = showWalkthrough; window.hideWalkthrough = hideWalkthrough; window.dismissWalkthrough = dismissWalkthrough;
window.backupDownload = backupDownload; window.restorePicked = restorePicked;
window.snoozeBackup = snoozeBackup; window.testPush = testPush;
window.toggleHuntMode = toggleHuntMode;
window.pingLeague = pingLeague;
window.checkSettingsSave = checkSettingsSave; window.checkCallStart = checkCallStart; window.checkCallCancel = checkCallCancel;

// Push-only service worker (no offline caching — see sw.js).
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => { }); }

(async function boot() {
  await loadRoster();
  if (token) { try { const d = await api('/api/state'); enterApp(d); ensureWatch(); return; } catch (e) { token = ''; localStorage.removeItem('os_token'); } }
})();
