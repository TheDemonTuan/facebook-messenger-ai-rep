import type { SystemSettings } from "@messenger/contracts";
import { globalMediaCache } from "./cache.js";

export interface SystemResourceMetrics {
  timestamp: Date;
  memory: {
    heapUsedMb: number;
    heapTotalMb: number;
    rssMb: number;
    externalMb: number;
  };
  mediaCache: {
    totalBytes: number;
    totalBytesMb: number;
    itemCount: number;
  };
  cpu: {
    userMicros: number;
    systemMicros: number;
  };
}

export interface ResourceQuotaCheckResult {
  withinLimits: boolean;
  warnings: string[];
  metrics: SystemResourceMetrics;
  throttledReason?: string;
}

/**
 * Gathers lightweight, non-blocking metrics on current system RAM, CPU, and media cache storage.
 */
export function getSystemResourceMetrics(): SystemResourceMetrics {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const cacheBytes = globalMediaCache.getTotalBytes();
  const cacheCount = globalMediaCache.getItemCount();

  return {
    timestamp: new Date(),
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      externalMb: Math.round(mem.external / (1024 * 1024)),
    },
    mediaCache: {
      totalBytes: cacheBytes,
      totalBytesMb: Math.round(cacheBytes / (1024 * 1024)),
      itemCount: cacheCount,
    },
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
    },
  };
}

/**
 * Evaluates current resource utilization against configured system thresholds.
 * Emits warnings when approaching limits and signals throttling when critical limits are breached.
 */
export function checkResourceQuota(
  settings: Partial<SystemSettings> = {}
): ResourceQuotaCheckResult {
  const metrics = getSystemResourceMetrics();
  const warnings: string[] = [];

  const maxRamMb = settings.mediaMaxRamMb ?? 1024;
  const storageQuotaMb = settings.mediaStorageQuotaMb ?? 512;

  // 1. Check RAM usage against ceiling
  const currentRamMb = metrics.memory.rssMb;
  const ramRatio = currentRamMb / maxRamMb;

  if (ramRatio >= 0.95) {
    warnings.push(`CRITICAL_MEMORY_USAGE: RSS ${currentRamMb}MB has reached 95% of ${maxRamMb}MB threshold.`);
  } else if (ramRatio >= 0.85) {
    warnings.push(`HIGH_MEMORY_USAGE: RSS ${currentRamMb}MB exceeds 85% of ${maxRamMb}MB threshold.`);
  }

  // 2. Check in-memory media cache storage against quota
  const currentCacheMb = metrics.mediaCache.totalBytesMb;
  const cacheRatio = currentCacheMb / storageQuotaMb;

  if (cacheRatio >= 0.95) {
    warnings.push(`CRITICAL_CACHE_STORAGE: Cache ${currentCacheMb}MB has reached 95% of ${storageQuotaMb}MB quota.`);
  } else if (cacheRatio >= 0.85) {
    warnings.push(`HIGH_CACHE_STORAGE: Cache ${currentCacheMb}MB exceeds 85% of ${storageQuotaMb}MB quota.`);
  }

  const withinLimits = ramRatio < 0.95 && cacheRatio < 0.95;
  const throttledReason = !withinLimits
    ? ramRatio >= 0.95
      ? "SYSTEM_MEMORY_THRESHOLD_EXCEEDED"
      : "MEDIA_CACHE_QUOTA_EXCEEDED"
    : undefined;

  return {
    withinLimits,
    warnings,
    metrics,
    throttledReason,
  };
}
