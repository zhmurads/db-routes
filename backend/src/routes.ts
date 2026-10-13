import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { cached } from './cache.js';
import { config } from './config.js';
import { ApiError, upstream } from './upstream.js';
import * as N from './normalize.js';
import { berlinToUtc } from './time.js';
import { enrichWithDb } from './enrich.js';

export const api = Router();

const str = (req: Request, name: string): string => {
  const v = req.query[name];
  return typeof v === 'string' ? v.trim() : '';
};
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 20);

const ok = (data: unknown) => ({ ok: true, data, updatedAt: new Date().toISOString() });

// Точка — либо id остановки, либо координаты «широта,долгота» (местоположение пользователя).
const COORD = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;
function coords(v: string): { lat: number; lon: number } | null {
  const m = COORD.exec(v);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ApiError(400, 'BAD_PLACE', 'Неверные координаты');
  return { lat, lon };
}
// Округление до 5 знаков (~1 м): точнее не нужно, а кэш попадает чаще.
const place = (v: string) => {
  const c = coords(v);
  return c ? `${c.lat.toFixed(5)},${c.lon.toFixed(5)}` : v;
};
// Сколько можно идти пешком от/до точки-координаты до станции.
const WALK_FROM_POINT_S = 1200;

// Автодополнение станций.
api.get('/stations', async (req, res) => {
  const q = str(req, 'q');
  if (q.length < 2) return res.json(ok([]));
  if (q.length > 80) throw new ApiError(400, 'BAD_QUERY', 'Слишком длинный запрос');
  const key = `st:${config.language}:${q.toLowerCase()}`;
  const data = await cached(key, 24 * 3600, async () => {
    const matches = await upstream<N.MMatch[]>('/api/v1/geocode', {
      text: q, type: 'STOP', numResults: 8, language: config.language,
    });
    return matches.map(N.station);
  });
  res.json(ok(data));
});

// Поиск маршрутов.
api.get('/journeys', async (req, res) => {
  const from = str(req, 'from');
  const to = str(req, 'to');
  if (!from || !to) throw new ApiError(400, 'MISSING_STATION', 'Укажите станции «Откуда» и «Куда»');
  if (from === to) throw new ApiError(400, 'SAME_STATION', 'Станции отправления и прибытия совпадают');

  const products = (str(req, 'products') || N.PRODUCTS.join(',')).split(',').filter((p) => p in N.PRODUCT_MODES);
  if (!products.length) throw new ApiError(400, 'NO_PRODUCTS', 'Выберите хотя бы один вид транспорта');
  const allProducts = products.length === N.PRODUCTS.length;

  const transferTime = Math.min(Math.max(Number(str(req, 'transferTime')) || 0, 0), 60);
  const when = str(req, 'when');
  const cursor = str(req, 'cursor');
  const via = str(req, 'via');

  const query = {
    fromPlace: place(from),
    toPlace: place(to),
    maxPreTransitTime: coords(from) ? WALK_FROM_POINT_S : undefined,
    maxPostTransitTime: coords(to) ? WALK_FROM_POINT_S : undefined,
    via: via || undefined,
    time: when ? berlinToUtc(when) : undefined,
    arriveBy: str(req, 'mode') === 'arr' ? true : undefined,
    // Все группы = значение по умолчанию TRANSIT (там ещё самолёты и прочее, но так надёжнее).
    transitModes: allProducts ? undefined : products.flatMap((p) => N.PRODUCT_MODES[p]).join(','),
    minTransferTime: transferTime || undefined,
    pageCursor: cursor || undefined,
    numItineraries: 5,
    detailedLegs: false,
    detailedTransfers: false,
    directModes: '', // пешие прямые маршруты не нужны
    language: config.language,
  };
  // Без явного времени «сейчас» меняется каждую минуту — кэш короткий.
  const key = `pl:${hash(JSON.stringify(query))}`;
  const data = await cached(key, 30, async () => N.plan(await upstream<N.MPlan>('/api/v6/plan', query)));
  res.json(ok(data));
});

// Обновление одного маршрута по его id (аналог refreshToken).
// Его вызывает только раскрытая карточка, поэтому здесь же отдаём геометрию для карты.
api.get('/journeys/refresh', async (req, res) => {
  const id = str(req, 'id');
  if (!id) throw new ApiError(400, 'MISSING_ID', 'Не передан идентификатор маршрута');
  if (id.length > 4000) throw new ApiError(400, 'BAD_ID', 'Слишком длинный идентификатор');
  const key = `rf:${hash(id)}`;
  const data = await cached(key, 15, async () => {
    const j = N.journey(await upstream<N.MItinerary>('/api/v6/refresh-itinerary', {
      itineraryId: id, detailedLegs: true, detailedTransfers: true, language: config.language,
    }));
    // Поезда DB сверяем с табло DB (если задан ключ Timetables API).
    await enrichWithDb(j);
    return j;
  });
  res.json(ok(data));
});

// Адрес по координатам — подпись для «Моё местоположение».
api.get('/reverse', async (req, res) => {
  const c = coords(`${str(req, 'lat')},${str(req, 'lon')}`);
  if (!c) throw new ApiError(400, 'BAD_PLACE', 'Неверные координаты');
  const at = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`; // ~10 м
  const data = await cached(`rv:${at}`, 24 * 3600, async () => {
    const m = await upstream<N.MMatch[]>('/api/v1/reverse-geocode', { place: at, numResults: 1 });
    const a = m[0] as (N.MMatch & { street?: string; houseNumber?: string }) | undefined;
    if (!a) return { name: null };
    const name = a.street ? `${a.street}${a.houseNumber ? ' ' + a.houseNumber : ''}` : a.name;
    return { name };
  });
  res.json(ok(data));
});

// Время пешком от точки (местоположение пользователя) до станций: минуты или null (недостижимо / дольше часа).
const WALK_MAX_POINTS = 20;
api.get('/walk', async (req, res) => {
  const from = coords(str(req, 'from'));
  const to = str(req, 'to').split('|').filter(Boolean).map(coords);
  if (!from || !to.length || to.some((c) => !c)) throw new ApiError(400, 'BAD_PLACE', 'Неверные координаты');
  if (to.length > WALK_MAX_POINTS) throw new ApiError(400, 'TOO_MANY', `Не больше ${WALK_MAX_POINTS} станций за раз`);
  const r4 = (c: { lat: number; lon: number }) => `${c.lat.toFixed(4)};${c.lon.toFixed(4)}`;
  const one = r4(from);
  const many = (to as { lat: number; lon: number }[]).map(r4);
  const data = await cached(`wk:${hash(one + '>' + many.join(','))}`, 24 * 3600, async () => {
    const r = await upstream<{ duration?: number }[]>('/api/v1/one-to-many', {
      one, many: many.join(','), mode: 'WALK', max: 3600, maxMatchingDistance: 250, arriveBy: false,
    });
    return r.map((x) => (typeof x.duration === 'number' ? Math.ceil(x.duration / 60) : null));
  });
  res.json(ok(data));
});
