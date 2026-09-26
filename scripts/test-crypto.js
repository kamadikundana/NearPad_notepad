const assert = require('assert');
const C = require('../src/crypto');

(async () => {
  await C.init();

  // codes
  const code = C.generateCode();
  assert.strictEqual(code.length, 8);
  assert.strictEqual(C.normalizeCode(C.formatCode(code).toLowerCase()), code);
  assert.strictEqual(C.normalizeCode('0000-0000'), null, 'ambiguous chars rejected');
  assert.strictEqual(C.normalizeCode('ABC'), null);
  assert.notStrictEqual(C.generateCode(), C.generateCode());

  const run = (codeA, codeB) => {
    const a = new C.Spake2('guest', codeA), b = new C.Spake2('host', codeB);
    const X = a.message(), Y = b.message();
    return { A: a.finish(Y), B: b.finish(X), X, Y };
  };

  // same code -> confirmations verify and keys line up
  const ok = run(code, code);
  assert.ok(ok.A.verifyPeerConfirm(ok.B.myConfirm), 'guest accepts host confirm');
  assert.ok(ok.B.verifyPeerConfirm(ok.A.myConfirm), 'host accepts guest confirm');
  assert.ok(ok.A.keys.send.equals(ok.B.keys.recv) && ok.A.keys.recv.equals(ok.B.keys.send));
  assert.ok(!ok.A.keys.send.equals(ok.A.keys.recv), 'directional keys differ');

  // wrong code -> confirmation fails both ways
  const other = code[0] === '2' ? '3' + code.slice(1) : '2' + code.slice(1);
  const bad = run(code, other);
  assert.ok(!bad.A.verifyPeerConfirm(bad.B.myConfirm), 'wrong code: guest rejects');
  assert.ok(!bad.B.verifyPeerConfirm(bad.A.myConfirm), 'wrong code: host rejects');

  // reflection: echoing our own message back must not verify
  const a = new C.Spake2('guest', code); const X = a.message();
  let reflected = true;
  try { const f = a.finish(X); reflected = f.verifyPeerConfirm(f.myConfirm); } catch { reflected = false; }
  assert.ok(!reflected, 'reflection rejected');

  // invalid / identity points rejected
  assert.throws(() => new C.Spake2('host', code).finish(Buffer.alloc(32, 7)), 'garbage point');
  assert.throws(() => new C.Spake2('host', code).finish(Buffer.alloc(32, 0)), 'identity point');
  assert.throws(() => new C.Spake2('host', code).finish(Buffer.alloc(5)), 'wrong length');

  // channel
  const cs = new C.Channel(ok.A.keys.send, ok.A.keys.recv);
  const cr = new C.Channel(ok.B.keys.send, ok.B.keys.recv);
  const secret = Buffer.from('my secret note 12345');
  const f1 = cs.seal(secret);
  assert.ok(!f1.includes(secret) && !f1.includes('secret'), 'no plaintext on the wire');
  assert.ok(cr.open(f1).equals(secret));
  assert.throws(() => cr.open(f1), /replayed/, 'replay rejected');
  const f2 = cs.seal(Buffer.from('two'));
  const t = Buffer.from(f2); t[10] ^= 1;
  assert.throws(() => cr.open(t), 'tamper rejected');
  assert.ok(cr.open(f2).equals(Buffer.from('two')), 'good frame still works after failed tamper');
  const f3 = cs.seal(Buffer.from('three')), f4 = cs.seal(Buffer.from('four'));
  assert.ok(cr.open(f4));
  assert.throws(() => cr.open(f3), /replayed|reordered/, 'reorder rejected');
  assert.throws(() => cs.open(cs.seal(Buffer.from('x'))), 'wrong-direction key rejected');
  cs.wipe(); assert.throws(() => cs.seal(Buffer.from('x')), /closed/);
  assert.ok(ok.A.keys.send.every((b) => b === 0), 'keys zeroed on wipe');

  console.log('ALL CRYPTO TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
