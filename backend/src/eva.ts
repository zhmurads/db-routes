// Сопоставление остановки (координаты из Transitous) с номерами станций DB (EVA).
// Справочник: backend/data/db-stations.json, собирается scripts/build-stations.mjs из npm-пакета db-stations.
import { readFileSync } from 'node:fs';

type Row = [eva: string, lat: number, lon: number, name: string];

const CELL = 0.01; // ~1 км по широте
const RADIUS_M = 400;

const rows: Row[] = JSON.parse(readFileSync(new URL('../data/db-stations.json', import.meta.url), 'utf8'));
const grid = new Map<string, Row[]>();
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
for (const r of rows) {
  const k = cellKey(r[1], r[2]);
  const list = grid.get(k);
  if (list) list.push(r);
  else grid.set(k, [r]);
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

export const stationCount = rows.length;
