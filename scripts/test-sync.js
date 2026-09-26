const assert = require('assert');
const { Session } = require('../src/session');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = new Session(), b = new Session();
  const remoteB = [];
  b.on('remote-text', (t) => remoteB.push(t));

  a.applyLocalEdit({ start: 0, del: 0, ins: 'hello' }); // typed before join
  await a.host(47899);
  await b.join('localhost', 47899);
  await wait(200);
  assert.strictEqual(b.getText(), 'hello', 'late joiner catches up');

  b.applyLocalEdit({ start: 5, del: 0, ins: ' world' });
  await wait(200);
  assert.strictEqual(a.getText(), 'hello world', 'guest -> host');

  // simultaneous edits at both ends
  a.applyLocalEdit({ start: 0, del: 0, ins: 'A:' });
  b.applyLocalEdit({ start: b.getText().length, del: 0, ins: '!' });
  await wait(300);
  assert.strictEqual(a.getText(), b.getText(), 'converge');
  assert.ok(a.getText().startsWith('A:') && a.getText().endsWith('!'));

  a.applyLocalEdit({ start: 0, del: 2, ins: '' });
  await wait(200);
  assert.strictEqual(b.getText(), a.getText(), 'delete syncs');
  assert.ok(remoteB.length > 0, 'remote-text fired on guest');

  let ended = null;
  b.on('ended', (r) => (ended = r));
  a.leave();
  await wait(300);
  assert.ok(ended, 'guest notified when host leaves');
  assert.strictEqual(a.getText(), '', 'host wiped');
  b.leave();
  console.log('ALL SYNC TESTS PASSED:', JSON.stringify(remoteB.at(-1)));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
