import { Redis } from "ioredis";
import { getEnv } from "@messenger/config";

let globalRedis: Redis | null = null;

export function getRedis(url?: string): Redis {
  if (!globalRedis) {
    const connectionUrl = url || getEnv().REDIS_URL;
    globalRedis = new Redis(connectionUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });

    globalRedis.on("error", (err) => {
      console.error("Redis connection error:", err.message);
    });
  }
  return globalRedis;
}

export async function closeRedis(): Promise<void> {
  if (globalRedis) {
    await globalRedis.quit();
    globalRedis = null;
  }
}
