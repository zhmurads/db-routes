// Время Германии (Europe/Berlin) ↔ UTC.
import { ApiError } from './upstream.js';

// «2026-10-12T18:30» по времени Берлина → ISO в UTC.
export function berlinToUtc(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new ApiError(400, 'BAD_TIME', 'Неверный формат даты и времени');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Смещение Берлина в этот момент; второй проход нужен на границе перехода на летнее время.
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t).toISOString();
}

const berlinParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

// ISO (UTC) → «yyMMddHHmm» по Берлину, формат времени DB Timetables.
export function toIris(iso: string): string {
  const p = Object.fromEntries(berlinParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}`;
}

// «yyMMddHHmm» по Берлину → ISO в UTC.
export function fromIris(t: string): string {
  return berlinToUtc(`20${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}T${t.slice(6, 8)}:${t.slice(8, 10)}`).replace('.000Z', 'Z');
}
