'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', { name }),

  // The id now comes back from the main process rather than going out with the
  // request: the terminal belongs to the app, not to this window, and only the
  // side that keeps the list can name one.
  create: (opts) => ipcRenderer.invoke('pty:create', opts),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  history: (id, seq) => ipcRenderer.invoke('sessions:history', { id, seq }),

  write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  claim: (id, cols, rows) => ipcRenderer.send('pty:claim', { id, cols, rows }),
  flow: (id, pause) => ipcRenderer.send('pty:flow', { id, pause }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  toggleFullScreen: () => ipcRenderer.send('win:fullscreen'),

  backup: (projectPath) => ipcRenderer.invoke('backup:run', { projectPath }),
  backupRoot: () => ipcRenderer.invoke('backup:root'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  pickFolder: (title, defaultPath) => ipcRenderer.invoke('config:pick', { title, defaultPath }),
  reveal: (target) => ipcRenderer.invoke('config:reveal', { target }),

  usage: () => ipcRenderer.invoke('usage:get'),

  // Phone access. Everything secret stays on the other side of this line — the
  // renderer is handed a pairing code to display and a list of device names,
  // never the keys those devices hold.
  remote: {
    status: () => ipcRenderer.invoke('remote:status'),
    newCode: () => ipcRenderer.invoke('remote:code'),
    cancelCode: () => ipcRenderer.invoke('remote:cancelCode'),
    forget: (id) => ipcRenderer.invoke('remote:forget', { id }),
    fixFirewall: () => ipcRenderer.invoke('remote:fixFirewall'),
    onChanged: (cb) => ipcRenderer.on('remote:changed', () => cb()),
  },

  onData: (cb) => ipcRenderer.on('pty:data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, payload) => cb(payload)),

  // A terminal appeared, was renamed, changed stage or went away — including
  // the ones a phone opened, which is how they arrive in the sidebar.
  onSession: (cb) => ipcRenderer.on('session:event', (_e, payload) => cb(payload)),
  onIdle: (cb) => ipcRenderer.on('session:idle', (_e, payload) => cb(payload)),
  onProjectsChanged: (cb) => ipcRenderer.on('projects:changed', () => cb()),

  // Electron's clipboard rather than navigator.clipboard, which needs a
  // secure context we don't have under file://.
  copy: (text) => clipboard.writeText(text),
  paste: () => clipboard.readText(),
});
