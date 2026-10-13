// Сборка справочника станций DB: номер EVA, координаты, имя, IFOPT.
//
//   node scripts/build-stations.mjs                       — из StaDa (DB API Marketplace, нужен ключ в .env и подписка Free4All)
//   node scripts/build-stations.mjs --from-npm <ndjson>   — запасной вариант из npm-пакета db-stations (data.ndjson, без IFOPT)
//
// Пишет backend/data/db-stations.json: [[eva, lat, lon, name, ifopt|null], …] — по строке на каждый номер EVA станции.
import fs from 'node:fs';

const OUT = new URL('../backend/data/db-stations.json', import.meta.url);
const round = (x) => +Number(x).toFixed(5);

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function fromStada() {
  const env = { ...readEnv(), ...process.env };
  if (!env.DB_CLIENT_ID || !env.DB_API_KEY) throw new Error('В .env нет DB_CLIENT_ID / DB_API_KEY');
  const res = await fetch('https://apis.deutschebahn.com/db-api-marketplace/apis/station-data/v2/stations?limit=10000', {
    headers: { 'DB-Client-Id': env.DB_CLIENT_ID, 'DB-Api-Key': env.DB_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`StaDa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.total > body.result.length) console.error(`внимание: получено ${body.result.length} из ${body.total}`);
  const rows = [];
  for (const s of body.result) {
    for (const e of s.evaNumbers ?? []) {
      const c = e.geographicCoordinates?.coordinates;
      if (!c) continue;
      rows.push([String(e.number), round(c[1]), round(c[0]), s.name, s.ifopt ?? null]);
    }
  }
  return { rows, stations: body.result.length };
}

function fromNpm(path) {
  const rows = fs.readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((s) => s.id && s.location)
    .map((s) => [s.id, round(s.location.latitude), round(s.location.longitude), s.name, null]);
  return { rows, stations: rows.length };
}

const i = process.argv.indexOf('--from-npm');
const { rows, stations } = i > 0 ? fromNpm(process.argv[i + 1]) : await fromStada();

// Сравнение с прежним справочником.
let before = [];
try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* первого запуска нет */ }
const oldEva = new Set(before.map((r) => r[0]));
const newEva = new Set(rows.map((r) => r[0]));
const added = [...newEva].filter((e) => !oldEva.has(e)).length;
const removed = [...oldEva].filter((e) => !newEva.has(e)).length;

fs.writeFileSync(OUT, JSON.stringify(rows));
console.error(`станций: ${stations}, номеров EVA: ${rows.length}, с IFOPT: ${rows.filter((r) => r[4]).length}`);
console.error(`по сравнению с прежним справочником: +${added} EVA, −${removed} EVA (было ${oldEva.size})`);
