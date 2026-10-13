import type { Journey, Leg, Stopover, TimePoint, Warning } from './api';

// Небольшой помощник для DOM: строки всегда идут как текст, а не как HTML.
type Child = Node | string | null | undefined | false;
export function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const TZ = 'Europe/Berlin';
const fmtTime = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });

export const hhmm = (iso: string) => fmtTime.format(new Date(iso));
export const hhmmss = (d: Date) => d.toLocaleTimeString('ru-RU', { timeZone: TZ });

export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const transfersText = (n: number) => (n === 0 ? 'без пересадок' : `${n} ${plural(n, 'пересадка', 'пересадки', 'пересадок')}`);

// Время: плановое + фактическое (если отличается), задержка красным, отмена зачёркнута.
export function timeEl(tp: TimePoint, refDay?: string): HTMLElement {
  if (!tp.planned) return h('span', { class: 't' }, '—');
  const otherDay = refDay && dayKey.format(new Date(tp.planned)) !== refDay;
  const planned = h('span', { class: 'planned' }, hhmm(tp.planned));
  const wrap = h('span', { class: 't' + (tp.cancelled ? ' cancelled' : '') }, planned);
  if (tp.cancelled) return wrap;
  if (tp.delayMin !== null && tp.actual) {
    if (tp.delayMin > 0) {
      wrap.classList.add('late');
      wrap.append(h('span', { class: 'actual' }, hhmm(tp.actual)), h('span', { class: 'delay' }, `+${tp.delayMin}`));
    } else if (tp.delayMin < 0) {
      wrap.append(h('span', { class: 'actual early' }, hhmm(tp.actual)));
    } else {
      wrap.classList.add('ontime');
    }
  }
  if (otherDay) wrap.append(h('span', { class: 'day' }, fmtDay.format(new Date(tp.planned))));
  if (tp.source === 'db') wrap.append(dbMark());
  return wrap;
}

// Метка «данные с табло DB» (Timetables API), в отличие от потока Transitous.
const dbMark = () => h('span', { class: 'src-db', title: 'Данные табло Deutsche Bahn' }, 'DB');

export function platformEl(tp: TimePoint): HTMLElement | null {
  if (!tp.platform && !tp.plannedPlatform) return null;
  const changed = tp.platform && tp.plannedPlatform && tp.platform !== tp.plannedPlatform;
  return h('span', { class: 'pf' + (changed ? ' changed' : ''), title: changed ? `Путь изменён (был ${tp.plannedPlatform})` : 'Путь' },
    'пут. ',
    changed ? h('s', {}, tp.plannedPlatform!) : null,
    changed ? ' ' : null,
    tp.platform ?? tp.plannedPlatform ?? '');
}

const lineBadge = (l: Leg) =>
  h('span', { class: `badge p-${l.product}` + (l.cancelled ? ' cancelled' : '') }, l.line ?? l.mode);

function warningsEl(ws: Warning[]): HTMLElement | null {
  if (!ws.length) return null;
  return h('ul', { class: 'warnings' }, ...ws.map((w) =>
    h('li', {},
      w.source === 'db' ? dbMark() : null,
      h('strong', {}, w.title),
      w.text && w.text !== w.title ? h('span', {}, ' ' + w.text) : null,
      w.url ? h('a', { href: w.url, target: '_blank', rel: 'noopener' }, ' подробнее') : null)));
}

// Время между прибытием одного поезда и отправлением следующего (с учётом опозданий).
function transferEl(prev: Leg, next: Leg): HTMLElement | null {
  const a = prev.arr.actual ?? prev.arr.planned;
  const d = next.dep.actual ?? next.dep.planned;
  if (!a || !d) return null;
  const min = Math.round((Date.parse(d) - Date.parse(a)) / 60000);
  const plannedMin = prev.arr.planned && next.dep.planned
    ? Math.round((Date.parse(next.dep.planned) - Date.parse(prev.arr.planned)) / 60000) : min;
  const cls = min < 0 ? 'bad' : min < 4 ? 'tight' : '';
  const text = min < 0 ? `Не успеть на пересадку (${min} мин)` : `Пересадка ${min} мин`;
  return h('li', { class: `transfer ${cls}` }, text, min !== plannedMin ? h('span', { class: 'muted' }, ` (по плану ${plannedMin})`) : null);
}

