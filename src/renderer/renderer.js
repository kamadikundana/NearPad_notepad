'use strict';
const $ = (id) => document.getElementById(id);
const editor = $('editor');
let lastValue = '';
let countdownTimer = null;

function show(screen) {
  for (const id of ['lobby', 'waiting', 'pad']) $(id).hidden = id !== screen;
  if (screen === 'pad') editor.focus();
}

function flash(el, text, ms = 5000) {
  el.textContent = text;
  if (text && ms) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
}

function setEditorValue(text) {
  lastValue = text;
  editor.value = text;
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

editor.addEventListener('input', () => {
  const edit = diff(lastValue, editor.value);
  lastValue = editor.value;
  window.nearpad.sendEdit(edit);
});

// Apply a remote change without losing the local caret position. Text only ever goes into
// textarea.value, never into HTML.
window.nearpad.onRemoteText((text) => {
  const { start, del, ins } = diff(lastValue, text);
  const adjust = (pos) => (pos <= start ? pos : pos >= start + del ? pos + ins.length - del : start + ins.length);
  const s = adjust(editor.selectionStart), e = adjust(editor.selectionEnd);
  setEditorValue(text);
  editor.setSelectionRange(s, e);
});

window.nearpad.onStatus(renderStatus);
window.nearpad.onNotice((t) => {
  flash($('pad-msg'), t, 0);
  flash($('attempts'), t);
});
window.nearpad.onEnded((reason) => {
  stopCountdown();
  setEditorValue('');
  show('lobby');
  flash($('lobby-msg'), reason);
});

$('btn-host').addEventListener('click', async () => {
  const res = await window.nearpad.host();
  if (!res.ok) return flash($('lobby-msg'), res.error);
  setEditorValue('');
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

$('btn-join').addEventListener('click', async () => {
  const host = $('host-input').value.trim() || $('host-list').value;
  if (!host) return flash($('lobby-msg'), 'Scan for a laptop or type its address.');
  $('btn-join').disabled = true;
  const res = await window.nearpad.join(host, $('code-input').value);
  $('btn-join').disabled = false;
  if (!res.ok) return flash($('lobby-msg'), res.error);
  $('code-input').value = '';
  setEditorValue(res.text || '');
  renderStatus(await window.nearpad.getStatus());
});

$('btn-save').addEventListener('click', async () => {
  const res = await window.nearpad.save(editor.value);
  if (res.ok) flash($('pad-msg'), `Saved (unencrypted) to ${res.path}`);
});

$('btn-exit').addEventListener('click', async () => {
  if (!confirm('End the session? Anything you have not saved will be deleted.')) return;
  await window.nearpad.leave();
  setEditorValue('');
  show('lobby');
});
