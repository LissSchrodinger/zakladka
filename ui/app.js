const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SYM = { usd: '$', rub: '₽', gel: '₾' };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const TYPES = [['task', 'Задача', 'Что нужно сделать…'], ['question', 'Вопрос', 'Что спросить или выяснить…'], ['idea', 'Идея', 'Что пришло в голову…'], ['status', 'Где остановилась', 'На чём остановилась и что дальше…'], ['link', 'Ссылка', 'Вставь ссылку'], ['person', 'Человек', 'Имя, роль и @telegram']];
const TABS = [['task', 'Задачи'], ['question', 'Вопросы'], ['idea', 'Идеи'], ['link', 'Ссылки'], ['person', 'Люди']];

let S = null;
const ui = { q: '', kind: 'all', tag: null, view: 'today', project: null, tab: 'task', draft: '', type: 'task', target: null, editHours: null, cur: null, pending: false };

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const hoursOn = (k) => { const h = S.hours[k] || {}; return (h.yt || 0) + (h.sheet || 0) + (h.manual || 0); };
const fmtH = (h) => String(Math.round(h * 10) / 10).replace('.', ',') + '\u00A0ч';
const cur = () => ui.cur || S.settings.currency || 'usd';
function money(usd, c = cur(), digits = 0) {
  const r = c === 'usd' ? 1 : S.settings.rates[c];
  const v = (usd * r).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return c === 'usd' ? '$' + v : v + ' ' + SYM[c];
}
const rub = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
function ago(ts) {
  if (!ts) return 'ещё не заполнено';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24); return d === 1 ? 'вчера' : `${d} дн назад`;
}
function workdaysIn(y, m) { let n = 0; for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) if (!isWeekend(new Date(y, m, d))) n++; return n; }
function proj(id) { return S.projects.find((p) => p.id === id); }
let undoFn = null;
function toast(t, undo) {
  const el = $('#toast'); undoFn = undo || null;
  el.innerHTML = esc(t) + (undo ? ' <button data-act="undo" style="margin-left:10px;color:var(--cyan);font-weight:500">Вернуть</button>' : '');
  el.style.pointerEvents = undo ? 'auto' : 'none';
  el.classList.add('show'); clearTimeout(el._h); el._h = setTimeout(() => { el.classList.remove('show'); undoFn = null; }, undo ? 5000 : 1800);
}

function tgLink(text) { const m = String(text).match(/@([A-Za-z0-9_]{4,})/); return m ? 'tg://resolve?domain=' + m[1] : null; }
function urlOf(text) { const m = String(text).match(/https?:\/\/\S+/); return m ? m[0] : null; }

// ---------- money model ----------
function monthStats(y = new Date().getFullYear(), m = new Date().getMonth()) {
  const today = new Date(); const isCur = y === today.getFullYear() && m === today.getMonth();
  const lastDay = isCur ? today.getDate() : new Date(y, m + 1, 0).getDate();
  const days = [];
  let hours = 0, worked = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(y, m, d), h = hoursOn(dayKey(dt));
    days.push({ d, h, we: isWeekend(dt), today: isCur && d === lastDay, key: dayKey(dt) });
    hours += h; if (!isWeekend(dt) && (!isCur || d < lastDay || h > 0)) worked++;
  }
  const rate = S.settings.limeRate, norm = S.settings.dayNorm, wd = workdaysIn(y, m);
  const earned = hours * rate;
  const avgH = worked ? hours / worked : 0;
  const forecast = avgH * wd * rate;
  const deficit = Math.max(0, worked * norm - hours);
  return { days, hours, earned, worked, avgH, forecast, deficit, wd };
}
function piggy() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), wd = workdaysIn(y, m);
  const perDay = S.settings.urfuMonthRub / wd;
  let total = 0, today = 0;
  for (let d = 1; d <= now.getDate(); d++) {
    const dt = new Date(y, m, d); if (isWeekend(dt)) continue;
    if (d < now.getDate()) { total += perDay; continue; }
    const from = S.settings.urfuFrom, to = S.settings.urfuTo, h = now.getHours() + now.getMinutes() / 60;
    today = perDay * Math.min(1, Math.max(0, (h - from) / (to - from))); total += today;
  }
  return { total, today };
}

