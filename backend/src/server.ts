import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from './config.js';
import { redis } from './cache.js';
import { api } from './routes.js';
import { ApiError } from './upstream.js';

await redis.connect().catch((err) => console.error('redis connect', err.message));

const app = express();
app.set('trust proxy', 1); // перед нами ровно один Caddy
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'upgrade-insecure-requests': null,
      'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org'],
    },
  },
  // Политика тайлов OSM требует Referer, а helmet по умолчанию ставит no-referrer.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // HSTS на localhost сломал бы другие локальные http-сервисы; на настоящем домене его ставит Caddy.
  strictTransportSecurity: false,
}));

const limiter = (prefix: string, limit: number) => rateLimit({
  windowMs: 60_000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Пока Redis не готов, считаем в памяти процесса.
  store: redis.isReady
    ? new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args: string[]) => redis.sendCommand(args) })
    : undefined,
  handler: (_req, res) => res.status(429).json({
    ok: false, error: { code: 'RATE_LIMIT', message: 'Слишком много запросов, подождите минуту' },
  }),
});

app.get('/api/health', (_req, res) => res.json({ ok: true, redis: redis.isReady }));
app.use('/api/stations', limiter('st', config.rateLimitPerMin * 2));
app.use('/api', limiter('api', config.rateLimitPerMin));
app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Нет такого метода' } }));

app.use(express.static(config.staticDir, { maxAge: '1h', index: 'index.html' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
});

app.listen(config.port, () => console.log(`db-routes backend on :${config.port}, upstream ${config.upstream}`));
