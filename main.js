const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, screen, net, dialog, shell, Notification, safeStorage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const FACTS = require('./facts');

app.setName('Daybook');

const HOTKEY = 'CommandOrControl+Shift+Space';
const REPO = 'LissSchrodinger/zakladka';
const ASSET = 'Daybook-arm64.zip';
const DATA_DIR = process.env.DAYBOOK_DIR || path.join(os.homedir(), 'Daybook');
const DATA_FILE = path.join(DATA_DIR, 'daybook.json');
const PALETTE = ['#7FE3E8', '#A98BFF', '#4FD1A5', '#6C8BFF', '#7CC8F2', '#E57AB8', '#F0C977', '#9AA4BF'];
const KNOWN_COLORS = { 'Академия': '#7FE3E8', 'УрФУ': '#A98BFF', 'Цитробот': '#4FD1A5', 'Биржа': '#6C8BFF', 'Квантастика': '#7CC8F2', 'Личное': '#E57AB8' };

let tray = null, mainWin = null, captureWin = null;
let data;
let calendar = { events: [], error: null, updated: null };
let ignoreWatchUntil = 0;

// ---------------- data ----------------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function defaultSettings() {
  return {
    limeProject: null, limeRate: 20, dayNorm: 8,
    urfuMonthRub: 150000, urfuFrom: 9, urfuTo: 18, urfuStart: '2026-10-08',
    reminderTime: '20:00', currency: 'usd',
    rates: { rub: 80, gel: 2.7, updated: null },
    icsEnc: null,
  };
}

function project(name, i) {
  return { id: uid() + i, name, color: KNOWN_COLORS[name] || PALETTE[i % PALETTE.length], status: '', statusUpdated: null };
}

function freshData() {
  const projects = ['Академия', 'УрФУ', 'Цитробот', 'Биржа', 'Квантастика', 'Личное'].map(project);
  return { version: 2, projects, entries: [], hours: {}, settings: { ...defaultSettings(), limeProject: projects[0].id }, lastProjectId: projects[0].id, lastType: 'task' };
}

function migrateFromZakladka() {
  const old = process.env.ZAKLADKA_FILE || path.join(app.getPath('appData'), 'Zakladka', 'zakladka.json');
  if (!fs.existsSync(old)) return null;
  try {
    const o = JSON.parse(fs.readFileSync(old, 'utf8'));
    const projects = (o.projects || []).map((p, i) => ({ ...p, color: KNOWN_COLORS[p.name] || PALETTE[i % PALETTE.length] }));
    if (!projects.some((p) => p.name === 'Квантастика')) projects.splice(Math.max(projects.length - 1, 0), 0, project('Квантастика', projects.length));
    const lime = projects.find((p) => /академ|лайм/i.test(p.name)) || projects[0];
    return { version: 2, projects, entries: o.entries || [], hours: {}, settings: { ...defaultSettings(), limeProject: lime && lime.id },
      lastProjectId: o.lastProjectId || (projects[0] && projects[0].id), lastType: o.lastType || 'task', migratedFrom: 'zakladka' };
  } catch (e) { console.error('migration failed', e); return null; }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { fs.copyFileSync(DATA_FILE, DATA_FILE + '.broken-' + Date.now()); data = freshData(); }
  } else {
    data = migrateFromZakladka() || freshData();
  }
  data.settings = { ...defaultSettings(), ...(data.settings || {}) };
  data.hours = data.hours || {};
  data.entries = data.entries || [];
  persist();
  backup();
}

function backup() {
  try {
    const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `daybook-${dayKey()}.json`);
    if (!fs.existsSync(f)) fs.copyFileSync(DATA_FILE, f);
    const all = fs.readdirSync(dir).filter((x) => /^daybook-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    all.slice(0, Math.max(0, all.length - 7)).forEach((x) => fs.unlinkSync(path.join(dir, x)));
  } catch (e) { console.error('backup', e); }
}

