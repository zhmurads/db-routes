// «Доступ» к маршруту: сколько идти пешком до станции первого поезда и когда выходить.
// Сценарий 1 — маршрут построен от местоположения (первый отрезок пешком от START).
// Сценарий 2 — маршрут от станции, а время пешком до неё посчитано от местоположения пользователя (/api/walk).
import type { Journey, Leg, Pos } from './api';

export interface Access {
  walkMin: number;
  distanceM: number | null;
  station: string;
  leaveAt: number;          // мс: когда выходить (с учётом опоздания поезда)
  trainDep: number;         // мс: фактическое (или плановое) отправление первого поезда
  trainDelay: number | null;
  estimate: boolean;        // сценарий 2: оценка от вашего местоположения
}

export type LeaveState = 'later' | 'now' | 'missed' | 'gone';

const firstTransit = (j: Journey): Leg | undefined => j.legs.find((l) => !l.walking);

// Ключ станции для кэша времени пешком: координаты с точностью ~10 м.
export const posKey = (p: Pos) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

export function accessOf(j: Journey, walkTimes: Map<string, number | null>): Access | null {
  const t = firstTransit(j);
  const dep = t?.dep.actual ?? t?.dep.planned;
  if (!t || !dep) return null;
  const trainDep = Date.parse(dep);
  const first = j.legs[0];

  // Сценарий 1: все пешие отрезки до первого поезда (обычно один).
  if (first?.walking && first.origin === 'START') {
    const walks = j.legs.slice(0, j.legs.indexOf(t)).filter((l) => l.walking);
    const walkMin = walks.reduce((s, l) => s + l.durationMin, 0);
    const dist = walks.reduce((s, l) => s + (l.distanceM ?? 0), 0);
    return {
      walkMin, distanceM: dist || null, station: t.origin,
      leaveAt: trainDep - walkMin * 60_000, trainDep, trainDelay: t.dep.delayMin, estimate: false,
    };
  }

  // Сценарий 2.
  const w = walkTimes.get(posKey(t.originPos));
  if (w == null) return null;
  return {
    walkMin: w, distanceM: null, station: t.origin,
    leaveAt: trainDep - w * 60_000, trainDep, trainDelay: t.dep.delayMin, estimate: true,
  };
}

export function leaveState(a: Pick<Access, 'leaveAt' | 'trainDep'>, now = Date.now()): LeaveState {
  if (now > a.trainDep) return 'gone';
  const min = (a.leaveAt - now) / 60_000;
  if (min < -1) return 'missed';
  if (min <= 2) return 'now';
  return 'later';
}

export function countdownText(a: Pick<Access, 'leaveAt' | 'trainDep'>, now = Date.now()): string {
  const s = leaveState(a, now);
  if (s === 'gone') return 'поезд уже ушёл';
  if (s === 'missed') return 'уже не успеть пешком';
  if (s === 'now') return 'пора выходить';
  const min = Math.round((a.leaveAt - now) / 60_000);
  if (min < 60) return `через ${min} мин`;
  const h = Math.floor(min / 60);
  return `через ${h} ч ${String(min % 60).padStart(2, '0')} мин`;
}

// Станции первых поездов, для которых ещё нет времени пешком.
export function missingStations(js: Journey[], walkTimes: Map<string, number | null>): Pos[] {
  const out = new Map<string, Pos>();
  for (const j of js) {
    if (j.legs[0]?.walking && j.legs[0].origin === 'START') continue;
    const t = firstTransit(j);
    if (!t) continue;
    const k = posKey(t.originPos);
    if (!walkTimes.has(k)) out.set(k, t.originPos);
  }
  return [...out.values()];
}
