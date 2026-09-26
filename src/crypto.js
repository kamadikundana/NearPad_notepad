'use strict';
// Pairing-code crypto for NearPad.
//
//  1. The host shows a short one-time code. It is never sent over the network.
//  2. Both laptops run SPAKE2 (password-authenticated key exchange, ristretto255) using the
//     code. An eavesdropper learns nothing that lets them test guesses offline, and an active
//     attacker gets exactly ONE code guess per connection attempt.
//  3. Key confirmation proves both sides derived the same key (i.e. typed the same code).
//  4. All note data then travels in AES-256-GCM frames with per-direction keys and a strictly
//     increasing counter (tamper, replay and reorder protection).
//
// NOTE: SPAKE2 here is built on the audited @noble/curves ristretto255 group, but this exact
// composition has not had an independent security audit.

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 symbols, no 0/O/1/I
const CODE_LEN = 8; // 32^8 = 40 bits; only online guessing is possible, and it is rate-limited
const PROTOCOL = 'NearPad-SPAKE2-v1';

let R = null; // @noble/curves ristretto255 (ESM, loaded lazily)
let M = null;
let N = null;
let L = null;

async function init() {
  if (R) return;
  const mod = await import('@noble/curves/ed25519.js');
  R = mod.ristretto255;
  const hasher = mod.ristretto255_hasher;
  L = R.Point.Fn.ORDER;
  // Nothing-up-my-sleeve blinding points: no one knows their discrete log w.r.t. the base point.
  M = hasher.hashToCurve(Buffer.from(`${PROTOCOL} M`), { DST: `${PROTOCOL}-M` });
  N = hasher.hashToCurve(Buffer.from(`${PROTOCOL} N`), { DST: `${PROTOCOL}-N` });
}

// ---------- pairing code ----------

function generateCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Accepts "abcd-efgh", "ABCD EFGH", etc. Returns the canonical code or null if invalid.
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== CODE_LEN) return null;
  for (const ch of c) if (!ALPHABET.includes(ch)) return null;
  return c;
}

// ---------- helpers ----------

const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const bigToBytes32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

function randomScalar() {
  // 64 random bytes reduced mod L: negligible bias. Reject 0 (multiply() requires 1 <= s < L).
  for (;;) {
    const s = bytesToBig(crypto.randomBytes(64)) % L;
    if (s !== 0n) return s;
  }
}

function passwordScalar(code) {
  const raw = crypto.scryptSync(code, `${PROTOCOL} password`, 64, { N: 1 << 14, r: 8, p: 1 });
  const w = bytesToBig(raw) % L;
  if (w === 0n) throw new Error('bad password scalar');
  return w;
}

const lp = (buf) => {
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(buf.length));
  return Buffer.concat([len, Buffer.from(buf)]);
};

const kdf = (ikm, label) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), `${PROTOCOL} ${label}`, 32));

// ---------- SPAKE2 ----------

class Spake2 {
  // role: 'guest' (party A, uses M) or 'host' (party B, uses N)
  constructor(role, code) {
    if (!R) throw new Error('crypto not initialised');
    this.role = role;
    this.w = passwordScalar(code);
    this.x = randomScalar();
    this.done = false;
  }

  // Our public message: x*G + w*(M or N)
  message() {
    const blind = (this.role === 'guest' ? M : N).multiply(this.w);
    this.mine = R.Point.BASE.multiply(this.x).add(blind);
    return Buffer.from(this.mine.toBytes());
  }

  // Returns { sendKey, recvKey, myConfirm, verifyPeerConfirm(tag) }
  finish(peerBytes) {
    if (this.done) throw new Error('already finished');
    this.done = true;
    const peer = R.Point.fromBytes(new Uint8Array(peerBytes)); // throws on invalid encoding
    const peerBlind = (this.role === 'guest' ? N : M).multiply(this.w);
    const K = peer.subtract(peerBlind).multiply(this.x);
    if (K.is0()) throw new Error('degenerate key');

    const myMsg = Buffer.from(this.mine.toBytes());
    const X = this.role === 'guest' ? myMsg : Buffer.from(peerBytes);
    const Y = this.role === 'guest' ? Buffer.from(peerBytes) : myMsg;
    const TT = Buffer.concat([lp(Buffer.from(PROTOCOL)), lp(X), lp(Y), lp(Buffer.from(K.toBytes())), lp(bigToBytes32(this.w))]);

    const confGuest = kdf(TT, 'confirm guest');
    const confHost = kdf(TT, 'confirm host');
    const g2h = kdf(TT, 'key guest->host');
    const h2g = kdf(TT, 'key host->guest');
    const tag = (key, who) => crypto.createHmac('sha256', key).update(`${PROTOCOL} ${who}`).digest();

    const mine = this.role === 'guest' ? 'guest' : 'host';
    const theirs = this.role === 'guest' ? 'host' : 'guest';
    const myConfKey = this.role === 'guest' ? confGuest : confHost;
    const theirConfKey = this.role === 'guest' ? confHost : confGuest;

    const myConfirm = tag(myConfKey, mine);
    const expected = tag(theirConfKey, theirs);

    // Wipe secrets we no longer need.
    this.x = 0n;
    this.w = 0n;
    TT.fill(0);
    myConfKey.fill(0);
    theirConfKey.fill(0);

    return {
      myConfirm,
      verifyPeerConfirm: (t) =>
        Buffer.isBuffer(t) && t.length === expected.length && crypto.timingSafeEqual(t, expected),
      keys: this.role === 'guest' ? { send: g2h, recv: h2g } : { send: h2g, recv: g2h },
    };
  }
}

// ---------- encrypted channel ----------

class Channel {
  constructor(sendKey, recvKey) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendCtr = 0n;
    this.recvCtr = -1n;
    this.closed = false;
  }

  static iv(ctr) {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(ctr, 4);
    return iv;
  }

  // frame = counter(8) || ciphertext || tag(16)
  seal(plain) {
    if (this.closed) throw new Error('channel closed');
    const ctr = this.sendCtr++;
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(ctr);
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, Channel.iv(ctr));
    c.setAAD(head);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([head, ct, c.getAuthTag()]);
  }

  open(frame) {
    if (this.closed) throw new Error('channel closed');
    if (!Buffer.isBuffer(frame) || frame.length < 8 + 16) throw new Error('short frame');
    const head = frame.subarray(0, 8);
    const ctr = head.readBigUInt64BE();
    if (ctr <= this.recvCtr) throw new Error('replayed or reordered frame');
    const d = crypto.createDecipheriv('aes-256-gcm', this.recvKey, Channel.iv(ctr));
    d.setAAD(head);
    d.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([d.update(frame.subarray(8, frame.length - 16)), d.final()]); // throws if tampered
    this.recvCtr = ctr; // only advance after successful authentication
    return plain;
  }

  wipe() {
    this.closed = true;
    this.sendKey.fill(0);
    this.recvKey.fill(0);
  }
}

module.exports = { init, generateCode, formatCode, normalizeCode, Spake2, Channel, CODE_LEN };