// Входящие: сюда Claude (или задача по расписанию) кладёт JSON-файлы, приложение их забирает.
// Формат: { "hours": { "2026-11-16": { "yt": 3, "sheet": 1 } }, "entries": [ { "project": "Академия", "type": "task", "text": "…" } ], "status": { "Академия": "…" } }
function processInbox() {
  const dir = path.join(DATA_DIR, 'inbox');
  try { fs.mkdirSync(path.join(dir, 'processed'), { recursive: true }); } catch {}
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
  if (!files.length) return;
  mutate(() => {
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        for (const [k, h] of Object.entries(j.hours || {})) {
          const cur = data.hours[k] || {};
          for (const src of ['yt', 'sheet', 'manual']) if (typeof h[src] === 'number') cur[src] = Math.max(0, h[src]);
          if ((typeof h.yt === 'number' || typeof h.sheet === 'number') && typeof h.manual !== 'number') delete cur.manual;
          cur.syncedAt = Date.now(); data.hours[k] = cur;
        }
        const byName = (n) => data.projects.find((p) => p.id === n || p.name.toLowerCase() === String(n || '').toLowerCase());
        for (const e of j.entries || []) {
          const p = byName(e.project) || data.projects[0]; if (!p || !e.text) continue;
          if (e.ext) { const ex = data.entries.find((x) => x.ext === e.ext); if (ex) { ex.text = String(e.text); if (e.url) ex.url = e.url; continue; } }
          data.entries.push({ id: uid(), projectId: p.id, type: e.type || 'task', text: String(e.text), url: e.url || undefined, ext: e.ext || undefined, done: false, created: Date.now(), from: 'claude' });
        }
        for (const [n, st] of Object.entries(j.status || {})) { const p = byName(n); if (p) { p.status = String(st); p.statusUpdated = Date.now(); } }
        fs.renameSync(full, path.join(dir, 'processed', `${Date.now()}-${f}`));
      } catch (e) { console.error('inbox', f, e); }
    }
  });
}

function persist() {
  ignoreWatchUntil = Date.now() + 1500;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function watchFile() {
  fs.watchFile(DATA_FILE, { interval: 1500 }, () => {
    if (Date.now() < ignoreWatchUntil) return;
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); broadcast(); } catch {}
  });
}

function getIcsUrl() {
  const enc = data.settings.icsEnc;
  if (!enc) return null;
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : Buffer.from(enc, 'base64').toString(); }
  catch { return null; }
}

function publicState() {
  const { icsEnc, ...settings } = data.settings;
  const day = Math.floor((Date.now() - new Date(2026, 0, 1)) / 864e5);
  return {
    ...data, settings: { ...settings, hasCalendar: !!icsEnc },
    calendar, fact: FACTS[((day % FACTS.length) + FACTS.length) % FACTS.length], facts: FACTS, factIndex: ((day % FACTS.length) + FACTS.length) % FACTS.length,
    version: app.getVersion(), update: update ? update.version : null, hotkey: '⌘⇧Space',
  };
}

function broadcast() {
  const s = publicState();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('state', s);
  updateTrayMenu();
}

function mutate(fn) { fn(); persist(); broadcast(); }

// ---------------- rates ----------------
async function refreshRates() {
  try {
    const r = await net.fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    if (j && j.rates && j.rates.RUB && j.rates.GEL) mutate(() => { data.settings.rates = { rub: j.rates.RUB, gel: j.rates.GEL, updated: Date.now() }; });
  } catch (e) { /* остаёмся на прошлом курсе */ }
}

