// Сопоставление остановки из Transitous с номерами станций DB (EVA).
// Справочник: backend/data/db-stations.json, собирается scripts/build-stations.mjs из StaDa (или npm db-stations).
import { readFileSync } from 'node:fs';

type Row = [eva: string, lat: number, lon: number, name: string, ifopt?: string | null];

const CELL = 0.01; // ~1 км по широте
const RADIUS_M = 400;

const rows: Row[] = JSON.parse(readFileSync(new URL('../data/db-stations.json', import.meta.url), 'utf8'));
const grid = new Map<string, Row[]>();
const byIfopt = new Map<string, Row[]>();
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
for (const r of rows) {
  const k = cellKey(r[1], r[2]);
  const list = grid.get(k);
  if (list) list.push(r);
  else grid.set(k, [r]);
  if (r[4]) byIfopt.set(r[4], [...(byIfopt.get(r[4]) ?? []), r]);
}

const rad = (x: number) => (x * Math.PI) / 180;
function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = rad(lon2 - lon1) * Math.cos(rad((lat1 + lat2) / 2));
  const y = rad(lat2 - lat1);
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

// Станции DB в радиусе 400 м, ближайшая первой (на крупных узлах их бывает несколько).
export function evasNear(lat: number, lon: number): { eva: string; name: string; distM: number }[] {
  const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
  const found: { eva: string; name: string; distM: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const r of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
        const d = distM(lat, lon, r[1], r[2]);
        if (d <= RADIUS_M) found.push({ eva: r[0], name: r[3], distM: Math.round(d) });
      }
    }
  }
  return found.sort((a, b) => a.distM - b.distM);
}

// Остановка → станции DB: точно по IFOPT из stopId (…_de:09162:100:11:11 → de:09162:100),
// иначе по координатам. IFOPT у DELFI и DB иногда расходится (Berlin Hbf: …3200 и …3201), поэтому радиус остаётся.
export function evasForStop(stopId: string | null, lat: number, lon: number): { eva: string; name: string; distM: number }[] {
  const ifopt = /(?:^|_)(de:\d{5}:\d+)/.exec(stopId ?? '')?.[1];
  const exact = ifopt ? byIfopt.get(ifopt) : undefined;
  if (exact?.length) {
    return exact
      .map((r) => ({ eva: r[0], name: r[3], distM: Math.round(distM(lat, lon, r[1], r[2])) }))
      .sort((a, b) => a.distM - b.distM);
  }
  return evasNear(lat, lon);
}

export const stationCount = rows.length;
