const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8080),
  redisUrl: env.REDIS_URL ?? 'redis://redis:6379/0',
  upstream: env.TRANSITOUS_URL ?? 'https://api.transitous.org',
  // Политика Transitous: в User-Agent имя приложения, версия и контакт.
  userAgent: `db-routes/0.1.0 (${env.TRANSITOUS_CONTACT || 'personal use'})`,
  language: env.UPSTREAM_LANGUAGE ?? 'de',
  timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 15000),
  rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 60),
  staticDir: env.STATIC_DIR ?? 'public',
  // DB Timetables API (DB API Marketplace). Без ключа сверка с табло DB выключена.
  dbClientId: env.DB_CLIENT_ID ?? '',
  dbApiKey: env.DB_API_KEY ?? '',
  dbBudgetPerMin: Number(env.DB_TT_BUDGET_PER_MIN ?? 50),
};
