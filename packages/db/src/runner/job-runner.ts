import type { JobRepository } from "../repository/job-repo.js";
import type { Job } from "@messenger/contracts";
import { randomUUID } from "node:crypto";

export interface JobExecutionContext {
  signal: AbortSignal;
  job: Job;
  ownerToken: string;
  fencingEpoch: number;
}

export type JobHandler = (context: JobExecutionContext) => Promise<Record<string, unknown> | void>;

export interface JobRunnerConfig {
  jobRepo: JobRepository;
  queues?: string[];
  ownerToken?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationSeconds?: number;
  heartbeatIntervalMs?: number;
  reconcileIntervalMs?: number;
  retryDelaySeconds?: number;
}

export class JobRunner {
  private jobRepo: JobRepository;
  private queues: string[];
  private ownerToken: string;
  private concurrency: number;
  private pollIntervalMs: number;
  private leaseDurationSeconds: number;
  private heartbeatIntervalMs: number;
  private reconcileIntervalMs: number;
  private retryDelaySeconds: number;

  private handlers = new Map<string, JobHandler>();
  private running = false;
  private activeJobsCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;

  constructor(config: JobRunnerConfig) {
    this.jobRepo = config.jobRepo;
    this.queues = config.queues || ["default"];
    this.ownerToken = config.ownerToken || `runner-${randomUUID()}`;
    this.concurrency = config.concurrency || 1;
    this.pollIntervalMs = config.pollIntervalMs || 250;
    this.leaseDurationSeconds = config.leaseDurationSeconds || 60;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 15000;
    this.reconcileIntervalMs = config.reconcileIntervalMs || 30000;
    this.retryDelaySeconds = config.retryDelaySeconds || 5;
  }

  registerHandler(jobType: string, handler: JobHandler): this {
    this.handlers.set(jobType, handler);
    return this;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    this.schedulePoll();
    this.scheduleReconcile();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
    }

    // Wait for in-flight jobs to complete
    const startTime = Date.now();
    while (this.activeJobsCount > 0 && Date.now() - startTime < 10000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private schedulePoll(delayMs = this.pollIntervalMs): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      await this.pollAndExecute();
      this.schedulePoll();
    }, delayMs);
  }

  private scheduleReconcile(): void {
    if (!this.running) return;
    this.reconcileTimer = setInterval(async () => {
      try {
        await this.jobRepo.reconcileStaleJobs();
      } catch (err) {
        console.error("[JobRunner] Reconcile error:", err);
      }
    }, this.reconcileIntervalMs);
  }

  private async pollAndExecute(): Promise<void> {
    if (!this.running || this.activeJobsCount >= this.concurrency) {
      return;
    }

    try {
      const jobRow = await this.jobRepo.claimNext({
        queue: this.queues,
        ownerToken: this.ownerToken,
        leaseDurationSeconds: this.leaseDurationSeconds,
      });

      if (!jobRow) return;

      this.activeJobsCount++;
      // Run execution asynchronously to not block poller if concurrency > 1
      this.executeJob(jobRow as unknown as Job).finally(() => {
        this.activeJobsCount--;
      });
    } catch (err) {
      console.error("[JobRunner] Claim polling error:", err);
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.jobType);
    const fencingEpoch = job.fencingEpoch;
    const ownerToken = this.ownerToken;

    if (!handler) {
      console.error(`[JobRunner] No handler registered for jobType: ${job.jobType}`);
      await this.jobRepo.fail(job.id, ownerToken, fencingEpoch, `No handler for jobType ${job.jobType}`);
      return;
    }

    const jobAbortController = new AbortController();
    const abortSignal = jobAbortController.signal;

    // Heartbeat timer while job is processing
    const heartbeatTimer = setInterval(async () => {
      try {
        const ok = await this.jobRepo.heartbeat(job.id, ownerToken, fencingEpoch, this.leaseDurationSeconds);
        if (!ok) {
          console.warn(`[JobRunner] Heartbeat failed for job ${job.id} (lost lease/fencing)`);
          jobAbortController.abort();
        }
      } catch (err) {
        console.error(`[JobRunner] Heartbeat error for job ${job.id}:`, err);
      }
    }, this.heartbeatIntervalMs);

    try {
      const result = await handler({
        job,
        signal: abortSignal,
        ownerToken,
        fencingEpoch,
      });

      clearInterval(heartbeatTimer);

      const completed = await this.jobRepo.complete(
        job.id,
        ownerToken,
        fencingEpoch,
        result || undefined
      );

      if (!completed) {
        console.warn(`[JobRunner] Failed to complete job ${job.id} (fencing token or owner mismatch)`);
      }
    } catch (err: unknown) {
      clearInterval(heartbeatTimer);
      const error = err as Error;
      console.error(`[JobRunner] Error executing job ${job.id} (${job.jobType}):`, error.message);

      try {
        await this.jobRepo.fail(
          job.id,
          ownerToken,
          fencingEpoch,
          error.message || "Execution error",
          this.retryDelaySeconds
        );
      } catch (failErr) {
        console.error(`[JobRunner] Failed to record job failure for ${job.id}:`, failErr);
      }
    }
  }
}
