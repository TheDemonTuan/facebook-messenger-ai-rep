import { describe, it, expect, vi } from "vitest";
import { MediaCache, getSystemResourceMetrics, checkResourceQuota } from "../packages/ai/src/index.js";
import { createRetentionHandler } from "../apps/core/src/jobs/handlers/retention.js";
import type { JobRepository, OutboxRepository, ConversationRepository } from "../packages/db/src/index.js";

describe("PR-07 Retention, Quota, Expiry, and Resource Metrics", () => {
  describe("MediaCache eviction & TTL", () => {
    it("evicts expired media cache items on demand", () => {
      const cache = new MediaCache({ ttlMs: 50 }); // 50ms TTL

      cache.set({
        mediaRefId: "item-1",
        mimeType: "image/jpeg",
        byteSize: 100,
        buffer: Buffer.alloc(100),
        base64: "AAAA",
      });

      expect(cache.has("item-1")).toBe(true);
      expect(cache.getItemCount()).toBe(1);
      expect(cache.getTotalBytes()).toBe(100);

      // Simulate passage of time
      const item = cache.get("item-1");
      if (item) {
        item.expiresAt = new Date(Date.now() - 1000); // artificially expire
      }

      const evicted = cache.evictExpired();
      expect(evicted).toBe(1);
      expect(cache.has("item-1")).toBe(false);
      expect(cache.getItemCount()).toBe(0);
      expect(cache.getTotalBytes()).toBe(0);
    });

    it("evicts least recently accessed items when quota is exceeded", () => {
      const cache = new MediaCache({ maxBytesTotal: 300 });

      cache.set({
        mediaRefId: "item-a",
        mimeType: "image/jpeg",
        byteSize: 150,
        buffer: Buffer.alloc(150),
        base64: "AAAA",
      });

      cache.set({
        mediaRefId: "item-b",
        mimeType: "image/jpeg",
        byteSize: 150,
        buffer: Buffer.alloc(150),
        base64: "BBBB",
      });

      expect(cache.getItemCount()).toBe(2);

      // Incoming item-c (150 bytes) exceeds 300 quota -> should evict item-a
      cache.set({
        mediaRefId: "item-c",
        mimeType: "image/jpeg",
        byteSize: 150,
        buffer: Buffer.alloc(150),
        base64: "CCCC",
      });

      expect(cache.has("item-a")).toBe(false);
      expect(cache.has("item-b")).toBe(true);
      expect(cache.has("item-c")).toBe(true);
      expect(cache.getTotalBytes()).toBe(300);
    });
  });

  describe("Resource monitoring & quota warnings", () => {
    it("gathers memory, cache, and cpu metrics", () => {
      const metrics = getSystemResourceMetrics();

      expect(metrics.memory.heapUsedMb).toBeGreaterThan(0);
      expect(metrics.memory.rssMb).toBeGreaterThan(0);
      expect(metrics.mediaCache).toBeDefined();
      expect(metrics.cpu).toBeDefined();
    });

    it("emits warnings when memory ceiling is exceeded", () => {
      // Force an unrealistically low maxRamMb threshold (e.g. 1MB) to verify trigger
      const result = checkResourceQuota({
        mediaMaxRamMb: 1, // 1MB will be exceeded by any running Node/Bun process
      });

      expect(result.withinLimits).toBe(false);
      expect(result.throttledReason).toBe("SYSTEM_MEMORY_THRESHOLD_EXCEEDED");
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("CRITICAL_MEMORY_USAGE");
    });
  });

  describe("Retention Handler integration", () => {
    it("cleans old records, evicts expired media cache, and reports quota metrics", async () => {
      const mockJobRepo = {
        cleanOldJobs: vi.fn().mockResolvedValue(15),
      } as unknown as JobRepository;

      const mockOutboxRepo = {
        cleanProcessedEvents: vi.fn().mockResolvedValue(8),
      } as unknown as OutboxRepository;

      const mockConvRepo = {
        cleanOldMessages: vi.fn().mockResolvedValue(22),
        cleanOldAiRuns: vi.fn().mockResolvedValue(5),
      } as unknown as ConversationRepository;

      const handler = createRetentionHandler({
        jobRepo: mockJobRepo,
        outboxRepo: mockOutboxRepo,
        convRepo: mockConvRepo,
      });

      const result = await handler();

      expect(result.cleanedJobs).toBe(15);
      expect(result.cleanedOutboxEvents).toBe(8);
      expect(result.cleanedMessages).toBe(22);
      expect(result.cleanedAiRuns).toBe(5);
      expect(result.evictedMediaCacheItems).toBeDefined();
      expect(result.mediaCacheBytes).toBeDefined();
      expect(result.systemMemoryMb).toBeDefined();
      expect(Array.isArray(result.warnings)).toBe(true);
    });
  });
});
