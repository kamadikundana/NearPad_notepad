'use strict';
// A session = one shared Y.Doc between exactly two laptops over an authenticated,
// encrypted WebSocket. Pairing rules on the host:
//   - the code is single use and expires (default 2 min)
//   - only one handshake at a time, each with a hard timeout
//   - 3 failed attempts burn the code and stop listening
//   - once paired, no further connections are accepted
const Y = require('yjs');
const { WebSocketServer, WebSocket } = require('ws');
const { EventEmitter } = require('events');
const C = require('./crypto');
const discovery = require('./discovery');

const DEFAULT_PORT = 47800;
const MAX_FRAME = 2 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10000;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s, len) => {
  if (typeof s !== 'string' || s.length > 200) return null;
  const b = Buffer.from(s, 'base64');
  return len && b.length !== len ? null : b;
};

class Session extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    if (this.timers) this.timers.forEach(clearTimeout);
    this.doc = new Y.Doc();
    this.text = this.doc.getText('note');
    this.role = null; // 'host' | 'guest' | null
    this.server = null;
    this.ws = null;
    this.channel = null;
    this.linked = false; // encrypted channel currently alive
    this.paired = false;
    this.code = null;
    this.expiresAt = null;
    this.attemptsLeft = 0;
    this.busy = false; // host: a handshake is in flight
    this.timers = [];
    this.stopResponder = null;

    const doc = this.doc;
    const text = this.text;
    text.observe((_e, tr) => {
      if (tr.origin === 'remote') this.emit('remote-text', text.toString());
    });
    doc.on('update', (update, origin) => {
      if (origin !== 'remote') this.send(update);
    });
  }

  get active() {
    return this.role !== null;
  }

  info() {
    return {
      active: this.active,
      role: this.role,
      paired: this.paired,
      linked: this.linked,
      code: this.role === 'host' && !this.paired ? C.formatCode(this.code) : null,
      expiresAt: this.role === 'host' && !this.paired ? this.expiresAt : null,
      attemptsLeft: this.attemptsLeft,
      addresses: this.role === 'host' && !this.paired ? discovery.localAddresses() : [],
    };
  }

  getText() {
    return this.text.toString();
  }

  applyLocalEdit({ start, del, ins }) {
    const len = this.text.length;
    if (start < 0 || del < 0 || start + del > len) return; // ignore out-of-range edits
    this.doc.transact(() => {
      if (del > 0) this.text.delete(start, del);
      if (ins) this.text.insert(start, ins);
    });
  }

  send(update) {
    if (!this.linked || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(this.channel.seal(update));
  }

  fail(msg) {
    this.emit('error-msg', msg);
  }

  // Encrypted phase: every frame must authenticate or the link is dropped.
  startSecure(ws, keys) {
    this.channel = new C.Channel(keys.send, keys.recv);
    this.ws = ws;
    this.linked = true;
    this.paired = true;
    ws.removeAllListeners('message');
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      try {
        if (!isBinary) throw new Error('unexpected text frame');
        Y.applyUpdate(this.doc, new Uint8Array(this.channel.open(data)), 'remote');
      } catch {
        this.linkLost('Security error: received invalid data, connection closed.');
        ws.terminate();
      }
    });
    ws.on('close', () => this.linkLost('The other laptop disconnected.'));
    ws.send(this.channel.seal(Y.encodeStateAsUpdate(this.doc))); // catch the peer up
    this.emit('changed');
  }

  linkLost(reason) {
    if (!this.linked) return;
    this.linked = false;
    if (this.channel) this.channel.wipe();
    this.emit('link-lost', reason);
    this.emit('changed');
  }

  // ---------------- host ----------------

  async host({ port = DEFAULT_PORT, ttlMs = 120000, maxAttempts = 3, announce = true } = {}) {
    await C.init();
    this.role = 'host';
    this.code = C.generateCode();
    this.expiresAt = Date.now() + ttlMs;
    this.attemptsLeft = maxAttempts;

    await new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ port, maxPayload: MAX_FRAME });
      this.server.once('listening', resolve);
      this.server.once('error', (e) => {
        this.role = null;
        reject(e);
      });
    });
    this.server.on('error', () => {});
    this.server.on('connection', (ws) => this.onIncoming(ws));
    if (announce) this.stopResponder = discovery.respond(port);
    this.timers.push(
      setTimeout(() => {
        if (!this.paired) this.closePairing('The code expired. Start a new session.');
      }, ttlMs)
    );
    this.emit('changed');
    return { code: C.formatCode(this.code), expiresAt: this.expiresAt };
  }

  closePairing(reason) {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.stopResponder) {
      this.stopResponder();
      this.stopResponder = null;
    }
    if (reason) this.emit('pairing-closed', reason);
  }

  onIncoming(ws) {
    ws.on('error', () => {});
    if (this.paired || this.busy || Date.now() > this.expiresAt || this.attemptsLeft <= 0) return ws.close(1008);
    this.busy = true;

    let state = 'hello';
    let spake = null;
    let result = null;
    let finished = false;

    const end = (success) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.busy = false;
      if (success) return;
      ws.terminate();
      this.attemptsLeft -= 1;
      if (this.attemptsLeft <= 0) this.closePairing('Too many wrong codes. Start a new session.');
      else this.emit('attempt-failed', this.attemptsLeft);
      this.emit('changed');
    };
    const timer = setTimeout(() => end(false), HANDSHAKE_TIMEOUT_MS);

    ws.on('close', () => end(false));
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('binary during handshake');
        const msg = JSON.parse(data.toString());
        if (state === 'hello' && msg.t === 'hello') {
          const X = unb64(msg.m, 32);
          if (!X) throw new Error('bad hello');
          spake = new C.Spake2('host', this.code);
          const Y = spake.message();
          result = spake.finish(X);
          ws.send(JSON.stringify({ t: 'reply', m: b64(Y), c: b64(result.myConfirm) }));
          state = 'confirm';
        } else if (state === 'confirm' && msg.t === 'confirm') {
          const tag = unb64(msg.c, 32);
          if (!tag || !result.verifyPeerConfirm(tag)) throw new Error('wrong code');
          finished = true;
          clearTimeout(timer);
          this.busy = false;
          this.closePairing(); // single use: stop listening and announcing
          this.startSecure(ws, result.keys);
        } else throw new Error('unexpected message');
      } catch {
        end(false);
      }
    });
  }

  // ---------------- guest ----------------

  async join(host, code, port = DEFAULT_PORT) {
    await C.init();
    const canon = C.normalizeCode(code);
    if (!canon) throw new Error('That code is not valid. It has 8 letters/numbers, e.g. K7QM-4XPD.');

    const ws = new WebSocket(`ws://${host}:${port}`, { maxPayload: MAX_FRAME, handshakeTimeout: 5000 });
    const spake = new C.Spake2('guest', canon);

    const keys = await new Promise((resolve, reject) => {
      let state = 'reply';
      let result = null;
      const timer = setTimeout(() => reject(new Error('Pairing timed out.')), HANDSHAKE_TIMEOUT_MS);
      const bail = (msg) => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error(msg));
      };
      ws.once('error', (err) => {
        const c = err && err.code;
        if (c === 'ECONNREFUSED') bail(`${host} is reachable but no NearPad session is open there (or its code expired). Start a new session on that laptop.`);
        else bail(`Could not reach ${host}. The other laptop's firewall (Wi-Fi set to Public?) or the Wi-Fi itself is blocking the connection.`);
      });
      ws.once('close', () => bail('Wrong code, or the session is no longer available.'));
      ws.once('open', () => ws.send(JSON.stringify({ t: 'hello', m: b64(spake.message()) })));
      ws.on('message', (data, isBinary) => {
        try {
          if (isBinary || state !== 'reply') throw new Error('unexpected');
          const msg = JSON.parse(data.toString());
          const Y = unb64(msg.m, 32);
          const tag = unb64(msg.c, 32);
          if (msg.t !== 'reply' || !Y || !tag) throw new Error('bad reply');
          result = spake.finish(Y);
          if (!result.verifyPeerConfirm(tag)) return bail('Wrong code, or the session is no longer available.');
          state = 'done';
          ws.send(JSON.stringify({ t: 'confirm', c: b64(result.myConfirm) }));
          clearTimeout(timer);
          ws.removeAllListeners('close');
          resolve(result.keys);
        } catch {
          bail('Pairing failed.');
        }
      });
    });

    this.role = 'guest';
    this.startSecure(ws, keys);
  }

  // Wipe everything and disconnect.
  leave() {
    if (this.stopResponder) this.stopResponder();
    if (this.server) this.server.close();
    if (this.ws) this.ws.terminate();
    if (this.channel) this.channel.wipe();
    this.doc.destroy();
    this.reset();
    this.emit('changed');
  }
}

module.exports = { Session, DEFAULT_PORT };
