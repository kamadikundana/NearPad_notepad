// Generates assets/icon.png (32x32 rounded blue square) with no dependencies.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const N = 32;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const dx = Math.min(x, N - 1 - x), dy = Math.min(y, N - 1 - y);
    const corner = dx < 5 && dy < 5 && Math.hypot(5 - dx, 5 - dy) > 5;
    const line = (y === 11 || y === 16 || y === 21) && x > 7 && x < 24;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    const [r, g, b, a] = corner ? [0, 0, 0, 0] : line ? [255, 255, 255, 255] : [43, 108, 214, 255];
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
console.log('wrote assets/icon.png');
