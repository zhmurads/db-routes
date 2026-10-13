// Клиент DB Timetables API (DB API Marketplace) — данные вокзальных табло DB.
// Формат сверен с живыми ответами (2026-10-13):
//   plan/{eva}/{yyMMdd}/{HH} — плановые остановки за час: <s id><tl c n/><ar|dp pt pp/></s>
//   fchg/{eva}               — все изменения: <s id eva><ar|dp ct cp cs="c"><m t c/></ar><m t="h" cat from to del/></s>
//   station/{pattern|eva}    — <station eva meta="eva|eva|…"> (meta — связанные номера, например уровни Berlin Hbf)
// Время — «yyMMddHHmm» по Берлину. id в plan и fchg совпадают; в fchg категории и номера поезда обычно нет.
import { XMLParser } from 'fast-xml-parser';
import { cached, redis } from './cache.js';
import { config } from './config.js';

const BASE = 'https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1';

export const ttEnabled = () => !!(config.dbClientId && config.dbApiKey);

export class BudgetExceeded extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  isArray: (name) => ['s', 'm', 'station'].includes(name),
});

// Общий бюджет запросов в минуту на весь backend (бесплатный план — 60/мин).
async function takeBudget() {
  if (!redis.isReady) return;
  const key = `tt:budget:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 90);
  if (n > config.dbBudgetPerMin) throw new BudgetExceeded();
}

async function ttGet(path: string): Promise<any> {
  await takeBudget();
  const res = await fetch(BASE + path, {
    headers: { 'DB-Client-Id': config.dbClientId, 'DB-Api-Key': config.dbApiKey, Accept: 'application/xml' },
    signal: AbortSignal.timeout(10_000),
  });
  // 404 — для станции/часа нет данных; это не ошибка.
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`timetables ${res.status} ${path}`);
  return parser.parse(await res.text());
}

// --- Типы ---
export interface TTMessage { t: string; c?: string; cat?: string; from?: string; to?: string; del?: string; pr?: string }
interface TTEvent { pt?: string; pp?: string; ct?: string; cp?: string; cs?: string; m?: TTMessage[] }
interface TTStop { id: string; eva?: string; tl?: { c?: string; n?: string }; ar?: TTEvent; dp?: TTEvent; m?: TTMessage[] }

export interface PlanStop { id: string; category: string; number: string; ar?: { pt: string; pp?: string }; dp?: { pt: string; pp?: string } }
export interface Change { ar?: TTEvent; dp?: TTEvent; m: TTMessage[] }

const stops = (doc: any): TTStop[] => doc?.timetable?.s ?? [];

// Номер EVA и связанные номера (meta). Кэш 30 дней.
export function stationEvas(eva: string): Promise<string[]> {
  return cached(`tt:st:${eva}`, 30 * 86400, async () => {
    const doc = await ttGet(`/station/${encodeURIComponent(eva)}`);
    const st = doc?.stations?.station?.[0];
    if (!st) return [eva];
    const meta = String(st.meta ?? '').split('|').filter(Boolean);
    return [...new Set([String(st.eva ?? eva), ...meta])];
  });
}

// План станции за час (yyMMdd, HH). Кэш 6 часов.
export function plan(eva: string, day: string, hour: string): Promise<PlanStop[]> {
  return cached(`tt:plan:${eva}:${day}:${hour}`, 6 * 3600, async () => {
    const doc = await ttGet(`/plan/${eva}/${day}/${hour}`);
    return stops(doc).map((s) => ({
      id: s.id,
      category: s.tl?.c ?? '',
      number: s.tl?.n ?? '',
      ar: s.ar?.pt ? { pt: s.ar.pt, pp: s.ar.pp } : undefined,
      dp: s.dp?.pt ? { pt: s.dp.pt, pp: s.dp.pp } : undefined,
    }));
  });
}

// Все текущие изменения на станции, по id остановки. Кэш 30 секунд.
export function changes(eva: string): Promise<Record<string, Change>> {
  return cached(`tt:fchg:${eva}`, 30, async () => {
    const doc = await ttGet(`/fchg/${eva}`);
    const out: Record<string, Change> = {};
    for (const s of stops(doc)) {
      const strip = (e?: TTEvent) => (e ? { ct: e.ct, cp: e.cp, cs: e.cs, pt: e.pt, pp: e.pp, m: e.m ?? [] } : undefined);
      out[s.id] = { ar: strip(s.ar), dp: strip(s.dp), m: s.m ?? [] };
    }
    return out;
  });
}
