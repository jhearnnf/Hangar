'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', { name }),
  create: (opts) => ipcRenderer.invoke('pty:create', opts),
  write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
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

  onData: (cb) => ipcRenderer.on('pty:data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, payload) => cb(payload)),

  // Electron's clipboard rather than navigator.clipboard, which needs a
  // secure context we don't have under file://.
  copy: (text) => clipboard.writeText(text),
  paste: () => clipboard.readText(),
});
