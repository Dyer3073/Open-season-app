'use strict';

// ── Web Push (zero-dependency, Node crypto only) ─────────────────────────────
// Implements VAPID (RFC 8292, ES256 JWT) and payload encryption aes128gcm
// (RFC 8291 / RFC 8188) by hand — no web-push package.
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT from env; if
// absent, a keypair is generated once and persisted to DATA_DIR/vapid.json
// (base64url raw points) so subscriptions survive restarts on the same disk.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const store = require('./store');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = str => Buffer.from(str, 'base64url');

let vapidCache = null;
function vapid() {
  if (vapidCache) return vapidCache;
  const subject = process.env.VAPID_SUBJECT || 'mailto:open-season@da-boyz.local';
  let pub = process.env.VAPID_PUBLIC_KEY || '';
  let priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!pub || !priv) {
    const file = path.join(store.DATA_DIR, 'vapid.json');
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.publicKey && saved.privateKey) { pub = saved.publicKey; priv = saved.privateKey; }
    } catch (_) { /* not yet generated */ }
    if (!pub || !priv) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pj = publicKey.export({ format: 'jwk' });
      const dj = privateKey.export({ format: 'jwk' });
      pub = b64u(Buffer.concat([Buffer.from([0x04]), unb64u(pj.x), unb64u(pj.y)]));
      priv = b64u(unb64u(dj.d));
      try { fs.writeFileSync(file, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 1)); } catch (e) { console.warn('Could not persist VAPID keys:', e.message); }
    }
  }
  // Rebuild the JWK (x, y from the public point; d = private scalar) for signing.
  const pubBytes = unb64u(pub);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64u(pubBytes.subarray(1, 33)), y: b64u(pubBytes.subarray(33, 65)),
    d: priv,
  };
  vapidCache = { publicKey: pub, subject, keyObject: crypto.createPrivateKey({ key: jwk, format: 'jwk' }) };
  return vapidCache;
}

function vapidJwt(endpoint) {
  const v = vapid();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: v.keyObject, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(sig)}`;
}

function ecJwkFromPoint(bytes) {
  return { kty: 'EC', crv: 'P-256', x: b64u(bytes.subarray(1, 33)), y: b64u(bytes.subarray(33, 65)) };
}

function encryptPayload(subscription, payloadStr) {
  const uaPublic = unb64u(subscription.keys.p256dh); // 65-byte uncompressed point
  const authSecret = unb64u(subscription.keys.auth); // 16 bytes
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephJwk = eph.publicKey.export({ format: 'jwk' });
  const asPublic = Buffer.concat([Buffer.from([0x04]), unb64u(ephJwk.x), unb64u(ephJwk.y)]);
  const uaKeyObject = crypto.createPublicKey({ key: ecJwkFromPoint(uaPublic), format: 'jwk' });
  const secret = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: uaKeyObject });

  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // Single record: plaintext || 0x02 (final-record delimiter), rs = 4096.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payloadStr, 'utf8'), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const body = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
  return body;
}

function sendOne(subscription, payloadObj) {
  return new Promise(resolve => {
    let url;
    try { url = new URL(subscription.endpoint); } catch (_) { return resolve({ ok: false, status: 0 }); }
    let body, jwt;
    try {
      body = encryptPayload(subscription, JSON.stringify(payloadObj));
      jwt = vapidJwt(subscription.endpoint);
    } catch (e) { return resolve({ ok: false, status: 0, error: e.message }); }
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search, timeout: 10000,
      headers: {
        'Authorization': `vapid t=${jwt}, k=${vapid().publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'TTL': '2419200',
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end(body);
  });
}

// Best-effort: pushes every stored subscription of the player; prunes dead
// ones (404/410) and calls onPrune (usually the store save) if any were cut.
async function sendToPlayer(player, payload, onPrune) {
  await sendToPlayerReport(player, payload, onPrune);
}

// Same delivery + pruning as sendToPlayer, but reports the outcome:
// { targeted, accepted, pruned }. "Accepted" = the push service answered
// 2xx. Used by the self-service test push (Round 5), which must only ever
// touch the requesting player's own subscriptions.
async function sendToPlayerReport(player, payload, onPrune) {
  if (!player || !Array.isArray(player.pushSubs) || !player.pushSubs.length) {
    return { targeted: 0, accepted: 0, pruned: 0 };
  }
  const subs = player.pushSubs.slice();
  const results = await Promise.all(subs.map(s => sendOne(s, payload).then(r => ({ s, r }))));
  player.pushSubs = results.filter(({ r }) => !(r.status === 404 || r.status === 410)).map(({ s }) => s);
  const pruned = subs.length - player.pushSubs.length;
  if (onPrune && pruned) { try { onPrune(); } catch (_) { } }
  return { targeted: subs.length, accepted: results.filter(({ r }) => r.ok).length, pruned };
}

// After a league restore writes a backed-up vapid.json, drop the cached
// keypair so the next vapid() call re-reads the file (env keys, when set,
// still win — vapid() checks them first, before and after a restore).
function invalidateKeys() { vapidCache = null; }

module.exports = { vapid, vapidJwt, encryptPayload, sendOne, sendToPlayer, sendToPlayerReport, invalidateKeys };
