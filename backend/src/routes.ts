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
    fromPlace: from,
    toPlace: to,
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