function stopoversEl(stops: Stopover[]): HTMLElement | null {
  if (!stops.length) return null;
  return h('details', { class: 'stopovers' },
    h('summary', {}, `${stops.length} ${plural(stops.length, 'остановка', 'остановки', 'остановок')}`),
    h('ol', {}, ...stops.map((s) =>
      h('li', { class: s.cancelled ? 'cancelled' : '' },
        timeEl(s.arr.planned ? s.arr : s.dep),
        h('span', { class: 'name' }, s.name),
        s.cancelled ? h('span', { class: 'tag bad' }, 'не останавливается') : platformEl(s.dep.planned ? s.dep : s.arr)))));
}

// MOTIS называет точки начала и конца поиска служебными START / END.
const placeName = (name: string) => (name === 'END' ? 'пункт назначения' : name === 'START' ? 'место отправления' : name);

function legEl(l: Leg): HTMLElement {
  if (l.walking) {
    return h('li', { class: 'leg walk' }, `🚶 Пешком ${l.durationMin} мин`, l.distanceM ? ` · ${l.distanceM} м` : '', ` → ${placeName(l.destination)}`);
  }
  return h('li', { class: 'leg' + (l.cancelled ? ' is-cancelled' : '') },
    h('div', { class: 'leg-head' },
      lineBadge(l),
      l.number ? h('span', { class: 'muted' }, ` № ${l.number}`) : null,
      l.direction ? h('span', { class: 'dir' }, ` → ${l.direction}`) : null,
      l.cancelled ? h('span', { class: 'tag bad' }, 'Отменён') : null,
      l.additional ? h('span', { class: 'tag' }, 'доп. поезд') : null,
      l.stayInVehicle ? h('span', { class: 'tag' }, 'без пересадки, тот же вагон') : null,
      !l.realtime ? h('span', { class: 'tag muted', title: 'Нет данных в реальном времени' }, 'по расписанию') : null),
    h('div', { class: 'stop' }, timeEl(l.dep), h('span', { class: 'name' }, l.origin), platformEl(l.dep)),
    stopoversEl(l.stopovers),
    h('div', { class: 'stop' }, timeEl(l.arr), h('span', { class: 'name' }, l.destination), platformEl(l.arr)),
    h('div', { class: 'leg-foot muted' }, duration(l.durationMin), l.operator ? ` · ${l.operator}` : ''),
    warningsEl(l.warnings));
}

export function detailsEl(j: Journey): HTMLElement {
  const items: HTMLElement[] = [];
  j.legs.forEach((l, i) => {
    const prev = j.legs.slice(0, i).reverse().find((x) => !x.walking);
    if (!l.walking && prev && !l.stayInVehicle) {
      const t = transferEl(prev, l);
      if (t) items.push(t);
    }
    items.push(legEl(l));
  });
  return h('ol', { class: 'legs' }, ...items);
}

export function summaryEl(j: Journey, refDay: string): HTMLElement {
  const transit = j.legs.filter((l) => !l.walking);
  const firstDep = transit[0]?.dep ?? j.departure;
  return h('div', { class: 'summary' },
    h('div', { class: 'times' },
      timeEl(j.departure, refDay),
      h('span', { class: 'arrow' }, '→'),
      timeEl(j.arrival, refDay)),
    h('div', { class: 'meta' },
      h('span', {}, duration(j.durationMin)),
      h('span', {}, transfersText(j.transfers)),
      j.cancelled ? h('span', { class: 'tag bad' }, 'Отмена') : null,
      j.warnings.length ? h('span', { class: 'tag warn', title: j.warnings.map((w) => w.title).join('\n') }, `⚠ ${j.warnings.length}`) : null,
      !j.realtime ? h('span', { class: 'tag muted' }, 'по расписанию') : null),
    h('div', { class: 'lines' },
      ...transit.flatMap((l, i) => [i ? h('span', { class: 'sep' }, '›') : null, lineBadge(l)]),
      platformEl(firstDep)));
}

export const berlinDay = (iso: string) => dayKey.format(new Date(iso));
