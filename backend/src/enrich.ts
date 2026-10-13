// Сверка поездов маршрута с табло DB (Timetables API): время, путь, отмена и сообщения DB
// заменяют данные Transitous там, где поезд нашёлся на табло.
import { BudgetExceeded, changes, plan, stationEvas, ttEnabled, type Change, type PlanStop, type TTMessage } from './dbtimetables.js';
import { evasForStop } from './eva.js';
import { IRIS_SILENT, himText, irisText } from './irisCodes.js';
import type { Journey, Leg, Pos, TimePoint, Warning } from './normalize.js';
import { fromIris, toIris } from './time.js';

// Категории IRIS, подходящие к нашим группам видов транспорта.
const FAMILY: Record<string, string[]> = {
  ice: ['ICE', 'ECE'],
  ic: ['IC', 'EC', 'ECE', 'EN', 'NJ', 'RJ', 'RJX', 'ICE', 'FLX', 'D', 'IR', 'TGV', 'WB'],
  regional: ['RE', 'RB', 'IRE', 'MEX', 'ERB', 'ME', 'NWB', 'BRB', 'AKN', 'ALX', 'HLB', 'OE', 'RS', 'VIA', 'EB', 'ENO', 'STB', 'TLX', 'FEX'],
  sbahn: ['S'],
};

type Kind = 'ar' | 'dp';
interface Hit { eva: string; stop: PlanStop }

// Возможные номера поезда: «ICE 699» → 699, «ECE 5» → 5, «RB51 (15506)» → 51 и 15506.
// Совпадение по номеру проверяется только среди поездов с тем же плановым временем, поэтому лишние кандидаты не мешают.
function trainNumbers(l: Leg): string[] {
  const out = new Set<string>();
  for (const s of [l.number, l.line]) {
    for (const m of (s ?? '').matchAll(/\d{1,6}/g)) out.add(String(Number(m[0])));
  }
  return [...out];
}

// Номер линии из названия: «S8» → «8», «RE 5» → «5», «RB51 (15506)» → «51».
function lineNumber(l: Leg): string | null {
  const m = /^[A-Za-z]+\s?(\d+[A-Za-z]?)\b/.exec(l.line ?? '');
  return m ? m[1] : null;
}

async function findOnBoard(stopId: string | null, pos: Pos, plannedIso: string, kind: Kind, l: Leg, plannedPlatform: string | null): Promise<Hit | null> {
  const t = toIris(plannedIso);
  const plannedMs = Date.parse(plannedIso);
  const day = t.slice(0, 6), hour = t.slice(6, 8);
  const nums = trainNumbers(l);
  const family = FAMILY[l.product] ?? [];

  const tried = new Set<string>();
  for (const near of evasForStop(stopId, pos[0], pos[1]).slice(0, 2)) {
    for (const eva of await stationEvas(near.eva)) {
      if (tried.has(eva)) continue;
      tried.add(eva);
      const slice = (await plan(eva, day, hour)).filter((s) => s[kind] && !s[kind]!.hidden);
      // По номеру поезда — с допуском ±2 мин: источники иногда расходятся на минуту
      // (ICE 220 в Düsseldorf: у DB прибытие 09:10, у Transitous 09:11).
      const byNumber = slice.find((s) => nums.includes(String(Number(s.number)))
        && Math.abs(Date.parse(fromIris(s[kind]!.pt)) - plannedMs) <= 2 * 60_000);
      if (byNumber) return { eva, stop: byNumber };
      const atTime = slice.filter((s) => s[kind]!.pt === t);
      if (!atTime.length) continue;
      // Номер линии (l): «S8» → 8, «RE5» → 5 — при той же категории.
      const lineNo = lineNumber(l);
      const byLine = lineNo ? atTime.filter((s) => family.includes(s.category) && s[kind]?.line === lineNo) : [];
      if (byLine.length === 1) return { eva, stop: byLine[0] };
      // Номер не совпал (у региональных поездов его часто нет) — категория + однозначность (+ путь).
      let cands = atTime.filter((s) => family.includes(s.category));
      if (cands.length > 1 && plannedPlatform) cands = cands.filter((s) => s[kind]?.pp === plannedPlatform);
      if (cands.length === 1) return { eva, stop: cands[0] };
    }
  }
  return null;
}

