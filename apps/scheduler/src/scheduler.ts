import { Worker, type Job } from "bullmq";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  EventRepository,
  SettingsRepository,
} from "@messenger/db";
import { conversations, conversationQueue } from "@messenger/db";
import { eq, and, sql, lte } from "drizzle-orm";
import type {
  AppQueues,
  LeaseManager,
  DebounceManager,
  DebounceJobData,
} from "@messenger/queue";
import { QUEUE_NAMES } from "@messenger/queue";
import type { Redis } from "ioredis";

export interface SchedulerConfig {
  channelAccountId: string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
}

export class SchedulerService {
  private isRunning: boolean = false;
  private loopTimeout: NodeJS.Timeout | null = null;
  private debounceWorker: Worker<DebounceJobData> | null = null;

  get active(): boolean {
    return this.isRunning;
  }

  constructor(
    private db: Database,
    private redis: Redis,
    private queues: AppQueues,
    private leaseManager: LeaseManager,
    private debounceManager: DebounceManager,
    private convRepo: ConversationRepository,
    private queueRepo: QueueRepository,
    private eventRepo: EventRepository,
    private settingsRepo: SettingsRepository,
    private config: SchedulerConfig
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[Scheduler] Starting scheduler for channel: ${this.config.channelAccountId}...`);

    // 1. Reconcile any stale claims from previous crash/restart
    await this.reconcileStaleClaims();

    // 2. Start BullMQ debounce worker
    this.startDebounceWorker();

    // 3. Start main scheduling loop
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
      this.loopTimeout = null;
    }
    if (this.debounceWorker) {
      await this.debounceWorker.close();
      this.debounceWorker = null;
    }
    console.log(`[Scheduler] Stopped scheduler for channel: ${this.config.channelAccountId}`);
  }

  /**
   * Recovers stale claims where lease expired while service was offline/restarted.
   */
  async reconcileStaleClaims(): Promise<void> {
    const now = new Date();
    const channelAccountId = this.config.channelAccountId;

    try {
      // Find conversations in volatile active statuses with expired leases
      const staleItems = await this.db
        .select({
          queueId: conversationQueue.id,
          conversationId: conversationQueue.conversationId,
          claimToken: conversationQueue.claimToken,
        })
        .from(conversationQueue)
        .innerJoin(conversations, eq(conversationQueue.conversationId, conversations.id))
        .where(
          and(
            eq(conversationQueue.channelAccountId, channelAccountId),
            lte(conversationQueue.leaseExpiresAt, now),
            sql`${conversations.status} IN ('CLAIMED', 'READING', 'THINKING', 'DRAFT_READY', 'TYPING', 'SENDING')`
          )
        );

      for (const item of staleItems) {
        console.warn(`[Scheduler] Reconciling stale claim for conversation: ${item.conversationId}`);
        await this.db
          .update(conversations)
          .set({
            status: "QUEUED",
            claimToken: null,
            claimedAt: null,
            updatedAt: now,
          })
          .where(eq(conversations.id, item.conversationId));

        await this.db
          .update(conversationQueue)
          .set({
            claimToken: null,
            leaseExpiresAt: null,
            readyAt: now, // Ready to be picked up immediately
            updatedAt: now,
          })
          .where(eq(conversationQueue.id, item.queueId));

        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId: item.conversationId,
          type: "CONVERSATION_RELEASED",
          actor: "SCHEDULER_RECONCILIATION",
          payload: { reason: "Lease expired during downtime or crash" },
        });
      }
    } catch (err) {
      console.error("[Scheduler] Error during stale claims reconciliation:", err);
    }
  }

  private startDebounceWorker(): void {
    this.debounceWorker = new Worker<DebounceJobData>(
      QUEUE_NAMES.INBOUND_DEBOUNCE,
      async (job: Job<DebounceJobData>) => {
        const data = job.data;
        const isExpired = await this.debounceManager.isDebounceExpired(data);

        if (!isExpired) {
          // Newer message was received; debounce timer was reset
          return;
        }

        const now = new Date();
        // Transition conversation from DEBOUNCING to QUEUED
        await this.db
          .update(conversations)
          .set({
            status: "QUEUED",
            updatedAt: now,
          })
          .where(
            and(
              eq(conversations.id, data.conversationId),
              eq(conversations.inboundVersion, data.inboundVersion),
              eq(conversations.status, "DEBOUNCING")
            )
          );

        // Update queue readyAt
        await this.db
          .update(conversationQueue)
          .set({
            readyAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(conversationQueue.conversationId, data.conversationId),
              eq(conversationQueue.inboundVersion, data.inboundVersion)
            )
          );

        await this.eventRepo.recordEvent({
          channelAccountId: data.channelAccountId,
          conversationId: data.conversationId,
          type: "CONVERSATION_QUEUED",
          inboundVersion: data.inboundVersion,
          actor: "DEBOUNCE_TIMER",
          payload: { readyAt: now },
        });
      },
      {
        connection: this.redis,
        concurrency: 5,
      }
    );

    this.debounceWorker.on("error", (err) => {
      console.error("[Scheduler] Debounce worker error:", err);
    });
  }

  private scheduleNextTick(delayMs?: number): void {
    if (!this.isRunning) return;
    const interval = delayMs !== undefined ? delayMs : this.config.pollIntervalMs || 500;
    this.loopTimeout = setTimeout(() => {
      this.dispatchTurn()
        .catch((err) => {
          console.error("[Scheduler] Error in dispatch loop:", err);
        })
        .finally(() => {
          this.scheduleNextTick();
        });
    }, interval);
  }

  /**
   * Main single-agent dispatcher:
   * Guarantees only one claimed conversation per channel account.
   */
  async dispatchTurn(): Promise<void> {
    const channelAccountId = this.config.channelAccountId;

    // 1. Maintain leader lock for this scheduler process
    const schedulerLeaseKey = `scheduler:${channelAccountId}`;
    const lease = await this.leaseManager.acquire(schedulerLeaseKey, 5000);
    // If not acquired, renew if we already hold it
    if (!lease) {
      // Another scheduler replica is currently leader
      return;
    }

    try {
      // 2. Fetch runtime settings
      const { settings } = await this.settingsRepo.getSettings(channelAccountId);

      if (settings.pauseIntakeProcessing || !settings.autoReplyEnabled) {
        return;
      }

      // 3. Atomically attempt to claim the next eligible conversation
      const claim = await this.queueRepo.claimNext(channelAccountId, {
        leaseDurationMs: this.config.leaseDurationMs || 30000,
        stickyWindowMs: settings.stickyWindowMs,
        stickyMaxTurns: settings.stickyMaxTurns,
        stickyMaxDurationMs: settings.stickyMaxDurationMs,
      });

      if (!claim) {
        // No ready item or channel busy/serving another conversation
        return;
      }

      console.log(
        `[Scheduler] Claimed conversation ${claim.conversationId} (version=${claim.inboundVersion}, sticky=${claim.isSticky}, turns=${claim.stickyTurns})`
      );

      // 4. Record event
      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId: claim.conversationId,
        type: "CONVERSATION_CLAIMED",
        inboundVersion: claim.inboundVersion,
        actor: "SCHEDULER",
        payload: {
          claimToken: claim.claimToken,
          fencingToken: claim.fencingToken,
          isSticky: claim.isSticky,
          stickyTurns: claim.stickyTurns,
        },
      });

      // 5. Dispatch job to AI worker
      await this.queues.aiJobs.add(
        "generate-reply",
        {
          channelAccountId,
          conversationId: claim.conversationId,
          inboundVersion: claim.inboundVersion,
          claimToken: claim.claimToken,
          fencingToken: claim.fencingToken,
        },
        {
          jobId: `ai_${channelAccountId}_${claim.conversationId}_${claim.inboundVersion}`,
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    } finally {
      // Release or let TTL expire
      await this.leaseManager.release(schedulerLeaseKey, lease.token);
    }
  }
}
