// Сборка компактного справочника станций DB (EVA + координаты) из пакета db-stations.
// Запуск: node scripts/build-stations.mjs <путь к db-stations/data.ndjson> > backend/data/db-stations.json
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const out = lines.map((l) => JSON.parse(l))
  .filter((s) => s.id && s.location)
  .map((s) => [s.id, +s.location.latitude.toFixed(5), +s.location.longitude.toFixed(5), s.name]);
process.stdout.write(JSON.stringify(out));