function messages(ch: Change, kind: Kind, now: number): Warning[] {
  const list: TTMessage[] = [...(ch[kind]?.m ?? []), ...ch.m];
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const m of list) {
    let title: string | null = null;
    if ((m.t === 'd' || m.t === 'q') && m.c && !IRIS_SILENT.has(m.c)) title = irisText(m.c);
    // h — сообщение HIM, r — крупное нарушение движения; del="1" — сообщение снято.
    if ((m.t === 'h' || m.t === 'r') && m.del !== '1') {
      const active = (!m.from || Date.parse(fromIris(m.from)) <= now) && (!m.to || Date.parse(fromIris(m.to)) >= now);
      if (active) title = m.cat ? himText(m.cat) : m.ext ? 'Нарушение движения' : null;
    }
    if (title && !seen.has(title)) {
      seen.add(title);
      // ext — внешний текст DB (немецкий), elnk — ссылка; в живых ответах пока не встречались.
      const text = m.ext && m.ext !== title ? m.ext : '';
      out.push({ title, text, url: m.elnk ?? null, source: 'db' });
    }
  }
  return out;
}

async function enrichPoint(l: Leg, kind: Kind, now: number): Promise<Warning[]> {
  const tp: TimePoint = kind === 'dp' ? l.dep : l.arr;
  const pos = kind === 'dp' ? l.originPos : l.destinationPos;
  const stopId = kind === 'dp' ? l.originStopId : l.destinationStopId;
  if (!tp.planned) return [];
  const hit = await findOnBoard(stopId, pos, tp.planned, kind, l, tp.plannedPlatform);
  if (!hit) return [];
  const planned = hit.stop[kind]!;
  const ch = (await changes(hit.eva))[hit.stop.id];
  const ev = ch?.[kind];

  tp.source = 'db';
  // Плановое время — тоже с табло DB: при сопоставлении с допуском оно может отличаться от Transitous на минуту.
  tp.planned = fromIris(planned.pt);
  tp.plannedPlatform = planned.pp ?? tp.plannedPlatform;
  tp.platform = ev?.cp ?? planned.pp ?? tp.platform;
  if (ev?.ct) {
    tp.actual = fromIris(ev.ct);
    tp.delayMin = Math.round((Date.parse(tp.actual) - Date.parse(fromIris(planned.pt))) / 60000);
  }
  // cs="c" — отменено, cs="p" — по плану (в т.ч. отмена отозвана); иначе оставляем как было.
  if (ev?.cs === 'c') tp.cancelled = true;
  else if (ev?.cs === 'p') tp.cancelled = false;
  return ch ? messages(ch, kind, now) : [];
}

// Мутирует journey. Любая ошибка Timetables оставляет сегмент с данными Transitous.
export async function enrichWithDb(j: Journey): Promise<{ checked: number; matched: number }> {
  const stats = { checked: 0, matched: 0 };
  if (!ttEnabled()) return stats;
  const now = Date.now();
  for (const l of j.legs) {
    if (l.walking || !FAMILY[l.product]) continue;
    const found: Warning[] = [];
    for (const kind of ['dp', 'ar'] as const) {
      stats.checked++;
      try {
        found.push(...await enrichPoint(l, kind, now));
        if ((kind === 'dp' ? l.dep : l.arr).source === 'db') stats.matched++;
      } catch (err) {
        if (err instanceof BudgetExceeded) return stats;
        console.error('timetables', (err as Error).message);
      }
    }
    if (l.dep.cancelled && l.arr.cancelled) l.cancelled = true;
    // Одно и то же сообщение часто приходит и к отправлению, и к прибытию.
    const titles = new Set(l.warnings.map((w) => w.title));
    for (const w of found) if (!titles.has(w.title)) { titles.add(w.title); l.warnings.push(w); }
  }
  // Пересчитать сводку по маршруту.
  const transit = j.legs.filter((l) => !l.walking);
  j.cancelled = transit.some((l) => l.cancelled || l.dep.cancelled || l.arr.cancelled);
  const seen = new Set<string>();
  j.warnings = j.legs.flatMap((l) => l.warnings).filter((w) => !seen.has(w.title) && !!seen.add(w.title));
  if (transit.length) { j.departure = transit[0].dep; j.arrival = transit[transit.length - 1].arr; }
  return stats;
}
