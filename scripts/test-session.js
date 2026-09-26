const assert = require('assert');
const net = require('net');
const { Session } = require('../src/session');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 47900;
const nextPort = () => port++;
const opts = (o = {}) => ({ port: nextPort(), announce: false, ...o });

// A TCP proxy that records every byte in both directions (simulates a Wi-Fi eavesdropper).
function tap(target) {
  const chunks = [];
  const srv = net.createServer((c) => {
    const up = net.connect(target, '127.0.0.1');
    c.on('data', (d) => { chunks.push(d); up.write(d); });
    up.on('data', (d) => { chunks.push(d); c.write(d); });
    c.on('error', () => {}); up.on('error', () => {});
    c.on('close', () => up.destroy()); up.on('close', () => c.destroy());
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, srv, dump: () => Buffer.concat(chunks) })));
}

(async () => {
  // ---- happy path + sync + eavesdropper sees no plaintext / no code ----
  {
    const a = new Session(), b = new Session();
    const o = opts();
    const { code } = await a.host(o);
    const proxy = await tap(o.port);
    a.applyLocalEdit({ start: 0, del: 0, ins: 'TOPSECRET-before-join' });
    await b.join('127.0.0.1', code.toLowerCase(), proxy.port);
    await wait(300);
    assert.strictEqual(b.getText(), 'TOPSECRET-before-join', 'late joiner catches up');
    b.applyLocalEdit({ start: b.getText().length, del: 0, ins: ' TOPSECRET-from-guest' });
    a.applyLocalEdit({ start: 0, del: 0, ins: 'H:' });
    await wait(400);
    assert.strictEqual(a.getText(), b.getText(), 'converge');
    const wire = proxy.dump();
    assert.ok(!wire.includes('TOPSECRET'), 'no plaintext on the wire');
    assert.ok(!wire.includes(code.replace('-', '')), 'code never on the wire');
    assert.ok(wire.includes('"t":"reply"'), 'sanity: handshake was captured');

    // a third laptop can't join once paired, even with the right code
    await assert.rejects(new Session().join('127.0.0.1', code, o.port), 'no second joiner');

    // peer loss keeps notes, then leave wipes
    let lost = null; b.on('link-lost', (r) => (lost = r));
    a.leave(); await wait(300);
    assert.ok(lost, 'guest told link lost');
    assert.ok(b.getText().length > 0, 'notes survive link loss so they can be saved');
    b.leave(); assert.strictEqual(b.getText(), '', 'leave wipes');
    proxy.srv.close();
    console.log('ok: pairing, sync, wire secrecy, single guest, wipe');
  }

  // ---- wrong code x3 locks the host; right code afterwards is refused ----
  {
    const a = new Session(); const o = opts();
    const { code } = await a.host(o);
    let closed = null; a.on('pairing-closed', (r) => (closed = r));
    const wrong = code[0] === '2' ? '3' + code.slice(1) : '2' + code.slice(1);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(new Session().join('127.0.0.1', wrong, o.port), /Wrong code|could not|timed/i);
      await wait(150);
    }
    assert.ok(closed && /Too many/.test(closed), 'host locked after 3 failures');
    await assert.rejects(new Session().join('127.0.0.1', code, o.port), 'right code refused after lockout');
    a.leave();
    console.log('ok: lockout after 3 wrong codes');
  }

  // ---- attempts left decrements, correct code still works before lockout ----
  {
    const a = new Session(), b = new Session(); const o = opts();
    const { code } = await a.host(o);
    const wrong = code[0] === '2' ? '3' + code.slice(1) : '2' + code.slice(1);
    await assert.rejects(new Session().join('127.0.0.1', wrong, o.port));
    await wait(150);
    assert.strictEqual(a.attemptsLeft, 2);
    await b.join('127.0.0.1', code, o.port); await wait(200);
    assert.ok(a.paired && b.paired);
    a.leave(); b.leave();
    console.log('ok: one wrong try then correct code pairs');
  }

  // ---- expiry ----
  {
    const a = new Session(); const o = opts({ ttlMs: 300 });
    const { code } = await a.host(o);
    let closed = null; a.on('pairing-closed', (r) => (closed = r));
    await wait(500);
    assert.ok(closed && /expired/.test(closed));
    await assert.rejects(new Session().join('127.0.0.1', code, o.port));
    a.leave();
    console.log('ok: code expires');
  }

  // ---- malformed input / bad code format ----
  {
    const a = new Session(); const o = opts();
    await a.host(o);
    await assert.rejects(new Session().join('127.0.0.1', 'nope', o.port), /not valid/);
    // raw garbage on the socket must not crash the host or unlock anything
    const s = net.connect(o.port, '127.0.0.1'); s.on('error', () => {}); s.write('GET / HTTP/1.1\r\n\r\n'); await wait(150); s.destroy();
    assert.ok(a.active && !a.paired);
    a.leave();
    console.log('ok: malformed input handled');
  }

  // ---- tampering on the encrypted link drops the connection ----
  {
    const a = new Session(), b = new Session(); const o = opts();
    const { code } = await a.host(o);
    await b.join('127.0.0.1', code, o.port); await wait(200);
    let lost = null; a.on('link-lost', (r) => (lost = r));
    b.ws.send(Buffer.alloc(64, 1)); // forged frame, not sealed with the session key
    await wait(300);
    assert.ok(lost && /Security/.test(lost), 'forged frame drops link');
    a.leave(); b.leave();
    console.log('ok: forged frame rejected');
  }

  console.log('ALL SESSION TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
