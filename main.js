const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, screen, net, dialog, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOTKEY = 'CommandOrControl+Shift+Space';
const REPO = 'LissSchrodinger/zakladka';
const ASSET = 'Zakladka-arm64.zip';
const COLORS = ['#7C5CFF', '#FF8A3D', '#22B07D', '#2F80ED', '#E5484D', '#D6A100', '#E054B5', '#6B7280'];

let tray = null;
let mainWin = null;
let captureWin = null;
let dataPath;
let data;

// ---------- data ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function defaultData() {
  const names = ['Проект 1', 'Проект 2', 'Проект 3', 'Личное'];
  const projects = names.map((name, i) => ({ id: uid() + i, name, color: COLORS[i], status: '', statusUpdated: null }));
  return { projects, entries: [], lastProjectId: projects[0].id, lastType: 'task' };
}

function load() {
  try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch { data = defaultData(); persist(); }
}

function persist() {
  const tmp = dataPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dataPath);
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('data', data);
  updateTrayMenu();
}

// ---------- export ----------
const TYPE_TITLES = { task: 'Открытые задачи', question: 'Открытые вопросы', idea: 'Идеи' };

function projectMarkdown(p) {
  const list = data.entries.filter(e => e.projectId === p.id);
  let md = `# Контекст проекта «${p.name}»\n\n`;
  md += `## Где я остановилась\n${p.status ? p.status.trim() : '—'}\n`;
  for (const t of ['task', 'question', 'idea']) {
    const open = list.filter(e => e.type === t && !e.done);
    if (open.length) md += `\n## ${TYPE_TITLES[t]}\n` + open.map(e => `- ${e.text}`).join('\n') + '\n';
  }
  const done = list.filter(e => e.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 10);
  if (done.length) md += `\n## Недавно закрыто\n` + done.map(e => `- ${e.text}`).join('\n') + '\n';
  return md;
}

function allStatusesMarkdown() {
  return '# Где я остановилась — по всем проектам\n\n' + data.projects.map(p => {
    const open = data.entries.filter(e => e.projectId === p.id && e.type === 'task' && !e.done).length;
    return `## ${p.name}\n${p.status ? p.status.trim() : '—'}\nОткрытых задач: ${open}\n`;
  }).join('\n');
}

// ---------- windows ----------
function createMain() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 920, height: 640, minWidth: 720, minHeight: 480,
    title: 'Закладка',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'main.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  if (process.platform === 'darwin') app.dock.show();
  mainWin.on('closed', () => { mainWin = null; if (process.platform === 'darwin') app.dock.hide(); });
}

function createCapture() {
  captureWin = new BrowserWindow({
    width: 620, height: 210,
    frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, show: false, fullscreenable: false,
    vibrancy: 'hud', visualEffectState: 'active', roundedCorners: true,
    hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  captureWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  captureWin.loadFile(path.join(__dirname, 'ui', 'capture.html'));
  captureWin.on('blur', () => hideCapture(false));
}

function showCapture() {
  if (!captureWin || captureWin.isDestroyed()) createCapture();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [w] = captureWin.getSize();
  captureWin.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.22));
  captureWin.webContents.send('capture-open', data);
  captureWin.show();
  captureWin.focus();
}

function hideCapture(returnFocus = true) {
  if (!captureWin || captureWin.isDestroyed() || !captureWin.isVisible()) return;
  captureWin.hide();
  // вернуть фокус в приложение, из которого вызвали, если главное окно не открыто
  if (returnFocus && process.platform === 'darwin' && !(mainWin && mainWin.isVisible())) app.hide();
}


// ---------- updates ----------
let update = null;      // { version, url }
let updateState = '';   // '', 'checking', 'downloading', 'error', 'latest'

const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

async function checkForUpdates(manual = false) {
  updateState = 'checking'; updateTrayMenu();
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Zakladka' } });
    if (!res.ok) throw new Error('GitHub ответил ' + res.status);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find(a => a.name === ASSET);
    if (asset && newer(version, app.getVersion())) {
      update = { version, url: asset.browser_download_url, notes: rel.body || '' };
      updateState = '';
      if (manual) installUpdate();
    } else {
      update = null; updateState = 'latest';
      if (manual) dialog.showMessageBox({ message: 'У тебя последняя версия', detail: 'Закладка ' + app.getVersion() });
    }
  } catch (err) {
    updateState = 'error';
    if (manual) dialog.showMessageBox({ type: 'warning', message: 'Не получилось проверить обновления', detail: String(err.message || err) });
  }
  updateTrayMenu();
}

async function installUpdate() {
  if (!update) return;
  const appPath = path.resolve(process.execPath, '../../..'); // .../Zakladka.app
  if (!appPath.endsWith('.app')) { shell.openExternal(`https://github.com/${REPO}/releases/latest`); return; }
  const { response } = await dialog.showMessageBox({
    message: `Обновить Закладку до ${update.version}?`,
    detail: (update.notes ? update.notes.slice(0, 600) + '\n\n' : '') + 'Приложение перезапустится. Записи сохранятся.',
    buttons: ['Обновить', 'Позже'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return;
  updateState = 'downloading'; updateTrayMenu();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zakladka-'));
    const zip = path.join(dir, ASSET);
    const res = await net.fetch(update.url);
    if (!res.ok) throw new Error('Скачивание: ' + res.status);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dir]);
    const fresh = path.join(dir, 'Zakladka.app');
    if (!fs.existsSync(fresh)) throw new Error('В архиве нет Zakladka.app');
    const script = `
      while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
      rm -rf "${appPath}"
      /usr/bin/ditto "${fresh}" "${appPath}"
      /usr/bin/xattr -cr "${appPath}"
      /usr/bin/open "${appPath}"
      rm -rf "${dir}"`;
    spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  } catch (err) {
    updateState = 'error'; updateTrayMenu();
    dialog.showMessageBox({ type: 'warning', message: 'Обновление не установилось', detail: String(err.message || err) });
  }
}

