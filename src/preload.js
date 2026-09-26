'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The page gets only these narrow functions, never ipcRenderer itself.
contextBridge.exposeInMainWorld('nearpad', {
  host: () => ipcRenderer.invoke('session:host'),
  join: (host, code) => ipcRenderer.invoke('session:join', String(host), String(code)),
  scan: () => ipcRenderer.invoke('session:scan'),
  leave: () => ipcRenderer.invoke('session:leave'),
  getStatus: () => ipcRenderer.invoke('session:status'),
  sendEdit: (edit) => ipcRenderer.send('editor:edit', { start: edit.start, del: edit.del, ins: edit.ins }),
  save: (text) => ipcRenderer.invoke('notes:save', String(text)),
  onRemoteText: (cb) => ipcRenderer.on('remote-text', (_e, t) => cb(String(t))),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onEnded: (cb) => ipcRenderer.on('ended', (_e, r) => cb(String(r))),
  onNotice: (cb) => ipcRenderer.on('notice', (_e, r) => cb(String(r))),
});
