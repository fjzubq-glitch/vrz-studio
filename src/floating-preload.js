'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  onState: (callback) => {
    ipcRenderer.on('floating:state', (_event, state) => callback(state));
  },
  getState: () => ipcRenderer.invoke('floating:get-state'),
  action: (name) => ipcRenderer.send('floating:action', name),
  restore: () => ipcRenderer.invoke('floating:restore'),
});