// ---------------- calendar ----------------
async function refreshCalendar() {
  const url = getIcsUrl();
  if (!url) { calendar = { events: [], error: null, updated: null }; broadcast(); return; }
  try {
    const ical = require('node-ical');
    const res = await net.fetch(url.replace(/^webcal:/, 'https:'));
    if (!res.ok) throw new Error('Календарь ответил ' + res.status);
    const parsed = ical.sync.parseICS(await res.text());
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 864e5);
    const out = [];
    const push = (ev, s, e) => {
      const blob = String(ev.location || '') + ' ' + String(ev.description || '');
      const meet = blob.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
      out.push({ title: String(ev.summary || 'Без названия'), start: new Date(s).toISOString(), end: new Date(e || s).toISOString(), allDay: ev.datetype === 'date', url: meet ? meet[0] : null });
    };
    for (const ev of Object.values(parsed)) {
      if (ev.type !== 'VEVENT' || ev.status === 'CANCELLED') continue;
      const dur = ev.end && ev.start ? ev.end - ev.start : 0;
      if (ev.rrule) {
        // rrule отдаёт «плавающее» время: берём только сдвиг в днях от исходного начала
        const origin = ev.rrule.origOptions.dtstart || ev.start;
        const ex = new Set(Object.values(ev.exdate || {}).map((d) => dayKey(new Date(d))));
        const ovs = Object.values(ev.recurrences || {});
        for (const d of ev.rrule.between(new Date(start.getTime() - 2 * 864e5), new Date(end.getTime() + 864e5), true)) {
          const occ = new Date(+ev.start + Math.round((d - origin) / 864e5) * 864e5);
          if (ex.has(dayKey(occ))) continue;
          const ov = ovs.find((r) => r.recurrenceid && dayKey(new Date(r.recurrenceid)) === dayKey(occ));
          if (ov) { if (ov.status !== 'CANCELLED') push(ov, ov.start, ov.end); continue; }
          push(ev, occ, new Date(+occ + dur));
        }
      } else if (ev.start && ev.start < end && (ev.end || ev.start) >= start) {
        push(ev, ev.start, ev.end);
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    calendar = { events: out.filter((e) => new Date(e.end) >= start && new Date(e.start) < end), error: null, updated: Date.now() };
  } catch (e) {
    calendar = { ...calendar, error: String(e.message || e) };
  }
  broadcast();
}

// ---------------- reminders ----------------
const notified = new Set();
const fmtH = (h) => String(Math.round(h * 10) / 10).replace('.', ',') + '\u00A0ч';
// «Вручную» — это поправленный итог дня: если он есть, он главнее собранных часов
function hoursOn(key) { const h = data.hours[key] || {}; return typeof h.manual === 'number' ? h.manual : (h.yt || 0) + (h.sheet || 0); }

function checkReminder() {
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return;
  const [rh, rm] = data.settings.reminderTime.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const slot of [rh * 60 + rm, rh * 60 + rm + 60]) {
    const id = dayKey(now) + '@' + slot;
    if (mins < slot || mins > slot + 5 || notified.has(id)) continue;
    notified.add(id);
    const h = hoursOn(dayKey(now)), norm = data.settings.dayNorm;
    if (h >= norm) {
      if (slot !== rh * 60 + rm) continue;
      const closed = data.entries.filter((e) => e.done && e.doneAt && dayKey(new Date(e.doneAt)) === dayKey(now)).length;
      new Notification({ title: 'Daybook · итог дня', body: `Сегодня: ${fmtH(h)} · $${Math.round(h * data.settings.limeRate)} · закрыто задач: ${closed}. Можно отдыхать.` }).show();
      continue;
    }
    const n = new Notification({ title: 'Daybook · часы Лайма', body: h ? `Внесено ${fmtH(h)} из ${norm}. Допиши часы в YouTrack или таблицу.` : 'Сегодня часов пока нет. Внеси до конца дня.' });
    n.on('click', () => { createMain(); setTimeout(() => mainWin && mainWin.webContents.send('go', 'income'), 400); });
    n.show();
  }
}

// ---------------- export ----------------
const TITLES = { task: 'Открытые задачи', question: 'Открытые вопросы', idea: 'Идеи', link: 'Ссылки', person: 'Люди' };
function projectMarkdown(p) {
  const list = data.entries.filter((e) => e.projectId === p.id);
  let md = `# Контекст проекта «${p.name}»\n\n## Где я остановилась\n${(p.status || '—').trim()}\n`;
  for (const t of ['task', 'question', 'idea', 'link', 'person']) {
    const open = list.filter((e) => e.type === t && !e.done);
    if (open.length) md += `\n## ${TITLES[t]}\n` + open.map((e) => `- ${e.title ? e.title + ' — ' : ''}${e.text}`).join('\n') + '\n';
  }
  return md;
}

// ---------------- windows ----------------
function createMain() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 1240, height: 860, minWidth: 900, minHeight: 640, title: 'Daybook',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#05060B', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'app.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  if (process.platform === 'darwin') app.dock.show();
  mainWin.on('closed', () => { mainWin = null; if (process.platform === 'darwin') app.dock.hide(); });
}

