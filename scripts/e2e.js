// Launches two real NearPad windows, pairs them with the code, and checks live sync.
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const electron = require('electron');
const assert = require('assert');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));

async function attach(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${port}/json`)).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.once('open', r));
        let id = 0; const pending = new Map();
        ws.on('message', (m) => { const j = JSON.parse(m); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
        const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
        return { ev, send, close: () => ws.close() };
      }
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('could not attach to ' + port);
}

const procs = [];
const launch = (profile, port) => procs.push(spawn(electron, ['.', `--profile=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' }));

(async () => {
  launch('e2e-a', 9231); launch('e2e-b', 9232);
  const A = await attach(9231), B = await attach(9232);
  await wait(800);

  // security posture of the renderer
  assert.strictEqual(await A.ev('typeof require'), 'undefined', 'no require in page');
  assert.strictEqual(await A.ev('typeof process'), 'undefined', 'no process in page');
  assert.strictEqual(await A.ev('typeof window.nearpad.host'), 'function');
  assert.strictEqual(await A.ev('typeof window.nearpad.ipcRenderer'), 'undefined', 'ipcRenderer not exposed');

  await A.ev("document.getElementById('btn-host').click()");
  await wait(800);
  const code = await A.ev("document.getElementById('code-show').textContent");
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'host shows a code: ' + code);
  assert.strictEqual(await A.ev("!document.getElementById('waiting').hidden"), true, 'waiting screen shown');

  // scan should find host A via UDP broadcast
  await B.ev("document.getElementById('btn-scan').click()");
  await wait(2200);
  const opts = await B.ev("[...document.querySelectorAll('#host-list option')].map(o => o.textContent)");
  console.log('scan results:', JSON.stringify(opts));

  // wrong code first
  const wrong = code[0] === '2' ? '3' + code.slice(1) : '2' + code.slice(1);
  await B.ev(`document.getElementById('host-input').value='127.0.0.1'; document.getElementById('code-input').value='${wrong}'; document.getElementById('btn-join').click()`);
  await wait(1500);
  const err = await B.ev("document.getElementById('lobby-msg').textContent");
  assert.match(err, /Wrong code/, 'wrong code rejected: ' + err);
  assert.match(await A.ev("document.getElementById('attempts').textContent"), /2/, 'host shows attempts left');

  // right code
  await B.ev(`document.getElementById('code-input').value='${code.toLowerCase()}'; document.getElementById('btn-join').click()`);
  await wait(2000);
  assert.strictEqual(await A.ev("!document.getElementById('pad').hidden"), true, 'host moved to notepad');
  assert.strictEqual(await B.ev("!document.getElementById('pad').hidden"), true, 'guest moved to notepad');
  assert.match(await B.ev("document.getElementById('status').textContent"), /Connected/);

  // Live typing both directions, into the contenteditable notepad. Each character is typed and
  // committed SEPARATELY (like a real keystroke, not one bulk edit) so every one of them makes
  // its own round trip through IPC - this is what actually exercises (and would expose) the
  // "late-arriving echo overwrites newer text and yanks the caret back" class of bug.
  const plain = (X) => X.ev("document.getElementById('editor').textContent");
  const caretAtEnd = (X) =>
    X.ev(`(() => {
      const e = document.getElementById('editor'); const s = window.getSelection();
      if (!s.rangeCount) return false;
      const r = s.getRangeAt(0);
      const tail = document.createRange();
      tail.selectNodeContents(e);
      tail.setStart(r.endContainer, r.endOffset);
      return tail.toString().length === 0;
    })()`);
  async function type(X, text) {
    await X.ev(`(() => {
      const e = document.getElementById('editor'); e.focus();
      const r = document.createRange(); r.selectNodeContents(e); r.collapse(false);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    for (const ch of text) await X.ev(`document.execCommand('insertText', false, ${JSON.stringify(ch)})`);
  }

  await type(A, 'hello from A');
  assert.strictEqual(await plain(A), 'hello from A', 'typed characters land in order on the typer\'s own screen, no jump-back');
  assert.ok(await caretAtEnd(A), 'caret stays at the end while typing, does not jump back');
  await wait(600);
  assert.strictEqual(await plain(B), 'hello from A', 'A -> B');
  await type(B, ' + hi from B');
  assert.strictEqual(await plain(B), 'hello from A + hi from B', 'typed characters land in order for the guest too');
  assert.ok(await caretAtEnd(B), 'guest caret stays at the end while typing');
  await wait(600);
  assert.strictEqual(await plain(A), 'hello from A + hi from B', 'B -> A');

  // Own text is colored in once you click away (a deliberate tradeoff to avoid the jump-back
  // bug above); the other side's text is colored immediately since it's rendered on arrival.
  await B.ev("document.getElementById('editor').blur()");
  await wait(200);
  const hostSpans = await B.ev("[...document.querySelectorAll('#editor .who-host')].map(s => s.textContent).join('')");
  const guestSpans = await B.ev("[...document.querySelectorAll('#editor .who-guest')].map(s => s.textContent).join('')");
  assert.strictEqual(hostSpans, 'hello from A', 'host text colored as host');
  assert.strictEqual(guestSpans, ' + hi from B', 'guest text colored as guest');
  assert.notStrictEqual(
    await B.ev("getComputedStyle(document.querySelector('#editor .who-host')).color"),
    await B.ev("getComputedStyle(document.querySelector('#editor .who-guest')).color"),
    'host and guest text render in different colors'
  );

  // HTML in a note must stay inert text
  await type(A, ' <img src=x onerror="document.title=\'PWNED\'">');
  await wait(600);
  assert.notStrictEqual(await B.ev('document.title'), 'PWNED');
  assert.ok((await plain(B)).includes('<img'), 'markup delivered as plain text');
  assert.strictEqual(await B.ev("document.querySelectorAll('#editor img').length"), 0, 'no actual <img> element was created');

  // screenshots for the user
  const fs = require('fs');
  for (const [n, X] of [['host', A], ['guest', B]]) {
    const r = await X.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`scripts/e2e-${n}.png`, Buffer.from(r.result.data, 'base64'));
  }

  // Exit uses an in-page overlay, not a native OS dialog (see renderer.js for why), and wipes
  // and returns to lobby; the other side is told.
  await A.ev("document.getElementById('btn-exit').click()");
  await wait(200);
  assert.strictEqual(await A.ev("document.getElementById('exit-confirm').hidden"), false, 'confirm overlay shown');
  await A.ev("document.getElementById('exit-yes').click()");
  await wait(1200);
  assert.strictEqual(await plain(A), '', 'host editor wiped');
  assert.strictEqual(await A.ev("!document.getElementById('lobby').hidden"), true, 'host back at lobby');
  assert.match(await B.ev("document.getElementById('status').textContent"), /Disconnected/, 'guest notified');
  assert.ok((await plain(B)).length > 0, 'guest keeps notes to save');

  // The actual regression reported: after Exit, the lobby's inputs must still accept typing.
  // (This is exactly what a native window.confirm() dialog could break in Electron.)
  await A.ev(`(() => {
    const el = document.getElementById('code-input'); el.focus();
    document.execCommand('insertText', false, 'X');
  })()`);
  assert.strictEqual(await A.ev("document.getElementById('code-input').value"), 'X', 'code field is typeable again after Exit');
  await A.ev(`(() => {
    const el = document.getElementById('host-input'); el.focus();
    document.execCommand('insertText', false, '9');
  })()`);
  assert.strictEqual(await A.ev("document.getElementById('host-input').value"), '9', 'address field is typeable again after Exit');

  console.log('E2E PASSED');
})().then(() => cleanup(0)).catch((e) => { console.error('E2E FAILED:', e.message); cleanup(1); });

function cleanup(code) { procs.forEach((p) => p.kill()); setTimeout(() => process.exit(code), 800); }
