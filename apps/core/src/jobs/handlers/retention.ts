import type { JobExecutionContext } from "@messenger/db";
import type { JobRepository, OutboxRepository, ConversationRepository } from "@messenger/db";
import { globalMediaCache, checkResourceQuota } from "@messenger/ai";

export interface RetentionJobPayload {
  jobRetentionDays?: number;
  outboxRetentionDays?: number;
  messageRetentionDays?: number;
  aiRunRetentionDays?: number;
}

export interface RetentionHandlerDeps {
  jobRepo: JobRepository;
  outboxRepo: OutboxRepository;
  convRepo?: ConversationRepository;
}

export function createRetentionHandler(deps: RetentionHandlerDeps) {
  const { jobRepo, outboxRepo, convRepo } = deps;

  return async function handleRetention(context?: JobExecutionContext): Promise<Record<string, unknown>> {
    const payload = (context?.job?.payload || {}) as RetentionJobPayload;
    const jobRetentionDays = payload.jobRetentionDays ?? 7;
    const outboxRetentionDays = payload.outboxRetentionDays ?? 7;
    const messageRetentionDays = payload.messageRetentionDays ?? 30;
    const aiRunRetentionDays = payload.aiRunRetentionDays ?? 30;

    const cleanedJobs = await jobRepo.cleanOldJobs(jobRetentionDays);
    const cleanedOutbox = await outboxRepo.cleanProcessedEvents(outboxRetentionDays);
    let cleanedMessages = 0;
    let cleanedAiRuns = 0;

    if (convRepo && typeof convRepo.cleanOldMessages === "function") {
      cleanedMessages = await convRepo.cleanOldMessages(messageRetentionDays);
    }
    if (convRepo && typeof convRepo.cleanOldAiRuns === "function") {
      cleanedAiRuns = await convRepo.cleanOldAiRuns(aiRunRetentionDays);
    }

    // Media cache eviction of expired items and resource quota checking
    const evictedMediaCacheItems = globalMediaCache.evictExpired();
    const quotaMetrics = checkResourceQuota();

    if (quotaMetrics.warnings.length > 0) {
      console.warn("[RetentionHandler] Resource quota warnings:", quotaMetrics.warnings);
    }

    console.log(
      `[RetentionHandler] Cleaned ${cleanedJobs} old jobs, ${cleanedOutbox} processed outbox events, ${cleanedMessages} old messages, ${cleanedAiRuns} old AI runs, evicted ${evictedMediaCacheItems} expired media cache items.`
    );

    const output: Record<string, unknown> = {
      cleanedJobs,
      cleanedOutboxEvents: cleanedOutbox,
      evictedMediaCacheItems,
      mediaCacheBytes: quotaMetrics.metrics.mediaCache.totalBytes,
      mediaCacheBytesMb: quotaMetrics.metrics.mediaCache.totalBytesMb,
      mediaCacheCount: quotaMetrics.metrics.mediaCache.itemCount,
      systemMemoryMb: quotaMetrics.metrics.memory.rssMb,
      warnings: quotaMetrics.warnings,
    };

    if (convRepo) {
      output.cleanedMessages = cleanedMessages;
      output.cleanedAiRuns = cleanedAiRuns;
    }

    return output;
  };
}
