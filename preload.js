const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zk', {
  getData: () => ipcRenderer.invoke('get-data'),
  getMeta: () => ipcRenderer.invoke('get-meta'),
  addEntry: (p) => ipcRenderer.invoke('add-entry', p),
  updateEntry: (id, patch) => ipcRenderer.invoke('update-entry', { id, patch }),
  deleteEntry: (id) => ipcRenderer.invoke('delete-entry', id),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', { id, patch }),
  addProject: (name) => ipcRenderer.invoke('add-project', name),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  moveProject: (id, dir) => ipcRenderer.invoke('move-project', { id, dir }),
  exportProject: (id) => ipcRenderer.invoke('export-project', id),
  closeCapture: () => ipcRenderer.send('capture-close'),
  resizeCapture: (h) => ipcRenderer.send('capture-resize', h),
  onData: (cb) => ipcRenderer.on('data', (_e, d) => cb(d)),
  onCaptureOpen: (cb) => ipcRenderer.on('capture-open', (_e, d) => cb(d)),
  onSelectProject: (cb) => ipcRenderer.on('select-project', (_e, id) => cb(id)),
});
