const assert = require('assert');
const os = require('os');
const { Session } = require('../src/session');

(async () => {
  // Pretend we're on 127.0.0.200/24 so the sweep covers 127.0.0.1-254 (loopback) and can find a local host.
  os.networkInterfaces = () => ({ lo: [{ family: 'IPv4', internal: false, address: '127.0.0.200', netmask: '255.255.255.0' }] });
  const discovery = require('../src/discovery');
  const a = new Session();
  await a.host({ port: 47950, announce: false });
  const t0 = Date.now();
  const found = await discovery.scan(47950, 800);
  console.log('scan took', Date.now() - t0, 'ms ->', JSON.stringify(found));
  assert.ok(found.some((h) => h.address === '127.0.0.1' && h.port === 47950), 'sweep found host without UDP');
  assert.ok(a.paired === false && a.attemptsLeft === 3, 'scanning does not burn pairing attempts');
  assert.ok(Array.isArray(a.info().addresses));
  a.leave();

  // refused vs unreachable errors
  const b = new Session();
  await assert.rejects(b.join('127.0.0.1', 'ABCD-2345', 47951), /no NearPad session is open/);
  console.log('DISCOVERY TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