function updateMenuItem() {
  if (updateState === 'downloading') return { label: 'Скачиваю обновление…', enabled: false };
  if (update) return { label: `⬆︎ Обновить до ${update.version}`, click: installUpdate };
  if (updateState === 'checking') return { label: 'Проверяю обновления…', enabled: false };
  return { label: 'Проверить обновления', click: () => checkForUpdates(true) };
}

// ---------- tray ----------
function updateTrayMenu() {
  if (!tray) return;
  const statusItems = data.projects.map(p => ({
    label: `${p.name}${p.status ? ' — ' + p.status.split('\n')[0].slice(0, 40) : ''}`,
    click: () => { createMain(); setTimeout(() => mainWin && mainWin.webContents.send('select-project', p.id), 300); },
  }));
  const menu = Menu.buildFromTemplate([
    ...(update ? [updateMenuItem(), { type: 'separator' }] : []),
    { label: 'Быстрая запись', accelerator: HOTKEY, click: showCapture },
    { label: 'Открыть Закладку', click: createMain },
    { type: 'separator' },
    { label: 'Где я остановилась', enabled: false },
    ...statusItems,
    { type: 'separator' },
    { label: 'Скопировать статусы всех проектов', click: () => clipboard.writeText(allStatusesMarkdown()) },
    { type: 'separator' },
    {
      label: 'Запускать при входе в систему', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    ...(update ? [] : [updateMenuItem()]),
    { label: `Версия ${app.getVersion()}`, enabled: false },
    { label: 'Выйти', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Закладка');
  updateTrayMenu();
}

// ---------- ipc ----------
ipcMain.handle('get-data', () => data);
ipcMain.handle('get-meta', () => ({ colors: COLORS, hotkey: '⌘⇧Space' }));

ipcMain.handle('add-entry', (_e, { projectId, type, text }) => {
  text = (text || '').trim();
  if (!text) return;
  if (type === 'status') {
    const p = data.projects.find(p => p.id === projectId);
    if (p) { p.status = text; p.statusUpdated = Date.now(); }
  } else {
    data.entries.push({ id: uid(), projectId, type, text, done: false, created: Date.now() });
  }
  data.lastProjectId = projectId;
  data.lastType = type;
  persist(); broadcast();
});

ipcMain.handle('update-entry', (_e, { id, patch }) => {
  const en = data.entries.find(e => e.id === id);
  if (!en) return;
  Object.assign(en, patch);
  if ('done' in patch) en.doneAt = patch.done ? Date.now() : null;
  persist(); broadcast();
});

ipcMain.handle('delete-entry', (_e, id) => {
  data.entries = data.entries.filter(e => e.id !== id);
  persist(); broadcast();
});

ipcMain.handle('update-project', (_e, { id, patch }) => {
  const p = data.projects.find(p => p.id === id);
  if (!p) return;
  Object.assign(p, patch);
  if ('status' in patch) p.statusUpdated = Date.now();
  persist(); broadcast();
});

ipcMain.handle('add-project', (_e, name) => {
  const p = { id: uid(), name: name || 'Новый проект', color: COLORS[data.projects.length % COLORS.length], status: '', statusUpdated: null };
  data.projects.push(p);
  persist(); broadcast();
  return p.id;
});

ipcMain.handle('delete-project', (_e, id) => {
  data.projects = data.projects.filter(p => p.id !== id);
  data.entries = data.entries.filter(e => e.projectId !== id);
  if (data.lastProjectId === id) data.lastProjectId = data.projects[0] && data.projects[0].id;
  persist(); broadcast();
});

ipcMain.handle('move-project', (_e, { id, dir }) => {
  const i = data.projects.findIndex(p => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= data.projects.length) return;
  [data.projects[i], data.projects[j]] = [data.projects[j], data.projects[i]];
  persist(); broadcast();
});

ipcMain.handle('export-project', (_e, id) => {
  const p = data.projects.find(p => p.id === id);
  if (p) clipboard.writeText(projectMarkdown(p));
});

ipcMain.on('capture-close', () => hideCapture(true));
ipcMain.on('capture-resize', (_e, h) => { if (captureWin) captureWin.setSize(620, Math.round(h)); });

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', createMain);

app.whenReady().then(() => {
  dataPath = path.join(app.getPath('userData'), 'zakladka.json');
  load();
  if (process.platform === 'darwin') app.dock.hide();
  createTray();
  createCapture();
  if (!globalShortcut.register(HOTKEY, showCapture)) console.error('Hotkey busy:', HOTKEY);
  if (!data.welcomed) { data.welcomed = true; persist(); createMain(); }
  setTimeout(() => checkForUpdates(false), 5000);
  setInterval(() => checkForUpdates(false), 6 * 3600e3);
  if (process.env.ZK_SHOW_CAPTURE) setTimeout(showCapture, 800);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', createMain);
app.on('will-quit', () => globalShortcut.unregisterAll());
