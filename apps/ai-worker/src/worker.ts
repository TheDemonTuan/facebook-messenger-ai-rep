import { Worker, type Job } from "bullmq";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";
import { conversations, aiRuns, aiDrafts } from "@messenger/db";
import { eq, and } from "drizzle-orm";
import type { AppQueues, AiJobData } from "@messenger/queue";
import { QUEUE_NAMES } from "@messenger/queue";
import { AiReplyGenerator } from "@messenger/ai";
import type { Redis } from "ioredis";

export class AiWorkerService {
  private worker: Worker<AiJobData> | null = null;
  private generator = new AiReplyGenerator();

  constructor(
    private db: Database,
    private redis: Redis,
    private queues: AppQueues,
    private convRepo: ConversationRepository,
    private queueRepo: QueueRepository,
    private outboundRepo: OutboundRepository,
    private eventRepo: EventRepository,
    private settingsRepo: SettingsRepository,
    private incidentRepo: IncidentRepository
  ) {}

  start(): void {
    console.log("[AI Worker] Starting worker with concurrency 1...");

    this.worker = new Worker<AiJobData>(
      QUEUE_NAMES.AI_JOBS,
      async (job: Job<AiJobData>) => {
        await this.processJob(job.data);
      },
      {
        connection: this.redis,
        concurrency: 1, // Enforce strictly 1 AI job at a time per worker
      }
    );

    this.worker.on("error", (err) => {
      console.error("[AI Worker] Worker error:", err);
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    console.log("[AI Worker] Worker stopped.");
  }

  async processJob(data: AiJobData): Promise<void> {
    const { channelAccountId, conversationId, inboundVersion, claimToken, fencingToken } = data;

    // 1. Pre-execution check: read conversation state and version
    const convData = await this.convRepo.getConversationById(conversationId);
    if (!convData) {
      console.warn(`[AI Worker] Conversation not found: ${conversationId}`);
      return;
    }

    const { conversation, customer } = convData;

    if (conversation.inboundVersion !== inboundVersion) {
      console.warn(
        `[AI Worker] Stale job: expected version ${inboundVersion} but conversation is at ${conversation.inboundVersion}. Cancelling.`
      );
      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "AI_WORKER",
        payload: {
          jobVersion: inboundVersion,
          actualVersion: conversation.inboundVersion,
        },
      });
      return;
    }

    if (conversation.manualMode || conversation.isBlocked) {
      console.log(`[AI Worker] Skipping conversation ${conversationId}: manualMode=${conversation.manualMode}, blocked=${conversation.isBlocked}`);
      return;
    }

    // 2. Transition state to THINKING
    await this.convRepo.updateStatus(conversationId, "THINKING");
    await this.eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "AI_STARTED",
      inboundVersion,
      actor: "AI_WORKER",
      payload: { claimToken, fencingToken },
    });

    // 3. Gather context and generate reply
    const [recentMessages, { settings }] = await Promise.all([
      this.convRepo.getRecentMessages(conversationId, 20),
      this.settingsRepo.getSettings(channelAccountId),
    ]);

    const result = await this.generator.generateReply({
      customerName: customer.name,
      customerSummary: conversation.summary,
      recentMessages,
      settings,
    });

    // 4. Save AI Run record
    const [runRecord] = await this.db
      .insert(aiRuns)
      .values({
        channelAccountId,
        conversationId,
        inboundVersion,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        latencyMs: result.latencyMs,
        status: result.success ? "SUCCESS" : "GUARD_REJECTED",
        rawResponse: result.rawResponse || null,
        parsedOutput: result.data ? (result.data as unknown as Record<string, unknown>) : null,
        errorMessage: result.errorMessage || null,
      })
      .returning();

    if (!runRecord) {
      throw new Error("Failed to record AI Run in database");
    }

    // 5. Handle generation failure
    if (!result.success || !result.data) {
      console.error(`[AI Worker] Generation rejected for conversation ${conversationId}: ${result.errorMessage}`);

      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "ERROR",
        inboundVersion,
        actor: "AI_WORKER",
        payload: { error: result.errorMessage, rawResponse: result.rawResponse },
      });

      await this.incidentRepo.createIncident({
        channelAccountId,
        conversationId,
        type: "AI_ERROR",
        title: "AI Draft Guard Rejection",
        description: result.errorMessage || "Unknown generation failure",
        metadata: {
          rawResponse: result.rawResponse,
          inboundVersion,
        },
      });

      // Release conversation in ERROR state
      await this.queueRepo.release(conversationId, claimToken, {
        nextStatus: "ERROR",
      });
      return;
    }

    // 6. Post-execution stale check: check inbound version again
    const latestConv = await this.convRepo.getConversationById(conversationId);
    if (!latestConv || latestConv.conversation.inboundVersion !== inboundVersion) {
      console.warn(
        `[AI Worker] Stale after generation: expected version ${inboundVersion}, actual is ${latestConv?.conversation.inboundVersion}. Discarding draft.`
      );
      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "AI_WORKER",
        payload: { reason: "New inbound arrived during generation" },
      });
      return;
    }

    // 7. Save Draft record
    await this.db.insert(aiDrafts).values({
      channelAccountId,
      conversationId,
      aiRunId: runRecord.id,
      inboundVersion,
      messages: result.data.messages,
    });

    await this.convRepo.updateStatus(conversationId, "DRAFT_READY");
    await this.eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "DRAFT_CREATED",
      inboundVersion,
      actor: "AI_WORKER",
      payload: {
        messageCount: result.data.messages.length,
        needsClarification: result.data.needsClarification,
      },
    });

    // 8. Create Outbound Actions and enqueue to browser-actions queue
    await this.convRepo.updateStatus(conversationId, "TYPING");

    for (let i = 0; i < result.data.messages.length; i++) {
      const text = result.data.messages[i];
      if (!text) continue;

      const action = await this.outboundRepo.createAction({
        channelAccountId,
        conversationId,
        inboundVersion,
        responseIndex: i,
        text,
        actor: "AI",
        claimToken,
        fencingToken,
      });

      if (!action) continue;
      console.log(
        `[AI Worker] Enqueueing outbound action ${action.actionId} (conv=${conversationId}, idx=${i}/${result.data.messages.length})`
      );

      await this.queues.browserActions.add(
        "send-action",
        {
          actionId: action.actionId,
          channelAccountId,
          conversationId,
          externalThreadRef: conversation.externalThreadRef,
          inboundVersion,
          responseIndex: i,
          text,
          textHash: action.textHash,
          actor: "AI",
          claimToken,
          fencingToken,
        },
        {
          jobId: `outbound_${action.actionId}`,
          removeOnFail: true,
        }
      );
    }
  }
}
