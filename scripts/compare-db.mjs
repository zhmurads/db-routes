// Сравнение: Transitous (поиск) против того же маршрута после сверки с табло DB (refresh).
// Запуск: node scripts/compare-db.mjs [https://localhost:8443]
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const B = (process.argv[2] ?? 'https://localhost:8443') + '/api';
const get = async (u) => { const r = await (await fetch(B + u)).json(); if (!r.ok) throw new Error(r.error.message); return r.data; };
const sid = async (q) => (await get('/stations?q=' + encodeURIComponent(q)))[0].id;
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }) : '—');
const fmt = (p) => `${hm(p.planned)}${p.actual ? '→' + hm(p.actual) : ''}${p.delayMin ? ` (${p.delayMin > 0 ? '+' : ''}${p.delayMin})` : ''} пут.${p.platform ?? '?'}${p.cancelled ? ' ОТМЕНА' : ''}`;
const pairs = [['Frankfurt Hbf', 'Köln Hbf'], ['München Hbf', 'Nürnberg Hbf'], ['Berlin Hbf', 'Hamburg Hbf'], ['Hamburg Hbf', 'Hannover Hbf'],
  // региональные и S-Bahn: проверка сопоставления по номеру линии
  ['Berlin Hbf', 'Potsdam Hbf'], ['Köln Hbf', 'Düsseldorf Hbf'], ['München Hbf', 'Freising']];
let pts = 0, db = 0;
for (const [a, b] of pairs) {
  const page = await get(`/journeys?from=${encodeURIComponent(await sid(a))}&to=${encodeURIComponent(await sid(b))}`);
  for (const j of page.journeys.slice(0, 2)) {
    const r = await get('/journeys/refresh?id=' + encodeURIComponent(j.id));
    const legsT = j.legs.filter((l) => !l.walking), legsR = r.legs.filter((l) => !l.walking);
    legsR.forEach((l, i) => {
      for (const k of ['dep', 'arr']) {
        pts++; if (l[k].source === 'db') db++;
        const where = k === 'dep' ? l.origin : l.destination;
        console.log(`${(l.line ?? '').padEnd(10)} ${k} ${where.slice(0, 22).padEnd(22)} T: ${fmt(legsT[i][k]).padEnd(28)} ${l[k].source === 'db' ? 'DB' : '--'}: ${fmt(l[k])}`);
      }
      for (const w of l.warnings.filter((w) => w.source === 'db')) console.log(`           ⚠ DB: ${w.title}`);
    });
    console.log('');
  }
}
console.log(`Сверено с табло DB: ${db} из ${pts} точек`);
