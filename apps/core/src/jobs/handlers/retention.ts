import type { JobExecutionContext } from "@messenger/db";
import type { JobRepository, OutboxRepository } from "@messenger/db";

export interface RetentionJobPayload {
  jobRetentionDays?: number;
  outboxRetentionDays?: number;
}

export interface RetentionHandlerDeps {
  jobRepo: JobRepository;
  outboxRepo: OutboxRepository;
}

export function createRetentionHandler(deps: RetentionHandlerDeps) {
  const { jobRepo, outboxRepo } = deps;

  return async function handleRetention(context?: JobExecutionContext): Promise<Record<string, unknown>> {
    const payload = (context?.job?.payload || {}) as RetentionJobPayload;
    const jobRetentionDays = payload.jobRetentionDays ?? 7;
    const outboxRetentionDays = payload.outboxRetentionDays ?? 7;

    const cleanedJobs = await jobRepo.cleanOldJobs(jobRetentionDays);
    const cleanedOutbox = await outboxRepo.cleanProcessedEvents(outboxRetentionDays);

    console.log(
      `[RetentionHandler] Cleaned ${cleanedJobs} old jobs and ${cleanedOutbox} processed outbox events.`
    );

    return {
      cleanedJobs,
      cleanedOutboxEvents: cleanedOutbox,
    };
  };
}
