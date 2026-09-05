import type { FastifyRequest, FastifyReply } from "fastify";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
}

export class InMemoryRateLimiter {
  private records = new Map<string, RateLimitRecord>();
  private maxRequests: number;
  private windowMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: RateLimiterOptions = {}) {
    this.maxRequests = options.maxRequests ?? 120;
    this.windowMs = options.windowMs ?? 60000;

    // Prune expired entries periodically to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.prune();
    }, 60000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (record.resetAt <= now) {
        this.records.delete(key);
      }
    }
  }

  getIp(request: FastifyRequest): string {
    const cfIp = request.headers["cf-connecting-ip"] as string | undefined;
    if (cfIp) return cfIp;

    const xForwardedFor = request.headers["x-forwarded-for"] as string | undefined;
    if (xForwardedFor) {
      const first = xForwardedFor.split(",")[0]?.trim();
      if (first) return first;
    }

    return request.ip || "127.0.0.1";
  }

  async checkRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    // Whitelist health probes
    if (
      request.url === "/healthz" ||
      request.url === "/readyz" ||
      request.url === "/health" ||
      request.url.startsWith("/health?")
    ) {
      return true;
    }

    const ip = this.getIp(request);
    const now = Date.now();
    const record = this.records.get(ip);

    if (!record || record.resetAt <= now) {
      this.records.set(ip, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return true;
    }

    record.count++;

    if (record.count > this.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      reply.header("Retry-After", retryAfterSeconds);
      reply.status(429).send({
        error: "Too many requests. Please try again later.",
        retryAfter: retryAfterSeconds,
      });
      return false;
    }

    return true;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.records.clear();
  }
}
