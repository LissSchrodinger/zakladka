const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('db', {
  getState: call('get-state'),
  addEntry: call('add-entry'),
  updateEntry: (id, patch) => ipcRenderer.invoke('update-entry', { id, patch }),
  deleteEntry: call('delete-entry'),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', { id, patch }),
  addProject: call('add-project'),
  deleteProject: call('delete-project'),
  setHours: (date, manual) => ipcRenderer.invoke('set-hours', { date, manual }),
  updateSettings: call('update-settings'),
  setIcs: call('set-ics'),
  exportProject: call('export-project'),
  openUrl: call('open-url'),
  checkUpdates: call('check-updates'),
  installUpdate: call('install-update'),
  refreshCalendar: call('refresh-calendar'),
  closeCapture: () => ipcRenderer.send('capture-close'),
  resizeCapture: (h) => ipcRenderer.send('capture-resize', h),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onCaptureOpen: (cb) => ipcRenderer.on('capture-open', (_e, s) => cb(s)),
  onGo: (cb) => ipcRenderer.on('go', (_e, v) => cb(v)),
});
