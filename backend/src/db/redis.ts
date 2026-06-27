import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Minimal cache interface QTI uses: get/set with TTL/expire, and del.
 * In dev we run an in-process Map-backed shim so the stack boots without Redis.
 * In prod USE_INMEM_CACHE=false flips to ioredis.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "EX", ttlSeconds?: number): Promise<"OK" | null>;
  del(key: string): Promise<number>;
}

class InMemoryCache implements CacheClient {
  private map = new Map<string, { v: string; exp?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.exp != null && entry.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.v;
  }

  async set(key: string, value: string, _mode?: "EX", ttlSeconds?: number): Promise<"OK"> {
    const exp = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.map.set(key, { v: value, exp });
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.map.delete(key) ? 1 : 0;
  }
}

function createClient(): CacheClient {
  if (env.useInmemCache) {
    logger.info("Cache: in-memory");
    return new InMemoryCache();
  }
  const r = new Redis(env.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  logger.info("Cache: Redis", { url: env.redisUrl });
  return r as unknown as CacheClient;
}

export const redis: CacheClient = createClient();

export async function connectRedis(): Promise<void> {
  // No-op: connection initialised eagerly in createClient.
}
