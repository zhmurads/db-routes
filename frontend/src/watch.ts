// Отслеживание одной поездки: сравнение состояний между обновлениями и уведомления браузера.
import type { Journey, Leg, TimePoint } from './api';
import { hhmm } from './render';

const KEY = 'db-routes:watch';

interface PointSnap { delay: number | null; actual: string | null; platform: string | null; cancelled: boolean }
interface LegSnap { name: string; cancelled: boolean; dep: PointSnap; arr: PointSnap; depStop: string; arrStop: string }
export interface Snapshot { legs: Record<string, LegSnap>; transfers: { at: string; min: number }[]; warnings: string[] }
export interface Watch { id: string; title: string; snap: Snapshot }

const point = (t: TimePoint): PointSnap => ({ delay: t.delayMin, actual: t.actual, platform: t.platform, cancelled: t.cancelled });
// Сегмент опознаём по линии и станции отправления: id маршрута после обновления может смениться.
const legKey = (l: Leg) => `${l.line ?? l.mode}|${l.origin}`;

function transferMinutes(j: Journey): { at: string; min: number }[] {
  const transit = j.legs.filter((l) => !l.walking);
  const out: { at: string; min: number }[] = [];
  for (let i = 1; i < transit.length; i++) {
    if (transit[i].stayInVehicle) continue;
    const a = transit[i - 1].arr.actual ?? transit[i - 1].arr.planned;
    const d = transit[i].dep.actual ?? transit[i].dep.planned;
    if (a && d) out.push({ at: transit[i].origin, min: Math.round((Date.parse(d) - Date.parse(a)) / 60000) });
  }
  return out;
}

export function snapshot(j: Journey): Snapshot {
  const legs: Record<string, LegSnap> = {};
  for (const l of j.legs) {
    if (l.walking) continue;
    legs[legKey(l)] = {
      name: l.line ?? l.mode, cancelled: l.cancelled,
      dep: point(l.dep), arr: point(l.arr), depStop: l.origin, arrStop: l.destination,
    };
  }
  return { legs, transfers: transferMinutes(j), warnings: j.warnings.map((w) => w.title) };
}

const fmtDelay = (p: PointSnap) => (p.delay ? ` (${p.delay > 0 ? '+' : ''}${p.delay})` : '');
const timeOf = (p: PointSnap) => (p.actual ? hhmm(p.actual) : '');

// Что изменилось и стоит уведомления.
export function diff(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = [];
  for (const [k, n] of Object.entries(next.legs)) {
    const p = prev.legs[k];
    if (!p) continue;
    if (n.cancelled && !p.cancelled) { out.push(`${n.name}: поезд отменён`); continue; }
    for (const [which, label, stop] of [['dep', 'отправление', n.depStop], ['arr', 'прибытие', n.arrStop]] as const) {
      const a = p[which], b = n[which];
      if (b.cancelled && !a.cancelled) out.push(`${n.name}: ${label} в ${stop} отменено`);
      if ((b.delay ?? 0) - (a.delay ?? 0) >= 2 || (a.delay ?? 0) - (b.delay ?? 0) >= 2) {
        out.push(`${n.name}: ${label} ${stop} ${timeOf(a) || '?'} → ${timeOf(b) || '?'}${fmtDelay(b)}`);
      }
      if (a.platform && b.platform && a.platform !== b.platform) {
        out.push(`${n.name}: ${label} ${stop} — путь ${a.platform} → ${b.platform}`);
      }
    }
  }
  next.transfers.forEach(({ at, min }, i) => {
    const was = prev.transfers[i]?.min;
    if (was === undefined) return;
    if (min < 0 && was >= 0) out.push(`Не успеть на пересадку в ${at} (${min} мин)`);
    else if (min < 4 && was >= 4) out.push(`Пересадка в ${at}: осталось ${min} мин`);
  });
  for (const w of next.warnings) if (!prev.warnings.includes(w)) out.push(`⚠ ${w}`);
  return out;
}

export function load(): Watch | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
export function save(w: Watch | null) {
  try {
    if (w) localStorage.setItem(KEY, JSON.stringify(w));
    else localStorage.removeItem(KEY);
  } catch { /* приватный режим */ }
}

export const notificationsSupported = () => 'Notification' in window;

export async function askPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function notify(w: Watch, lines: string[]) {
  if (!lines.length || !notificationsSupported() || Notification.permission !== 'granted') return;
  // tag — одно уведомление на поездку, новое заменяет старое; renotify — со звуком.
  const n = new Notification(w.title, {
    body: lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n…и ещё ${lines.length - 4}` : ''),
    tag: `db-routes-${w.title}`,
    renotify: true,
  } as NotificationOptions);
  n.onclick = () => { window.focus(); n.close(); };
}

export function journeyTitle(j: Journey): string {
  const t = j.legs.filter((l) => !l.walking);
  const a = t[0], b = t[t.length - 1];
  return a && b ? `${a.origin} → ${b.destination}, ${a.dep.planned ? hhmm(a.dep.planned) : ''}` : 'Поездка';
}
