'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', { name }),
  deleteProject: (projectPath) => ipcRenderer.invoke('projects:delete', { projectPath }),
  renameProject: (projectPath, name) => ipcRenderer.invoke('projects:rename', { projectPath, name }),

  // Only ever used to name things the way this machine names them — the
  // recycle bin, which is a wastebasket somewhere else.
  platform: process.platform,

  // The id now comes back from the main process rather than going out with the
  // request: the terminal belongs to the app, not to this window, and only the
  // side that keeps the list can name one.
  create: (opts) => ipcRenderer.invoke('pty:create', opts),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  history: (id, seq) => ipcRenderer.invoke('sessions:history', { id, seq }),

  // Claude's own record of what has been worked on here, which is nothing to do
  // with the terminals Hangar is running — these are the ones it is not.
  recentSessions: (projectPath) => ipcRenderer.invoke('sessions:recent', { projectPath }),

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
  setAgent: (id) => ipcRenderer.invoke('config:agent', id),
  pickFolder: (title, defaultPath) => ipcRenderer.invoke('config:pick', { title, defaultPath }),
  reveal: (target) => ipcRenderer.invoke('config:reveal', { target }),

  usage: () => ipcRenderer.invoke('usage:get'),
  agentUsage: (id) => ipcRenderer.invoke('usage:agent', id),

  // What the machine is doing, and what the terminals have running underneath
  // them. The cheap half is polled; the expensive half is only measured between
  // start() and stop(), which the panel calls as it opens and closes.
  system: () => ipcRenderer.invoke('system:stats'),
  processes: {
    start: () => ipcRenderer.invoke('processes:start'),
    stop: () => ipcRenderer.invoke('processes:stop'),
    gpu: (on) => ipcRenderer.invoke('processes:gpu', { on }),
    onView: (cb) => ipcRenderer.on('processes:view', (_e, payload) => cb(payload)),
  },

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
