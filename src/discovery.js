'use strict';
// Find NearPad hosts on the local network with a tiny UDP broadcast (no dependencies).
// Discovery only says "a NearPad host is at this address"; it never carries the code, and a
// fake host can't complete pairing without knowing the code.
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 47801;
const PROBE = 'NEARPAD-PROBE-v1';

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      out.add(ip.map((b, k) => (b | (~mask[k] & 255))).join('.'));
    }
  }
  return [...out];
}

// Host side: answer probes while an unpaired session is open. Returns a stop() function.
function respond(sessionPort) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const name = os.hostname().slice(0, 40);
  let sent = 0;
  const tick = setInterval(() => (sent = 0), 1000); // at most 10 replies per second
  sock.on('error', () => {});
  sock.on('message', (msg, rinfo) => {
    if (msg.length !== PROBE.length || msg.toString() !== PROBE || sent >= 10) return;
    sent++;
    sock.send(JSON.stringify({ app: 'nearpad', name, port: sessionPort }), rinfo.port, rinfo.address);
  });
  try {
    sock.bind(DISCOVERY_PORT);
  } catch {
    /* discovery is optional; manual address entry still works */
  }
  return () => {
    clearInterval(tick);
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  };
}

// Guest side: broadcast a probe and collect replies for `ms`.
function scan(ms = 1500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    const finish = () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      if (msg.length > 300) return;
      try {
        const m = JSON.parse(msg.toString());
        const okPort = Number.isInteger(m.port) && m.port >= 1024 && m.port <= 65535;
        if (m.app === 'nearpad' && okPort && typeof m.name === 'string') {
          found.set(`${rinfo.address}:${m.port}`, { name: m.name.slice(0, 40), address: rinfo.address, port: m.port });
        }
      } catch {
        /* ignore junk */
      }
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      for (const addr of broadcastAddresses()) sock.send(PROBE, DISCOVERY_PORT, addr, () => {});
      setTimeout(finish, ms);
    });
  });
}

module.exports = { respond, scan, DISCOVERY_PORT };
