import { config } from './config.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

// GET к Transitous (MOTIS 2) с таймаутом и понятными ошибками.
export async function upstream<T>(path: string, query: Query): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  const url = `${config.upstream}${path}?${qs}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    console.error('upstream fetch failed', path, (err as Error).message);
    throw new ApiError(502, timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      timeout ? 'Сервер расписаний не ответил вовремя' : 'Сервер расписаний недоступен');
  }

  if (res.status === 429) throw new ApiError(503, 'UPSTREAM_RATE_LIMIT', 'Сервер расписаний просит подождать, попробуйте через минуту');
  if (res.status >= 400 && res.status < 500) {
    console.error('upstream', res.status, path, (await res.text()).slice(0, 300));
    throw new ApiError(400, 'UPSTREAM_BAD_REQUEST', 'Сервер расписаний не смог обработать запрос');
  }
  if (!res.ok) {
    console.error('upstream', res.status, path);
    throw new ApiError(502, 'UPSTREAM_ERROR', `Ошибка сервера расписаний (${res.status})`);
  }
  return (await res.json()) as T;
}