function createCapture() {
  captureWin = new BrowserWindow({
    width: 640, height: 200, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, fullscreenable: false,
    vibrancy: 'hud', visualEffectState: 'active', roundedCorners: true, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  captureWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  captureWin.loadFile(path.join(__dirname, 'ui', 'capture.html'));
  captureWin.on('blur', () => hideCapture(false));
}

function showCapture() {
  if (!captureWin || captureWin.isDestroyed()) createCapture();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = d.workArea;
  captureWin.setPosition(Math.round(x + (width - 640) / 2), Math.round(y + height * 0.22));
  captureWin.webContents.send('capture-open', publicState());
  captureWin.show(); captureWin.focus();
}

function hideCapture(returnFocus = true) {
  if (!captureWin || captureWin.isDestroyed() || !captureWin.isVisible()) return;
  captureWin.hide();
  if (returnFocus && process.platform === 'darwin' && !(mainWin && mainWin.isVisible())) app.hide();
}

function msgBox(opts) { return mainWin && !mainWin.isDestroyed() ? dialog.showMessageBox(mainWin, opts) : dialog.showMessageBox(opts); }

// ---------------- updates ----------------
let update = null, updateState = '';
const newer = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); return false; };

async function checkForUpdates(manual = false) {
  updateState = 'checking'; updateTrayMenu();
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Daybook' } });
    if (!res.ok) throw new Error('GitHub ответил ' + res.status);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => a.name === ASSET);
    if (asset && newer(version, app.getVersion())) {
      update = { version, url: asset.browser_download_url, notes: rel.body || '' }; updateState = '';
      if (manual) installUpdate();
    } else {
      update = null; updateState = 'latest';
      if (manual) msgBox({ message: 'У тебя последняя версия', detail: 'Daybook ' + app.getVersion() });
    }
  } catch (err) {
    updateState = 'error';
    if (manual) msgBox({ type: 'warning', message: 'Не получилось проверить обновления', detail: String(err.message || err) });
  }
  broadcast();
}

async function installUpdate() {
  if (!update) return;
  const appPath = path.resolve(process.execPath, '../../..');
  if (!appPath.endsWith('.app')) { shell.openExternal(`https://github.com/${REPO}/releases/latest`); return; }
  const { response } = await msgBox({
    message: `Обновить Daybook до ${update.version}?`,
    detail: (update.notes ? update.notes.slice(0, 600) + '\n\n' : '') + 'Приложение перезапустится. Записи сохранятся.',
    buttons: ['Обновить', 'Позже'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return;
  updateState = 'downloading'; updateTrayMenu();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-'));
    const zip = path.join(dir, ASSET);
    const res = await net.fetch(update.url);
    if (!res.ok) throw new Error('Скачивание: ' + res.status);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dir]);
    const fresh = path.join(dir, 'Daybook.app');
    if (!fs.existsSync(fresh)) throw new Error('В архиве нет Daybook.app');
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
    msgBox({ type: 'warning', message: 'Обновление не установилось', detail: String(err.message || err) });
  }
}

// ---------------- tray ----------------
function updateTrayMenu() {
  if (!tray) return;
  const updItem = update ? { label: `⬆︎ Обновить до ${update.version}`, click: installUpdate }
    : updateState === 'checking' ? { label: 'Проверяю обновления…', enabled: false }
    : updateState === 'downloading' ? { label: 'Скачиваю обновление…', enabled: false }
    : { label: 'Проверить обновления', click: () => checkForUpdates(true) };
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(update ? [updItem, { type: 'separator' }] : []),
    { label: 'Быстрая запись', accelerator: HOTKEY, click: showCapture },
    { label: 'Открыть Daybook', click: createMain },
    { type: 'separator' },
    { label: `Лайм сегодня: ${fmtH(hoursOn(dayKey()))} из ${data.settings.dayNorm}`, enabled: false },
    { label: 'Скопировать статусы всех проектов', click: () => clipboard.writeText(data.projects.map((p) => `## ${p.name}\n${p.status || '—'}`).join('\n\n')) },
    { type: 'separator' },
    { label: 'Запускать при входе в систему', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    ...(update ? [] : [updItem]),
    { label: `Версия ${app.getVersion()}`, enabled: false },
    { label: 'Выйти', role: 'quit' },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Daybook');
  updateTrayMenu();
}

// ---------------- ipc ----------------
async function fetchTitle(entryId, url) {
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 6000);
    const res = await net.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 Daybook' } });
    const html = (await res.text()).slice(0, 200000);
    const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (m) mutate(() => { const e = data.entries.find((x) => x.id === entryId); if (e && !e.title) e.title = m[1].replace(/\s+/g, ' ').trim(); });
  } catch {}
}

