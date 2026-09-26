'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, session: electronSession } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Session, DEFAULT_PORT } = require('./session');
const discovery = require('./discovery');

// Lets you run two instances on one machine for testing: `npm start -- --profile=b`
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) {
  app.setPath('userData', path.join(app.getPath('userData'), profileArg.split('=')[1].replace(/[^\w-]/g, '')));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const INDEX = path.join(__dirname, 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const MAX_INSERT = 100000;

const session = new Session();
let win = null;
let tray = null;
let quitting = false;

// ---------- hardening ----------

// Only our own bundled page may talk to the main process.
const trusted = (e) => !!win && e.senderFrame && e.senderFrame.url === INDEX_URL && e.sender === win.webContents;

const validHost = (h) => typeof h === 'string' && /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h);

function validEdit(e) {
  return (
    e && Number.isInteger(e.start) && Number.isInteger(e.del) && e.start >= 0 && e.del >= 0 &&
    e.start < 1e9 && e.del < 1e9 && typeof e.ins === 'string' && e.ins.length <= MAX_INSERT
  );
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// ---------- window / tray ----------

function pushStatus() {
  const info = session.info();
  if (win && !win.isDestroyed()) win.webContents.send('status', info);
  if (tray) {
    tray.setToolTip(
      !info.active ? 'NearPad - no session' : info.paired ? (info.linked ? 'NearPad - connected' : 'NearPad - disconnected') : 'NearPad - waiting for pairing'
    );
  }
}

function notice(text) {
  if (win && !win.isDestroyed()) win.webContents.send('notice', text);
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 480,
    minWidth: 300,
    minHeight: 260,
    alwaysOnTop: true,
    title: 'NearPad',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(INDEX);
  // Closing the window hides it to the tray instead of quitting.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show NearPad', click: showWindow },
      { label: 'Always on top', type: 'checkbox', checked: true, click: (item) => win.setAlwaysOnTop(item.checked) },
      { type: 'separator' },
      {
        label: 'Quit (wipes session)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
  pushStatus();
}

// ---------- session events ----------

let lastToast = 0;
session.on('remote-text', (text) => {
  if (win) win.webContents.send('remote-text', text);
  const hidden = !win || !win.isVisible() || !win.isFocused();
  // The toast never shows note content: it could be read on a locked screen or over a shoulder.
  if (hidden && Notification.isSupported() && Date.now() - lastToast > 5000) {
    lastToast = Date.now();
    const n = new Notification({ title: 'NearPad', body: 'New text from your paired laptop', silent: true });
    n.on('click', showWindow);
    n.show();
  }
});
session.on('changed', pushStatus);
session.on('link-lost', (reason) => notice(reason));
session.on('attempt-failed', (left) => notice(`Someone tried a wrong code. ${left} attempt${left === 1 ? '' : 's'} left.`));
session.on('pairing-closed', (reason) => {
  if (session.paired) return;
  if (win) win.webContents.send('ended', reason);
  session.leave();
});

// ---------- IPC (every handler checks the sender and validates its input) ----------

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) return { ok: false, error: 'Untrusted sender.' };
    return fn(...args);
  });
}

handle('session:host', async () => {
  if (session.active) return { ok: false, error: 'A session is already open.' };
  try {
    await session.host({ port: DEFAULT_PORT });
    return { ok: true };
  } catch (err) {
    session.leave();
    return { ok: false, error: err.code === 'EADDRINUSE' ? 'A session is already running on this machine.' : 'Could not start the session.' };
  }
});

handle('session:join', async (host, code) => {
  if (session.active) return { ok: false, error: 'A session is already open.' };
  if (!validHost(host)) return { ok: false, error: 'Enter a valid address, like 192.168.1.20.' };
  try {
    await session.join(host, code, DEFAULT_PORT);
    return { ok: true, text: session.getText() };
  } catch (err) {
    session.leave();
    return { ok: false, error: err.message };
  }
});

handle('session:scan', async () => ({ ok: true, hosts: await discovery.scan(DEFAULT_PORT, 1500) }));
handle('session:leave', () => {
  session.leave();
  return { ok: true };
});
handle('session:status', () => session.info());

ipcMain.on('editor:edit', (e, edit) => {
  if (trusted(e) && validEdit(edit)) session.applyLocalEdit(edit);
});

handle('notes:save', async (text) => {
  if (typeof text !== 'string' || text.length > 5e6) return { ok: false };
  const res = await dialog.showSaveDialog(win, {
    title: 'Save notes (saved as plain, unencrypted text)',
    defaultPath: `nearpad-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, text, 'utf8');
  return { ok: true, path: res.filePath };
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  // No web permissions (camera, geolocation, notifications API...) for the page.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  createTray();
});

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
  session.leave();
});
