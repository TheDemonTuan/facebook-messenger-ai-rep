import { JobRunner } from "@messenger/db";
import type { Database } from "@messenger/db";
import type {
  JobRepository,
  TurnRepository,
  ConversationRepository,
  OutboundRepository,
  SettingsRepository,
  IncidentRepository,
  EventRepository,
  OutboxRepository,
} from "@messenger/db";
import type { AiReplyGenerator } from "@messenger/ai";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import { createDebounceHandler } from "./handlers/debounce.js";
import { createAiHandler } from "./handlers/ai.js";
import { createReconcileHandler } from "./handlers/reconcile.js";
import { createOutboxHandler } from "./handlers/outbox.js";
import { createRetentionHandler } from "./handlers/retention.js";

export interface CoreJobServiceDeps {
  db: Database;
  jobRepo: JobRepository;
  turnRepo: TurnRepository;
  convRepo: ConversationRepository;
  outboundRepo: OutboundRepository;
  settingsRepo: SettingsRepository;
  incidentRepo: IncidentRepository;
  eventRepo: EventRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
  aiGenerator: AiReplyGenerator;
}

export class CoreJobService {
  private runner: JobRunner;
  private outboxTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  private handleReconcile: ReturnType<typeof createReconcileHandler>;
  private handleOutbox: ReturnType<typeof createOutboxHandler>;
  private handleRetention: ReturnType<typeof createRetentionHandler>;

  constructor(deps: CoreJobServiceDeps) {
    this.runner = new JobRunner({
      jobRepo: deps.jobRepo,
      queues: ["default", "debounce", "ai", "system"],
      concurrency: 2,
      pollIntervalMs: 200,
      leaseDurationSeconds: 60,
    });

    const handleDebounce = createDebounceHandler({
      db: deps.db,
      turnRepo: deps.turnRepo,
      jobRepo: deps.jobRepo,
      outboxRepo: deps.outboxRepo,
      eventRepo: deps.eventRepo,
      broadcaster: deps.broadcaster,
    });

    const handleAi = createAiHandler({
      db: deps.db,
      convRepo: deps.convRepo,
      turnRepo: deps.turnRepo,
      outboundRepo: deps.outboundRepo,
      settingsRepo: deps.settingsRepo,
      incidentRepo: deps.incidentRepo,
      eventRepo: deps.eventRepo,
      outboxRepo: deps.outboxRepo,
      broadcaster: deps.broadcaster,
      aiGenerator: deps.aiGenerator,
      jobRepo: deps.jobRepo,
    });

    this.handleReconcile = createReconcileHandler({
      db: deps.db,
      jobRepo: deps.jobRepo,
      eventRepo: deps.eventRepo,
      outboxRepo: deps.outboxRepo,
      broadcaster: deps.broadcaster,
    });

    this.handleOutbox = createOutboxHandler({
      outboxRepo: deps.outboxRepo,
      broadcaster: deps.broadcaster,
    });

    this.handleRetention = createRetentionHandler({
      jobRepo: deps.jobRepo,
      outboxRepo: deps.outboxRepo,
    });

    // Register all 5 job handlers
    this.runner.registerHandler("debounce", handleDebounce);
    this.runner.registerHandler("ai", handleAi);
    this.runner.registerHandler("reconcile", this.handleReconcile);
    this.runner.registerHandler("outbox", this.handleOutbox);
    this.runner.registerHandler("retention", this.handleRetention);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log("[CoreJobService] Starting PostgreSQL job runner and background tasks...");

    // 1. Initial reconciliation on boot
    try {
      await this.handleReconcile();
    } catch (err) {
      console.warn("[CoreJobService] Initial reconcile error:", err);
    }

    // 2. Start runner
    this.runner.start();

    // 3. Periodic Outbox processor (every 1s)
    this.outboxTimer = setInterval(async () => {
      try {
        await this.handleOutbox();
      } catch (err) {
        console.error("[CoreJobService] Periodic outbox error:", err);
      }
    }, 1000);
    if (this.outboxTimer.unref) this.outboxTimer.unref();

    // 4. Periodic Reconcile loop (every 30s)
    this.reconcileTimer = setInterval(async () => {
      try {
        await this.handleReconcile();
      } catch (err) {
        console.error("[CoreJobService] Periodic reconcile error:", err);
      }
    }, 30000);
    if (this.reconcileTimer.unref) this.reconcileTimer.unref();

    // 5. Periodic Retention cleaner (every 1h)
    this.retentionTimer = setInterval(async () => {
      try {
        await this.handleRetention();
      } catch (err) {
        console.error("[CoreJobService] Periodic retention error:", err);
      }
    }, 3600000);
    if (this.retentionTimer.unref) this.retentionTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    console.log("[CoreJobService] Stopping background job service and draining active jobs...");

    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }

    await this.runner.stop();
    console.log("[CoreJobService] Job runner stopped.");
  }
}
