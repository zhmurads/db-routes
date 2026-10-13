import './style.css';
import { ApiError, refreshJourney, searchJourneys, searchStations, type Journey, type JourneyQuery, type Station } from './api';
import { keepView, mapEl, showJourney } from './map';
import { berlinDay, detailsEl, h, hhmmss, summaryEl } from './render';
import * as W from './watch';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('search');
const statusEl = $('status');
const resultsEl = $('results');
const listEl = $('list');
const earlierBtn = $<HTMLButtonElement>('earlier');
const laterBtn = $<HTMLButtonElement>('later');
const dateEl = $<HTMLInputElement>('date');
const timeEl = $<HTMLInputElement>('time');
const transferEl = $<HTMLSelectElement>('transfer');

const AUTO_REFRESH_MS = 60_000;

// ---------- Станции и автодополнение ----------

type Picked = { id: string; name: string } | null;
const picked: Record<string, Picked> = { from: null, to: null, via: null };

const RECENT_KEY = 'db-routes:recent';
function recent(): Station[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
}
function remember(s: Station) {
  try {
    const list = [s, ...recent().filter((x) => x.id !== s.id)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* приватный режим — не страшно */ }
}

function setupStation(field: 'from' | 'to' | 'via') {
  const input = $<HTMLInputElement>(field);
  const list = $<HTMLUListElement>(`${field}-list`);
  let items: Station[] = [];
  let active = -1;
  let timer = 0;
  let ctrl: AbortController | null = null;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const highlight = (i: number) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${field}-opt-${i}`);
  };
  const choose = (s: Station) => {
    picked[field] = { id: s.id, name: s.name };
    input.value = s.name;
    input.classList.remove('invalid');
    remember(s);
    close();
  };
  const show = (stations: Station[], hint?: string) => {
    items = stations;
    list.replaceChildren(...stations.map((s, i) => {
      const li = h('li', { id: `${field}-opt-${i}`, role: 'option', 'aria-selected': 'false' },
        h('span', { class: 'name' }, s.name),
        s.region ? h('span', { class: 'muted' }, s.region) : null);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(s); });
      return li;
    }));
    if (hint) list.prepend(h('li', { class: 'hint' }, hint));
    const open = stations.length > 0 || !!hint;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    active = -1;
  };

  input.addEventListener('input', () => {
    picked[field] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { show(q ? [] : recent(), q ? undefined : undefined); return; }
    timer = window.setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const res = await searchStations(q, ctrl.signal);
        if (input.value.trim() === q) show(res, res.length ? undefined : 'Ничего не найдено');
      } catch (err) {
        if ((err as Error).name !== 'AbortError') show([], (err as Error).message);
      }
    }, 250);
  });
  input.addEventListener('focus', () => { if (!input.value.trim()) show(recent()); });
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[Math.max(active, 0)]); }
    else if (e.key === 'Escape') close();
  });

  return { input, set: (p: Picked) => { picked[field] = p; input.value = p?.name ?? ''; } };
}

const st = { from: setupStation('from'), to: setupStation('to'), via: setupStation('via') };

$('swap').addEventListener('click', () => {
  const a = picked.from, b = picked.to;
  const av = st.from.input.value, bv = st.to.input.value;
  st.from.set(b); st.to.set(a);
  if (!b) st.from.input.value = bv;
  if (!a) st.to.input.value = av;
});

// ---------- Дата и время (всегда по Берлину) ----------

function setNow() {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
    .format(new Date()).split(' ');
  dateEl.value = parts[0];
  timeEl.value = parts[1];
}
$('now').addEventListener('click', setNow);

// ---------- Состояние поиска и URL ----------

let query: JourneyQuery | null = null;
let journeys: Journey[] = [];
let earlierRef: string | null = null;
let laterRef: string | null = null;
let refDay = '';
let openId: string | null = null;
let refreshTimer = 0;
let busy = false;

function readForm(): JourneyQuery | null {
  let ok = true;
  for (const f of ['from', 'to'] as const) {
    if (!picked[f]) { st[f].input.classList.add('invalid'); ok = false; }
  }
  if (!ok) { setStatus('Выберите станции из списка подсказок', true); return null; }
  const products = [...form.querySelectorAll<HTMLInputElement>('input[name=p]:checked')].map((i) => i.value);
  if (!products.length) { setStatus('Выберите хотя бы один вид транспорта', true); return null; }
  const mode = (form.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'dep') as 'dep' | 'arr';
  return {
    from: picked.from!.id,
    to: picked.to!.id,
    via: st.via.input.value.trim() && picked.via ? picked.via.id : '',
    when: dateEl.value && timeEl.value ? `${dateEl.value}T${timeEl.value}` : '',
    mode,
    products: products.length === 5 ? '' : products.join(','),
    transferTime: transferEl.value === '0' ? '' : transferEl.value,
  };
}

function writeUrl(q: JourneyQuery) {
  const p = new URLSearchParams();
  p.set('from', q.from); p.set('fromName', picked.from!.name);
  p.set('to', q.to); p.set('toName', picked.to!.name);
  if (q.via) { p.set('via', q.via); p.set('viaName', picked.via!.name); }
  if (q.when) p.set('when', q.when);
  if (q.mode === 'arr') p.set('mode', 'arr');
  if (q.products) p.set('products', q.products);
  if (q.transferTime) p.set('tt', q.transferTime);
  history.replaceState(null, '', `?${p}`);
}

function readUrl(): boolean {
  const p = new URLSearchParams(location.search);
  const take = (f: 'from' | 'to' | 'via') => {
    const id = p.get(f), name = p.get(`${f}Name`);
    if (id && name) st[f].set({ id, name });
  };
  take('from'); take('to'); take('via');
  if (picked.via) ($<HTMLDetailsElement>('more')).open = true;
  const when = p.get('when');
  if (when && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when)) [dateEl.value, timeEl.value] = when.split('T');
  if (p.get('mode') === 'arr') form.querySelector<HTMLInputElement>('input[name=mode][value=arr]')!.checked = true;
  const products = p.get('products');
  if (products) {
    const set = new Set(products.split(','));
    form.querySelectorAll<HTMLInputElement>('input[name=p]').forEach((i) => { i.checked = set.has(i.value); });
  }
  const tt = p.get('tt');
  if (tt && [...transferEl.options].some((o) => o.value === tt)) transferEl.value = tt;
  return !!(picked.from && picked.to);
}

// ---------- Отрисовка ----------

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function cardEl(j: Journey): HTMLElement {
  const open = j.id === openId;
  const card = h('li', { class: 'journey' + (open ? ' open' : '') + (j.cancelled ? ' is-cancelled' : ''), 'data-id': j.id });
  const head = h('button', { type: 'button', class: 'card-head', 'aria-expanded': String(open) }, summaryEl(j, refDay));
  head.addEventListener('click', () => toggle(j.id));
  card.append(head);
  if (open) {
    const refreshBtn = h('button', { type: 'button', class: 'refresh' }, '↻ Обновить');
    refreshBtn.addEventListener('click', () => refreshOpen(true));
    const watching = watch?.id === j.id;
    const watchBtn = h('button', { type: 'button', class: 'watch' + (watching ? ' on' : ''), 'aria-pressed': String(watching) },
      watching ? '🔕 Не следить' : '🔔 Следить');
    watchBtn.addEventListener('click', () => toggleWatch(j));
    card.append(h('div', { class: 'card-body' },
      h('div', { class: 'card-tools' }, refreshBtn, watchBtn, h('span', { class: 'muted updated' }),
        watching ? h('span', { class: 'watch-note' }, 'Уведомления приходят, пока эта вкладка открыта и Mac не спит') : null),
      mapEl,
      detailsEl(j)));
  }
  return card;
}

const updatedAt: Record<string, string> = {};

function render() {
  resultsEl.hidden = journeys.length === 0;
  earlierBtn.hidden = !earlierRef;
  laterBtn.hidden = !laterRef;
  listEl.replaceChildren(...journeys.map((j) => {
    const el = cardEl(j);
    const u = el.querySelector('.updated');
    if (u && updatedAt[j.id]) u.textContent = `обновлено ${updatedAt[j.id]}`;
    return el;
  }));
  drawMap();
}

// До ответа refresh у маршрута нет геометрии — рисуем прямыми через остановки, потом заменяем.
function drawMap() {
  const j = journeys.find((x) => x.id === openId);
  if (!j) return;
  showJourney(j).catch((err) => {
    console.error('map', err);
    mapEl.replaceChildren(h('p', { class: 'muted map-error' }, 'Карту не удалось загрузить'));
  });
}

function toggle(id: string) {
  openId = openId === id ? null : id;
  render();
  scheduleRefresh();
  if (openId) refreshOpen(false);
}

// ---------- Поиск, пагинация, обновление ----------

function failMessage(err: unknown) {
  return err instanceof ApiError ? err.message : 'Что-то пошло не так';
}

async function search() {
  const q = readForm();
  if (!q || busy) return;
  busy = true;
  query = q;
  writeUrl(q);
  openId = null;
  scheduleRefresh();
  setStatus('Ищу маршруты…');
  $<HTMLButtonElement>('go').disabled = true;
  try {
    const { data } = await searchJourneys(q);
    journeys = data.journeys;
    earlierRef = data.earlierRef;
    laterRef = data.laterRef;
    refDay = q.when ? q.when.slice(0, 10) : berlinDay(new Date().toISOString());
    setStatus(journeys.length ? '' : 'Маршрутов не найдено. Попробуйте другое время или включите больше видов транспорта.');
    render();
    if (journeys.length && matchMedia('(max-width: 720px)').matches) resultsEl.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    journeys = []; render();
    setStatus(failMessage(err), true);
  } finally {
    busy = false;
    $<HTMLButtonElement>('go').disabled = false;
  }
}

async function page(dir: 'earlier' | 'later') {
  const ref = dir === 'earlier' ? earlierRef : laterRef;
  if (!query || !ref || busy) return;
  busy = true;
  const btn = dir === 'earlier' ? earlierBtn : laterBtn;
  btn.disabled = true;
  try {
    const { data } = await searchJourneys(query, ref);
    const known = new Set(journeys.map((j) => j.id));
    const fresh = data.journeys.filter((j) => !known.has(j.id));
    if (dir === 'earlier') { journeys = [...fresh, ...journeys]; earlierRef = data.earlierRef; }
    else { journeys = [...journeys, ...fresh]; laterRef = data.laterRef; }
    setStatus(fresh.length ? '' : 'Больше вариантов в этом направлении нет');
    render();
  } catch (err) {
    setStatus(failMessage(err), true);
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

// Подставить обновлённый маршрут в список (id после обновления может смениться).
function applyRefreshed(oldId: string, data: Journey, at: string) {
  journeys = journeys.map((j) => (j.id === oldId ? data : j));
  if (openId === oldId) { openId = data.id; keepView(oldId, data.id); }
  updatedAt[data.id] = hhmmss(new Date(at));
  if (watch?.id === oldId) checkWatch(data);
}

async function refreshOpen(manual: boolean) {
  const id = openId;
  if (!id) return;
  const btn = listEl.querySelector<HTMLButtonElement>(`.journey.open .refresh`);
  if (btn) { btn.disabled = true; btn.textContent = '↻ Обновляю…'; }
  try {
    const { data, updatedAt: at } = await refreshJourney(id);
    if (openId !== id) return;
    applyRefreshed(id, data, at);
    render();
  } catch (err) {
    if (manual) setStatus(failMessage(err), true);
    const u = listEl.querySelector('.journey.open .updated');
    if (u) u.textContent = `не удалось обновить: ${failMessage(err)}`;
    if (btn) { btn.disabled = false; btn.textContent = '↻ Обновить'; }
  }
  scheduleRefresh();
}

// ---------- Отслеживание поездки ----------

let watch: W.Watch | null = W.load();

function checkWatch(data: Journey) {
  if (!watch) return;
  const next = W.snapshot(data);
  W.notify(watch, W.diff(watch.snap, next));
  watch = { ...watch, id: data.id, snap: next };
  W.save(watch);
}

async function toggleWatch(j: Journey) {
  if (watch?.id === j.id) {
    watch = null;
    W.save(null);
  } else {
    if (!W.notificationsSupported()) { setStatus('Этот браузер не умеет показывать уведомления', true); return; }
    if (!(await W.askPermission())) {
      setStatus('Уведомления запрещены в настройках браузера для этого сайта', true);
      return;
    }
    watch = { id: j.id, title: W.journeyTitle(j), snap: W.snapshot(j) };
    W.save(watch);
    setStatus(`Слежу за поездкой: ${watch.title}`);
  }
  render();
  scheduleRefresh();
}

// Отслеживаемая поездка, если она не раскрыта на экране: обновляем отдельно, в том числе на скрытой вкладке.
async function refreshWatched() {
  const w = watch;
  if (!w || w.id === openId) return;
  try {
    const { data, updatedAt: at } = await refreshJourney(w.id);
    if (watch?.id !== w.id) return;
    applyRefreshed(w.id, data, at);
    if (journeys.some((j) => j.id === data.id)) render();
  } catch (err) {
    console.warn('watch refresh', err);
  }
}

let watchTimer = 0;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  clearTimeout(watchTimer);
  const watchingOpen = !!watch && watch.id === openId;
  // Раскрытый маршрут обновляем на видимой вкладке; отслеживаемый — всегда.
  if (openId && (document.visibilityState === 'visible' || watchingOpen)) {
    refreshTimer = window.setTimeout(() => refreshOpen(false), AUTO_REFRESH_MS);
  }
  if (watch && !watchingOpen) {
    watchTimer = window.setTimeout(async () => { await refreshWatched(); scheduleRefresh(); }, AUTO_REFRESH_MS);
  }
}
// Скрытая вкладка — без автообновления (кроме отслеживаемой поездки); вернулись — сразу обновляем.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && openId) refreshOpen(false);
  else scheduleRefresh();
});

form.addEventListener('submit', (e) => { e.preventDefault(); search(); });
earlierBtn.addEventListener('click', () => page('earlier'));
laterBtn.addEventListener('click', () => page('later'));

setNow();
if (readUrl()) search();
// Отслеживание пережило перезагрузку: сразу сверяемся (изменения, пока страница была закрыта, тоже придут).
if (watch) refreshWatched().then(scheduleRefresh);