// ---------- render ----------
function render(force) {
  if (!S) return;
  const a = document.activeElement;
  if (!force && a && (/INPUT|TEXTAREA/.test(a.tagName) || a.isContentEditable)) { ui.pending = true; return; }
  ui.pending = false;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === ui.view));
  const now = new Date();
  $('#clock').textContent = `${now.getDate()} ${MONTHS_GEN[now.getMonth()]} · ${now.toTimeString().slice(0, 5)}`;
  const upd = $('#upd'); upd.hidden = !S.update; if (S.update) upd.textContent = `Обновить до ${S.update}`;
  const v = { today: viewToday, projects: viewProjects, income: viewIncome, base: viewBase, settings: viewSettings }[ui.view]();
  $('#view').innerHTML = v;
}
document.addEventListener('focusout', () => setTimeout(() => { if (ui.pending) render(); }, 0));

function composerHtml(id) {
  const ph = (TYPES.find((t) => t[0] === ui.type) || TYPES[0])[2];
  const typing = ui.draft.length > 0;
  const chips = typing ? `<div class="chips">${TYPES.map(([k, l]) => `<button class="chip ${ui.type === k ? 'on' : ''}" data-act="type" data-k="${k}">${l}</button>`).join('')}<span class="sep"></span>${S.projects.map((p) => `<button class="chip ${ui.target === p.id ? 'on' : ''}" data-act="target" data-k="${p.id}"><span class="d" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>` : '';
  return `<section class="composer glass"><div class="row1"><input id="${id}" placeholder="${ph}" value="${esc(ui.draft)}" autocomplete="off"><button class="send ${typing ? 'ready' : ''}" data-act="save" aria-label="Записать">↵</button></div>${chips}</section>`;
}

function viewToday() {
  const now = new Date(), key = dayKey(now), h = hoursOn(key), norm = S.settings.dayNorm, hr = S.hours[key] || {};
  const ms = monthStats(), pg = piggy();
  const bars = Array.from({ length: norm }, (_, i) => `<span class="${i < Math.floor(h) ? 'on' : ''}"></span>`).join('');
  const src = [hr.yt ? `YouTrack ${fmtH(hr.yt)}` : '', hr.sheet ? `таблица ${fmtH(hr.sheet)}` : '', hr.manual ? `вручную ${fmtH(hr.manual)}` : ''].filter(Boolean).join(' · ');
  const block = (title, rows) => rows.length ? `<div class="group-k">${title}</div>${rows.join('')}` : '';

  const urgent = [];
  if (!isWeekend(now) && h < norm) {
    urgent.push(ui.editHours === key
      ? `<div class="item"><span class="mark" style="border-color:var(--amber)"></span><span class="t">Часы Лайма за сегодня, вручную</span><input class="hours-input" id="hoursIn" type="number" step="0.5" min="0" value="${hr.manual || ''}" placeholder="0"><span class="meta">Enter</span></div>`
      : `<div class="item"><span class="mark" style="border-color:var(--amber)"></span><span class="t">${h ? `Внести часы — не хватает ${fmtH(norm - h)}` : 'Внести часы Лайма за сегодня'}</span><span class="meta">сверка в ${S.settings.reminderTime}</span><button class="act amber" data-act="hours" data-k="${key}">Внести</button></div>`);
  }
  (S.calendar.events || []).filter((e) => new Date(e.end) > now).slice(0, 2).forEach((e) => {
    const st = new Date(e.start), tomorrow = st.getDate() !== now.getDate();
    const when = (tomorrow ? 'завтра ' : '') + (e.allDay ? 'весь день' : st.toTimeString().slice(0, 5));
    const soon = !tomorrow && st - now < 30 * 60000 && st > now;
    urgent.push(`<div class="item"><span class="mark" style="border-color:rgba(225,232,255,.35)"></span><span class="t">${esc(e.title)}</span><span class="meta" style="${soon ? 'color:var(--amber)' : ''}">${when}</span>${e.url ? `<button class="act cyan" data-act="open" data-k="${esc(e.url)}">Войти</button>` : ''}</div>`);
  });

  const qs = S.entries.filter((e) => e.type === 'question' && !e.done).sort((a, b) => a.created - b.created);
  const tasks = S.entries.filter((e) => e.type === 'task');
  const starred = tasks.filter((e) => e.today === key && !e.done);
  const doneToday = S.entries.filter((e) => e.done && e.doneAt && dayKey(new Date(e.doneAt)) === key);
  const openTasks = tasks.filter((e) => !e.done);
  let todayRows = starred.slice(0, 5).map((e) => entryRow(e, true));
  let todayTitle = 'На сегодня';
  if (!starred.length && openTasks.length) {
    todayTitle = 'На сегодня — отметь ☆ задачи, а пока свежие';
    todayRows = openTasks.sort((a, b) => b.created - a.created).slice(0, 3).map((e) => entryRow(e, true));
  }
  const restTasks = openTasks.length - Math.min(todayRows.length, openTasks.length);
  const calHint = !S.settings.hasCalendar ? `<div class="more"><a href="#" data-act="go" data-k="settings">Подключить календарь →</a></div>` : '';

  return `<div class="col center">
    <section class="hero">
      <span class="label">Сегодня заработано</span>
      <span class="big">${money(h * S.settings.limeRate)}</span>
      <div style="display:flex;align-items:center;gap:12px;font-size:14px;color:var(--dim)"><span class="hours-bar">${bars}</span>${fmtH(h)} из ${norm} на Лайме</div>
      ${src ? `<span class="hint-link" style="cursor:default">${src}${hr.syncedAt ? ' · собрано ' + new Date(hr.syncedAt).toTimeString().slice(0, 5) : ''}</span>` : ''}
      <a href="#" class="hint-link" data-act="go" data-k="income">${MONTHS[now.getMonth()]} ${money(ms.earned)} · копилка ${rub(pg.total)} →</a>
    </section>
    ${composerHtml('draft')}
    <section class="list">
      ${block('Сейчас', urgent)}
      ${block(`Ждут ответа · ${qs.length}`, qs.slice(0, 3).map((e) => entryRow(e, true, true)))}
      ${block(todayTitle, todayRows)}
      ${restTasks > 0 ? `<div class="more"><a href="#" data-act="go" data-k="projects">Все задачи · ещё ${restTasks} →</a></div>` : ''}
      ${block(`Сделано сегодня · ${doneToday.length}`, doneToday.slice(0, 5).map((e) => entryRow(e, true)))}
      ${!urgent.length && !qs.length && !openTasks.length ? '<div class="empty">Всё сделано. Можно выдохнуть.</div>' : ''}
      ${calHint}
    </section>
    <section class="fact"><span class="k">факт дня</span><p>${esc(S.fact[0])}</p><small>${esc(S.fact[1])}</small></section>
  </div>`;
}

function entryRow(e, withProject, showAge) {
  const p = proj(e.projectId) || { color: '#9AA4BF', name: '' };
  const shape = { task: '50%', question: '6px', idea: '50% 50% 50% 4px', link: '6px', person: '50%' }[e.type] || '50%';
  const checkable = ['task', 'question', 'idea'].includes(e.type);
  const tg = e.type === 'person' || e.type === 'question' ? tgLink(e.text) : null;
  const url = e.type === 'link' ? urlOf(e.text) : null;
  const label = e.type === 'link' && e.title ? `${esc(e.title)} <span class="meta">${esc(e.text)}</span>` : esc(e.text);
  const mark = checkable
    ? `<button class="mark" data-act="toggle" data-k="${e.id}" aria-label="${e.done ? 'Вернуть' : 'Сделано'}" style="border-radius:${shape};border-color:${p.color};background:${e.done ? p.color : 'transparent'}">${e.done ? '✓' : ''}</button>`
    : `<span class="mark" style="border-radius:${shape};border-color:${p.color};color:${p.color}">${e.type === 'link' ? '↗' : esc(e.text[0] || '')}</span>`;
  const star = e.type === 'task' && !e.done ? `<button class="star ${e.today === dayKey() ? 'on' : ''}" data-act="star" data-k="${e.id}" title="${e.today === dayKey() ? 'Убрать из «На сегодня»' : 'На сегодня'}">${e.today === dayKey() ? '★' : '☆'}</button>` : '';
  const action = url ? `<button class="act cyan" data-act="open" data-k="${esc(url)}">Открыть</button>` : tg ? `<button class="act" data-act="open" data-k="${tg}">Telegram ↗</button>` : '';
  const meta = showAge ? `${esc(p.name)} · ${ago(e.created).replace(' назад', '')}` : withProject ? esc(p.name) : ago(e.created);
  return `<div class="item">${mark}<span class="t ${e.done ? 'done' : ''}" data-edit="${e.id}" title="Дважды кликни, чтобы исправить">${label}</span><span class="meta">${meta}</span>${star}${action}<button class="x" data-act="del" data-k="${e.id}" aria-label="Удалить">×</button></div>`;
}

function viewProjects() {
  if (!proj(ui.project)) ui.project = (S.projects[0] || {}).id;
  const p = proj(ui.project);
  const openCount = (id) => S.entries.filter((e) => e.projectId === id && !e.done && (e.type === 'task' || e.type === 'question')).length;
  const folders = S.projects.map((x) => `<button class="folder ${x.id === ui.project ? 'on' : ''}" data-act="project" data-k="${x.id}">
      <svg width="18" height="15" viewBox="0 0 18 15" aria-hidden="true"><path d="M1 3a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill="${x.id === ui.project ? x.color + '33' : 'none'}" stroke="${x.color}" stroke-width="1.3"/></svg>
      <span class="n">${esc(x.name)}</span><span class="c">${openCount(x.id) || ''}</span></button>`).join('');
  if (!p) return `<div class="wide"><div class="pgrid"><nav class="folders">${folders}<input class="folder-add" id="newProject" placeholder="＋ Новый проект"></nav><div class="empty">Создай первый проект.</div></div></div>`;
  const list = S.entries.filter((e) => e.projectId === p.id);
  const tabs = TABS.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l} <span>${list.filter((e) => e.type === k && !e.done).length || ''}</span></button>`).join('');
  const items = list.filter((e) => e.type === ui.tab).sort((a, b) => (a.done - b.done) || (b.created - a.created));
  const ph = { task: 'Новая задача…', question: 'Новый вопрос… (можно с @telegram)', idea: 'Новая идея…', link: 'Вставь ссылку — название подтянется', person: 'Имя, роль и @telegram' }[ui.tab];
  return `<div class="wide"><div class="pgrid">
    <nav class="folders"><span class="k">Папки</span>${folders}<input class="folder-add" id="newProject" placeholder="＋ Новый проект"></nav>
    <main class="pmain">
      <div class="phead"><span style="width:12px;height:12px;border-radius:50%;background:${p.color}"></span>
        <h1 id="pname" title="Дважды кликни, чтобы переименовать">${esc(p.name)}</h1>
        <button class="btn" data-act="rename" title="Переименовать">✎</button><button class="btn" data-act="delproject" title="Удалить проект">🗑</button><button class="btn glass" data-act="export">Выгрузить для Claude</button></div>
      <section class="status glass"><span class="k">Где я остановилась · ${ago(p.statusUpdated)}</span>
        <textarea id="status" rows="2" placeholder="Что сделано, на чём застряла, какой следующий шаг…">${esc(p.status)}</textarea></section>
      <div class="tabs">${tabs}</div>
      <section class="list"><label class="addline"><span style="color:${p.color};font-size:18px">＋</span><input id="addItem" placeholder="${ph}"></label>
        ${items.map((e) => entryRow(e, false)).join('') || `<div class="empty">Пусто. Напиши выше — или скажи Claude «добавь в ${esc(p.name)}…».</div>`}</section>
    </main></div></div>`;
}

