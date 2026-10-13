import { createClient } from 'redis';
import { config } from './config.js';

export const redis = createClient({ url: config.redisUrl });
redis.on('error', (err) => console.error('redis', err.message));

// Кэш — оптимизация: если Redis недоступен, просто идём в upstream.
export async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  if (redis.isReady) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch (err) {
      console.error('redis get', (err as Error).message);
    }
  }
  const value = await load();
  if (redis.isReady) redis.set(key, JSON.stringify(value), { EX: ttlSec }).catch(() => {});
  return value;
}
