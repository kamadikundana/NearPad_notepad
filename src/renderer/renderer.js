'use strict';
const $ = (id) => document.getElementById(id);
const editor = $('editor');
let lastValue = ''; // plain text mirror of what #editor currently shows
let countdownTimer = null;

function show(screen) {
  for (const id of ['lobby', 'waiting', 'pad']) $(id).hidden = id !== screen;
  if (screen === 'pad') editor.focus();
}

function flash(el, text, ms = 5000) {
  el.textContent = text;
  if (text && ms) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function renderStatus(s) {
  if (!s.active) return;
  if (s.role === 'host' && !s.paired) {
    show('waiting');
    $('code-show').textContent = s.code || '----';
    $('addr-show').textContent = (s.addresses || []).join('   ') || 'unknown';
    $('attempts').textContent = s.attemptsLeft < 3 ? `${s.attemptsLeft} wrong-code attempt(s) left` : '';
    stopCountdown();
    const tick = () => {
      const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
      $('countdown').textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
    return;
  }
  stopCountdown();
  if ($('pad').hidden) show('pad');
  $('dot').classList.toggle('live', s.linked);
  $('status').textContent = s.linked ? 'Connected (encrypted)' : 'Disconnected - save your notes, then Exit';
}

// Turn a local change into one replace-range edit by trimming the common prefix/suffix.
function diff(oldStr, newStr) {
  let start = 0;
  const max = Math.min(oldStr.length, newStr.length);
  while (start < max && oldStr[start] === newStr[start]) start++;
  let oldEnd = oldStr.length, newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, del: oldEnd - start, ins: newStr.slice(start, newEnd) };
}

// ---- caret helpers: map a plain-text character offset <-> a DOM Range over #editor's text
// nodes. Works because every node we ever put in #editor is a plain text node (no <br>, no
// nested markup), including literal '\n' characters, so offsets always match plain-text length.
function textOffset(node, offset) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let total = 0, cur;
  while ((cur = walker.nextNode())) {
    if (cur === node) return total + offset;
    total += cur.nodeValue.length;
  }
  return total;
}

function getCaret() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
  return { start: textOffset(r.startContainer, r.startOffset), end: textOffset(r.endContainer, r.endOffset) };
}

function setCaret(start, end) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node, total = 0, startNode, startOff, endNode, endOff;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (startNode === undefined && start <= total + len) { startNode = node; startOff = start - total; }
    if (endNode === undefined && end <= total + len) { endNode = node; endOff = end - total; }
    total += len;
  }
  if (startNode === undefined) { startNode = editor; startOff = editor.childNodes.length; }
  if (endNode === undefined) { endNode = editor; endOff = editor.childNodes.length; }
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Rebuild #editor from a Yjs delta ([{insert, attributes:{who}}...]) as colored spans, and
// return its plain text. Uses only textContent/createElement - note text can never become HTML.
function renderDelta(delta) {
  const frag = document.createDocumentFragment();
  let plain = '';
  for (const op of delta) {
    if (typeof op.insert !== 'string' || !op.insert) continue;
    const who = op.attributes && op.attributes.who === 'guest' ? 'guest' : 'host';
    const span = document.createElement('span');
    span.className = `who-${who}`;
    span.appendChild(document.createTextNode(op.insert));
    frag.appendChild(span);
    plain += op.insert;
  }
  return { frag, plain };
}

function applyDelta(delta) {
  const focused = document.activeElement === editor;
  const caret = focused ? getCaret() : null;
  const { frag, plain } = renderDelta(delta);

  // Shift the caret by whatever changed between what we last showed and the authoritative
  // text (a no-op for our own just-typed edit; a real shift when it came from the other side).
  const { start, del, ins } = diff(lastValue, plain);
  const adjust = (pos) => (pos <= start ? pos : pos >= start + del ? pos + ins.length - del : start + ins.length);

  lastValue = plain;
  editor.replaceChildren(frag);
  if (caret && !$('pad').hidden) setCaret(adjust(caret.start), adjust(caret.end));
}

editor.addEventListener('input', () => {
  const plain = editor.textContent;
  const edit = diff(lastValue, plain);
  lastValue = plain; // optimistic; applyDelta() will reconcile once the authoritative delta arrives
  window.nearpad.sendEdit(edit);
});

// contenteditable normally turns Enter into <div>/<br> elements, which would break the plain-
// text model above - force a literal '\n' character instead, consistent with our own rendering.
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.execCommand('insertText', false, '\n');
  }
});

// Always paste as plain text: never let pasted HTML/images/styles into the note.
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

window.nearpad.onDocDelta(applyDelta);
window.nearpad.onStatus(renderStatus);
window.nearpad.onNotice((t) => {
  flash($('pad-msg'), t, 0);
  flash($('attempts'), t);
});
window.nearpad.onEnded((reason) => {
  stopCountdown();
  lastValue = '';
  editor.replaceChildren();
  show('lobby');
  flash($('lobby-msg'), reason);
});

$('btn-host').addEventListener('click', async () => {
  const res = await window.nearpad.host();
  if (!res.ok) return flash($('lobby-msg'), res.error);
  renderStatus(await window.nearpad.getStatus());
});

$('btn-cancel').addEventListener('click', async () => {
  await window.nearpad.leave();
  stopCountdown();
  show('lobby');
});

$('btn-scan').addEventListener('click', async () => {
  $('btn-scan').disabled = true;
  const res = await window.nearpad.scan();
  $('btn-scan').disabled = false;
  const list = $('host-list');
  list.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = res.hosts.length ? 'Choose a laptop...' : 'None found - type its address';
  list.appendChild(first);
  for (const h of res.hosts) {
    const o = document.createElement('option');
    o.value = h.address;
    o.textContent = `${h.name} (${h.address})`; // textContent: names from the network are untrusted
    list.appendChild(o);
  }
});

$('host-list').addEventListener('change', () => {
  if ($('host-list').value) $('host-input').value = $('host-list').value;
});

let joining = false;
$('btn-join').addEventListener('click', async () => {
  if (joining) return; // belt-and-suspenders: the disabled attribute already blocks this
  const host = $('host-input').value.trim() || $('host-list').value;
  if (!host) return flash($('lobby-msg'), 'Scan for a laptop or type its address.');
  joining = true;
  $('btn-join').disabled = true;
  // Safety net: if something leaves the invoke() promise unsettled, don't strand the UI.
  const watchdog = setTimeout(() => { joining = false; $('btn-join').disabled = false; }, 15000);
  try {
    const res = await window.nearpad.join(host, $('code-input').value);
    if (!res.ok) return flash($('lobby-msg'), res.error);
    $('code-input').value = '';
    applyDelta(res.delta || []);
    renderStatus(await window.nearpad.getStatus());
  } finally {
    clearTimeout(watchdog);
    joining = false;
    $('btn-join').disabled = false;
  }
});

$('btn-save').addEventListener('click', async () => {
  const res = await window.nearpad.save(editor.textContent);
  if (res.ok) flash($('pad-msg'), `Saved (unencrypted) to ${res.path}`);
});

$('btn-exit').addEventListener('click', async () => {
  if (!confirm('End the session? Anything you have not saved will be deleted.')) return;
  await window.nearpad.leave();
  lastValue = '';
  editor.replaceChildren();
  show('lobby');
});