function viewIncome() {
  const ms = monthStats(), now = new Date(), pg = piggy(), norm = S.settings.dayNorm;
  const maxH = Math.max(norm * 1.1, ...ms.days.map((d) => d.h));
  const px = (h) => Math.round(h / maxH * 160);
  const bars = ms.days.map((d) => `<span class="bar ${d.today ? 'today' : d.we ? 'we' : ''}" style="height:${Math.max(d.we ? 3 : 4, px(d.h))}px" title="${d.d} ${MONTHS_GEN[now.getMonth()]}: ${fmtH(d.h)} · ${money(d.h * S.settings.limeRate)}"></span>`).join('');
  const axis = ms.days.map((d) => `<span style="${d.today ? 'color:#fff' : ''}">${d.d}</span>`).join('');
  const log = ms.days.filter((d) => !d.we).reverse().slice(0, 10).map((d) => {
    const dt = new Date(now.getFullYear(), now.getMonth(), d.d);
    const editing = ui.editHours === d.key;
    return `<div class="item" style="min-height:44px"><span style="width:6px;height:6px;border-radius:50%;background:${d.h >= norm ? 'var(--cyan)' : 'var(--amber)'}"></span>
      <span class="t" style="font-size:15px">${DOW[dt.getDay()]}, ${d.d} ${MONTHS_GEN[dt.getMonth()]}</span>
      ${editing ? `<input class="hours-input" id="hoursIn" type="number" step="0.5" min="0" value="${(S.hours[d.key] || {}).manual || ''}">` : `<button class="meta" data-act="hours" data-k="${d.key}" title="Изменить">${fmtH(d.h)}</button>`}
      <span style="width:80px;text-align:right;font-variant-numeric:tabular-nums">${money(d.h * S.settings.limeRate)}</span></div>`;
  }).join('');
  const months = [];
  for (let i = 2; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ name: MONTHS[d.getMonth()], v: monthStats(d.getFullYear(), d.getMonth()).earned }); }
  const maxM = Math.max(1, ...months.map((m) => m.v));
  const curSeg = ['usd', 'rub', 'gel'].map((c) => `<button class="${cur() === c ? 'on' : ''}" data-act="cur" data-k="${c}">${SYM[c]}</button>`).join('');
  const normTop = 170 - px(norm);
  return `<div class="col" style="max-width:780px">
    <div class="seg">${curSeg}</div>
    <section class="hero"><span class="label">${MONTHS[now.getMonth()]} · Лайм</span><span class="big" style="font-size:96px">${money(ms.earned)}</span>
      <span style="font-size:14px;color:var(--dim)">${fmtH(ms.hours)}${ms.forecast ? ` · прогноз ${money(ms.forecast)}` : ''}</span></section>
    <section><div class="chart"><span class="norm" style="top:${normTop}px"></span>${bars}</div><div class="axis" style="margin-top:8px">${axis}</div></section>
    <section class="stats"><div class="stat glass"><b>${fmtH(ms.avgH)}</b><span>в среднем за рабочий день</span></div>
      <div class="stat glass"><b>${money(ms.avgH * S.settings.limeRate)}</b><span>в среднем за рабочий день</span></div>
      <div class="stat glass"><b style="color:${ms.deficit ? 'var(--amber)' : 'inherit'}">${ms.deficit ? '−' + fmtH(ms.deficit) : '0 ч'}</b><span>недобор до нормы</span></div></section>
    <div class="two"><section class="list"><span class="k2">Последние дни · клик по часам — исправить</span>${log || '<div class="empty">Пока нет рабочих дней.</div>'}</section>
      <section><span class="k2">По месяцам</span>${months.map((m) => `<div class="mrow"><div class="l"><span style="color:var(--dim)">${m.name}</span><span>${money(m.v)}</span></div><div class="track"><span style="width:${Math.round(m.v / maxM * 100)}%"></span></div></div>`).join('')}
        <p style="padding-top:16px;font-size:13px;color:var(--faint)">Копилка УрФУ: в ${MONTHS_GEN[now.getMonth()].replace(/я$/, 'е').replace(/а$/, 'е')} +${rub(pg.total)}, сегодня +${rub(pg.today)}</p>
        <p style="padding-top:6px;font-size:12px;color:rgba(225,232,255,.3)">Курс: $1 = ${S.settings.rates.rub.toFixed(1)} ₽ = ${S.settings.rates.gel.toFixed(2)} ₾${S.settings.rates.updated ? '' : ' (примерный)'}</p></section></div>
  </div>`;
}

