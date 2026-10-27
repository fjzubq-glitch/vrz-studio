'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vrl', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id, systemAudio) => ipcRenderer.invoke('capture:select', { id, systemAudio }),
  saveRecording: (buffer, meta) => ipcRenderer.invoke('recording:save', { buffer, meta }),
  recordingBegin: () => ipcRenderer.invoke('recording:begin'),
  recordingChunk: (id, chunk) => ipcRenderer.invoke('recording:chunk', { id, chunk }),
  recordingFinish: (id, meta) => ipcRenderer.invoke('recording:finish', { id, meta }),
  recordingCancel: (id) => ipcRenderer.invoke('recording:cancel', id),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  renameRecording: (file, title) => ipcRenderer.invoke('library:rename', { file, title }),
  deleteRecording: (file) => ipcRenderer.invoke('library:delete', { file }),
  revealRecording: (file) => ipcRenderer.invoke('library:reveal', { file }),
  openFile: (file) => ipcRenderer.invoke('library:open-file', { file }),
  info: () => ipcRenderer.invoke('app:info'),
  openFolder: () => ipcRenderer.invoke('app:open-folder'),
  winControl: (action) => ipcRenderer.invoke('win:control', action),
  selfTestDone: (result) => ipcRenderer.invoke('selftest:done', result),
  watchMicHold: (active) => ipcRenderer.invoke('mic-hold:watch', active),
  onToggleRecord: (callback) => {
    ipcRenderer.on('shortcut:toggle-record', () => callback());
  },
  onMicHoldStart: (callback) => {
    ipcRenderer.on('shortcut:mic-hold-start', () => callback());
  },
  onMicHoldEnd: (callback) => {
    ipcRenderer.on('shortcut:mic-hold-end', () => callback());
  },
  recordingState: (state) => ipcRenderer.invoke('floating:state', state),
  onFloatingAction: (callback) => {
    ipcRenderer.on('floating:action', (_event, action) => callback(action));
  },
});