ipcMain.handle('get-state', () => publicState());
ipcMain.handle('add-entry', (_e, { projectId, type, text }) => {
  text = (text || '').trim(); if (!text) return;
  let newId = null;
  mutate(() => {
    if (type === 'status') {
      const p = data.projects.find((x) => x.id === projectId);
      if (p) { p.status = text; p.statusUpdated = Date.now(); }
    } else {
      newId = uid();
      data.entries.push({ id: newId, projectId, type, text, done: false, created: Date.now() });
    }
    data.lastProjectId = projectId; data.lastType = type;
  });
  if (type === 'link' && /^https?:\/\//.test(text)) fetchTitle(newId, text);
});
ipcMain.handle('update-entry', (_e, { id, patch }) => mutate(() => {
  const en = data.entries.find((x) => x.id === id); if (!en) return;
  Object.assign(en, patch); if ('done' in patch) en.doneAt = patch.done ? Date.now() : null;
}));
ipcMain.handle('restore-entry', (_e, entry) => mutate(() => { if (entry && entry.id && !data.entries.some((x) => x.id === entry.id)) data.entries.push(entry); }));
ipcMain.handle('delete-entry', (_e, id) => mutate(() => { data.entries = data.entries.filter((x) => x.id !== id); }));
ipcMain.handle('update-project', (_e, { id, patch }) => mutate(() => {
  const p = data.projects.find((x) => x.id === id); if (!p) return;
  Object.assign(p, patch); if ('status' in patch) p.statusUpdated = Date.now();
}));
ipcMain.handle('add-project', (_e, name) => { const p = project(name || 'Новый проект', data.projects.length); mutate(() => data.projects.push(p)); return p.id; });
ipcMain.handle('delete-project', (_e, id) => mutate(() => {
  data.projects = data.projects.filter((p) => p.id !== id);
  data.entries = data.entries.filter((e) => e.projectId !== id);
}));
ipcMain.handle('set-hours', (_e, { date, manual }) => mutate(() => {
  const k = date || dayKey(); const cur = { ...(data.hours[k] || {}) }; if (manual === '' || manual === null || manual === undefined) delete cur.manual; else cur.manual = Math.max(0, Number(manual) || 0); data.hours[k] = cur;
}));
ipcMain.handle('update-settings', (_e, patch) => mutate(() => { Object.assign(data.settings, patch); }));
ipcMain.handle('set-ics', async (_e, url) => {
  url = (url || '').trim();
  mutate(() => {
    data.settings.icsEnc = url ? (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(url).toString('base64') : Buffer.from(url).toString('base64')) : null;
  });
  await refreshCalendar();
});
ipcMain.handle('export-project', (_e, id) => { const p = data.projects.find((x) => x.id === id); if (p) clipboard.writeText(projectMarkdown(p)); });
ipcMain.handle('open-url', (_e, url) => { if (/^(https?|tg):\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('check-updates', () => checkForUpdates(true));
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('refresh-calendar', () => refreshCalendar());
ipcMain.on('capture-close', () => hideCapture(true));
ipcMain.on('open-search', (_e, q) => { hideCapture(false); createMain(); setTimeout(() => mainWin && mainWin.webContents.send('search', q), 400); });
ipcMain.on('capture-resize', (_e, h) => { if (captureWin) captureWin.setSize(640, Math.round(h)); });

// ---------------- lifecycle ----------------
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', createMain);

app.whenReady().then(() => {
  load();
  watchFile();
  if (process.platform === 'darwin') app.dock.hide();
  createTray();
  createCapture();
  if (!globalShortcut.register(HOTKEY, showCapture)) console.error('Hotkey busy:', HOTKEY);
  createMain();
  refreshRates(); setInterval(refreshRates, 6 * 3600e3);
  refreshCalendar(); setInterval(refreshCalendar, 10 * 60e3);
  processInbox(); setInterval(processInbox, 20e3);
  setInterval(backup, 3600e3);
  setInterval(checkReminder, 60e3);
  setInterval(broadcast, 60e3);
  setTimeout(() => checkForUpdates(false), 5000); setInterval(() => checkForUpdates(false), 6 * 3600e3);
  if (process.env.ZK_SHOW_CAPTURE) setTimeout(showCapture, 800);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', createMain);
app.on('will-quit', () => globalShortcut.unregisterAll());