const KINDS = [['all', 'Всё'], ['link', 'Ссылки'], ['person', 'Люди'], ['task', 'Задачи'], ['question', 'Вопросы'], ['idea', 'Идеи']];
function viewBase() {
  const q = ui.q.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hit = (str) => words.every((w) => str.toLowerCase().includes(w));
  let items = S.entries.filter((e) => (ui.kind === 'all' || e.type === ui.kind) && (!ui.tag || e.projectId === ui.tag));
  if (words.length) items = items.filter((e) => hit(`${e.text} ${e.title || ''} ${(proj(e.projectId) || {}).name || ''}`));
  else if (ui.kind === 'all') items = items.filter((e) => e.type === 'link' || e.type === 'person' || !e.done);
  const order = { link: 0, person: 1, question: 2, task: 3, idea: 4 };
  items.sort((a, b) => (a.done - b.done) || (order[a.type] - order[b.type]) || (b.created - a.created));
  const statuses = words.length ? S.projects.filter((p) => p.status && hit(p.status + ' ' + p.name)) : [];
  const kinds = KINDS.map(([k, l]) => `<button class="chip ${ui.kind === k ? 'on' : ''}" data-act="kind" data-k="${k}">${l}</button>`).join('');
  const tags = S.projects.map((p) => `<button class="chip ${ui.tag === p.id ? 'on' : ''}" data-act="tag" data-k="${p.id}"><span class="d" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('');
  const addTo = proj(ui.tag) || proj(S.lastProjectId) || S.projects[0];
  return `<div class="col" style="max-width:760px">
    <section class="search glass"><span style="color:var(--faint)">⌕</span><input id="q" placeholder="Найти ссылку, человека, задачу…" value="${esc(ui.q)}" autocomplete="off"><kbd>⌘K</kbd></section>
    <div class="filters">${kinds}<span class="sep"></span>${tags}</div>
    <section class="list">
      ${statuses.map((p) => `<div class="item"><span class="mark" style="border-color:${p.color};border-radius:6px;color:${p.color}">⌖</span><span class="t">${esc(p.status)}</span><span class="meta">где остановилась · ${esc(p.name)}</span><button class="act cyan" data-act="openproject" data-k="${p.id}">Открыть</button></div>`).join('')}
      ${items.map((e) => entryRow(e, true)).join('') || `<div class="empty">${words.length ? 'Ничего не нашлось.' : 'Здесь появятся ссылки, люди и всё, что ты запишешь.'}</div>`}
      <label class="addline"><span style="color:${addTo ? addTo.color : 'var(--cyan)'};font-size:18px">＋</span><input id="baseAdd" placeholder="Ссылка или «Имя, роль @telegram» → в «${esc(addTo ? addTo.name : '')}»"></label>
    </section></div>`;
}

function viewSettings() {
  const s = S.settings;
  return `<div class="col">
    <section class="hero"><span class="big" style="font-size:44px">Настройки</span></section>
    <section class="form">
      <div class="row"><div class="field"><label>Ставка Лайма, $ в час</label><input data-set="limeRate" type="number" value="${s.limeRate}"></div>
        <div class="field"><label>Норма, часов в день</label><input data-set="dayNorm" type="number" step="0.5" value="${s.dayNorm}"></div></div>
      <div class="row"><div class="field"><label>Чьи часы считаем — проект Лайма</label><select data-set="limeProject" title="Часы и деньги на главной относятся к этому проекту">${S.projects.map((p) => `<option value="${p.id}" ${p.id === s.limeProject ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Напоминание о часах</label><input data-set="reminderTime" type="time" value="${s.reminderTime}"></div></div>
      <div class="row"><div class="field"><label>Копилка УрФУ, ₽ в месяц</label><input data-set="urfuMonthRub" type="number" value="${s.urfuMonthRub}"></div>
        <div class="field"><label>Валюта по умолчанию</label><select data-set="currency">${['usd', 'rub', 'gel'].map((c) => `<option value="${c}" ${s.currency === c ? 'selected' : ''}>${SYM[c]}</option>`).join('')}</select></div></div>
      <div class="field"><label>Календарь — секретный адрес в формате iCal</label>
        <input id="ics" placeholder="${s.hasCalendar ? 'Подключён. Вставь новый адрес, чтобы заменить' : 'https://calendar.google.com/calendar/ical/…/basic.ics'}">
        <small>Google Календарь → Настройки → твой календарь → «Секретный адрес в формате iCal». Хранится зашифрованным на Mac.${S.calendar.error ? ' Ошибка: ' + esc(S.calendar.error) : S.calendar.updated ? ' Обновлён ' + ago(S.calendar.updated) + '.' : ''}</small></div>
      <div class="row" style="align-items:center"><small style="color:var(--faint)">Данные лежат в папке ~/Daybook · версия ${S.version}</small>
        <button class="btn glass" data-act="updates" style="flex:none">Проверить обновления</button></div>
    </section></div>`;
}

// ---------- actions ----------
async function saveDraft() {
  const text = ui.draft.trim(); if (!text) return;
  const target = ui.target || S.lastProjectId || (S.projects[0] || {}).id;
  await window.db.addEntry({ projectId: target, type: ui.type, text });
  ui.draft = '';
  toast(ui.type === 'status' ? 'Статус обновлён' : `Записано в «${(proj(target) || {}).name || ''}»`);
  render(true); const d = $('#draft'); if (d) d.focus();
}

document.addEventListener('click', async (ev) => {
  const navB = ev.target.closest('#nav button'); if (navB) { ui.view = navB.dataset.v; ui.editHours = null; render(); if (ui.view === 'base') { const q = $('#q'); q && q.focus(); } return; }
  if (ev.target.closest('#gear')) { ui.view = 'settings'; render(); return; }
  if (ev.target.closest('#upd')) { window.db.installUpdate(); return; }
  const el = ev.target.closest('[data-act]'); if (!el) return;
  ev.preventDefault();
  const k = el.dataset.k;
  switch (el.dataset.act) {
    case 'type': ui.type = k; render(); $('#draft') && $('#draft').focus(); break;
    case 'target': ui.target = k; render(); $('#draft') && $('#draft').focus(); break;
    case 'save': saveDraft(); break;
    case 'go': ui.view = k; render(); break;
    case 'project': ui.project = k; render(); break;
    case 'tab': ui.tab = k; render(); break;
    case 'toggle': { const e = S.entries.find((x) => x.id === k); if (!e) break; await window.db.updateEntry(k, { done: !e.done }); if (!e.done) toast('Сделано', () => window.db.updateEntry(k, { done: false })); break; }
    case 'del': { const e = S.entries.find((x) => x.id === k); if (!e) break; const copy = { ...e }; await window.db.deleteEntry(k); toast('Удалено', () => window.db.restoreEntry(copy)); break; }
    case 'undo': if (undoFn) { undoFn(); undoFn = null; $('#toast').classList.remove('show'); } break;
    case 'star': { const e = S.entries.find((x) => x.id === k); if (e) window.db.updateEntry(k, { today: e.today === dayKey() ? null : dayKey() }); break; }
    case 'rename': { const h = $('#pname'); h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); break; }
    case 'delproject': { const p = proj(ui.project); const n = S.entries.filter((x) => x.projectId === ui.project).length; if (p && confirm(`Удалить «${p.name}» и все записи (${n})? Отменить будет нельзя, но копия данных останется в ~/Daybook/backups.`)) await window.db.deleteProject(ui.project); break; }
    case 'open': window.db.openUrl(k); break;
    case 'hours': ui.editHours = k; render(); setTimeout(() => { const i = $('#hoursIn'); if (i) { i.focus(); i.select(); } }, 0); break;
    case 'cur': ui.cur = k; render(); break;
    case 'kind': ui.kind = k; render(); break;
    case 'tag': ui.tag = ui.tag === k ? null : k; render(); break;
    case 'openproject': ui.project = k; ui.view = 'projects'; render(); break;
    case 'export': await window.db.exportProject(ui.project); toast('Скопировано — вставь в чат с Claude'); break;
    case 'updates': window.db.checkUpdates(); break;
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'draft') {
    const was = ui.draft.length > 0; ui.draft = ev.target.value;
    if (was !== ui.draft.length > 0) { const pos = ev.target.selectionStart; render(true); const d = $('#draft'); d.focus(); d.setSelectionRange(pos, pos); }
    else { const b = document.querySelector('.send'); b && b.classList.toggle('ready', ui.draft.length > 0); }
  }
  if (ev.target.id === 'q') { ui.q = ev.target.value; const pos = ev.target.selectionStart; render(true); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }
  if (ev.target.id === 'status') {
    clearTimeout(ev.target._t); const id = ui.project, val = ev.target.value;
    ev.target._t = setTimeout(() => window.db.updateProject(id, { status: val }), 600);
  }
});

document.addEventListener('keydown', async (ev) => {
  const t = ev.target;
  if (t.id === 'draft' && ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); saveDraft(); }
  if (t.id === 'draft' && ev.key === 'Tab' && ui.draft) {
    ev.preventDefault(); const ids = S.projects.map((p) => p.id); const i = ids.indexOf(ui.target || S.lastProjectId);
    ui.target = ids[(i + (ev.shiftKey ? -1 : 1) + ids.length) % ids.length]; const pos = t.selectionStart; render(true); const d = $('#draft'); d.focus(); d.setSelectionRange(pos, pos);
  }
  if (t.id === 'addItem' && ev.key === 'Enter' && !ev.isComposing && t.value.trim()) {
    await window.db.addEntry({ projectId: ui.project, type: ui.tab, text: t.value }); t.value = ''; t.blur(); setTimeout(() => { const a = $('#addItem'); a && a.focus(); }, 50);
  }
  if (t.id === 'baseAdd' && ev.key === 'Enter' && !ev.isComposing && t.value.trim()) {
    const v = t.value.trim(), type = /^https?:\/\//.test(v) ? 'link' : 'person';
    const target = ui.tag || S.lastProjectId || (S.projects[0] || {}).id;
    await window.db.addEntry({ projectId: target, type, text: v }); t.value = ''; toast(type === 'link' ? 'Ссылка добавлена' : 'Человек добавлен');
  }
  if (ev.metaKey && (ev.key === 'k' || ev.key === 'л')) { ev.preventDefault(); ui.view = 'base'; render(true); const q = $('#q'); q && q.focus(); }
  if (t.id === 'q' && ev.key === 'Escape') { ui.q = ''; render(true); }
  if (t.id === 'newProject' && ev.key === 'Enter' && t.value.trim()) { const id = await window.db.addProject(t.value.trim()); ui.project = id; t.value = ''; t.blur(); }
  if (t.id === 'hoursIn' && (ev.key === 'Enter' || ev.key === 'Escape')) {
    const k = ui.editHours; ui.editHours = null;
    if (ev.key === 'Enter') { await window.db.setHours(k, t.value); toast('Часы сохранены'); }
    t.blur(); render();
  }
  if (t.id === 'ics' && ev.key === 'Enter') { await window.db.setIcs(t.value); t.value = ''; t.blur(); toast('Календарь подключён'); }
  if (t.id === 'pname' && ev.key === 'Enter') { ev.preventDefault(); t.blur(); }
  if (!/INPUT|TEXTAREA/.test(t.tagName) && !t.isContentEditable && ev.metaKey && /^[1-4]$/.test(ev.key)) { ui.view = ['today', 'projects', 'income', 'base'][+ev.key - 1]; render(); }
});

document.addEventListener('change', (ev) => {
  const k = ev.target.dataset.set; if (!k) return;
  let v = ev.target.value; if (['limeRate', 'dayNorm', 'urfuMonthRub'].includes(k)) v = Number(v);
  window.db.updateSettings({ [k]: v }); toast('Сохранено');
});

document.addEventListener('dblclick', (ev) => {
  const ed = ev.target.closest('[data-edit]');
  if (ed) {
    const e = S.entries.find((x) => x.id === ed.dataset.edit); if (!e) return;
    ed.textContent = e.text; ed.contentEditable = 'true'; ed.focus(); document.getSelection().selectAllChildren(ed); document.getSelection().collapseToEnd();
    const finish = (save) => { ed.onblur = null; ed.contentEditable = 'false'; const v = ed.textContent.trim(); if (save && v && v !== e.text) window.db.updateEntry(e.id, { text: v, title: e.type === 'link' && v !== e.text ? '' : e.title }); render(true); };
    ed.onkeydown = (k) => { if (k.key === 'Enter') { k.preventDefault(); finish(true); } if (k.key === 'Escape') finish(false); };
    ed.onblur = () => finish(true);
    return;
  }
  if (ev.target.id !== 'pname') return;
  const h = ev.target; h.contentEditable = 'true'; h.focus(); document.getSelection().selectAllChildren(h);
  h.onblur = () => { h.contentEditable = 'false'; const v = h.textContent.trim(); if (v) window.db.updateProject(ui.project, { name: v }); };
});

window.db.onState((s) => { S = s; render(); });
window.db.onGo((v) => { ui.view = v; render(); });
window.db.onSearch((q) => { ui.view = 'base'; ui.q = q || ''; render(true); const i = $('#q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
window.db.getState().then((s) => { S = s; ui.target = s.lastProjectId; render(); });
setInterval(render, 30000);
