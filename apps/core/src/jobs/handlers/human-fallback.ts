import type { JobExecutionContext } from "@messenger/db";
import type { Database, EventRepository, SettingsRepository } from "@messenger/db";
import { conversations, conversationQueue, jobs, ConversationControlService } from "@messenger/db";
import { eq } from "drizzle-orm";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";
import type { HumanFallbackJobPayload } from "@messenger/contracts";

export interface HumanFallbackHandlerDeps {
  db: Database;
  eventRepo: EventRepository;
  settingsRepo?: SettingsRepository;
  broadcaster: OutboxBroadcaster;
  controlService?: ConversationControlService;
}

export function createHumanFallbackHandler(deps: HumanFallbackHandlerDeps) {
  const { db, eventRepo, broadcaster } = deps;
  const controlService = deps.controlService ?? new ConversationControlService(db);

  return async function handleHumanFallback(context: JobExecutionContext): Promise<void> {
    const payload = context.job.payload as unknown as HumanFallbackJobPayload;
    const { channelAccountId, conversationId, inboundVersion, controlEpoch } = payload;

    if (!channelAccountId || !conversationId || typeof inboundVersion !== "number") {
      console.warn("[HumanFallbackHandler] Missing required payload fields", payload);
      return;
    }

    // 1. Fetch current conversation state
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv) {
      console.warn(`[HumanFallbackHandler] Conversation ${conversationId} not found`);
      return;
    }

    // 2. Stale version check: if inboundVersion moved past this job, ignore
    if (conv.inboundVersion !== inboundVersion) {
      console.log(
        `[HumanFallbackHandler] Stale version: jobVersion=${inboundVersion}, actualVersion=${conv.inboundVersion}. Skipping.`
      );
      return;
    }

    // 3. Stale epoch check: if controlEpoch changed (human sent another message or manual takeover), ignore
    if (typeof controlEpoch === "number" && conv.controlEpoch !== controlEpoch) {
      console.log(
        `[HumanFallbackHandler] Stale epoch: jobEpoch=${controlEpoch}, actualEpoch=${conv.controlEpoch}. Human intervened. Skipping.`
      );
      return;
    }

    // 4. Check if human outbound was sent after this customer inbound
    if (conv.lastHumanOutboundAt && conv.lastInboundAt && conv.lastHumanOutboundAt > conv.lastInboundAt) {
      console.log(
        `[HumanFallbackHandler] Human already replied to conversation ${conversationId} after inbound. Skipping.`
      );
      return;
    }

    // 5. Check if mode is HUMAN_PINNED, REVIEW_HOLD, or BLOCKED
    if (conv.replyControlMode === "HUMAN_PINNED" || conv.replyControlMode === "REVIEW_HOLD" || conv.isBlocked) {
      console.log(
        `[HumanFallbackHandler] Conversation ${conversationId} is in ${conv.replyControlMode} or blocked. Skipping.`
      );
      return;
    }

    // 6. Honor the configured auto-resume policy before changing ownership.
    if (deps.settingsRepo) {
      const { settings } = await deps.settingsRepo.getSettings(channelAccountId);
      if (!settings.autoResumeAfterHuman) {
        console.log(
          `[HumanFallbackHandler] Auto-resume is disabled for channel ${channelAccountId}. Keeping human control.`
        );
        return;
      }
    }

    console.log(
      `[HumanFallbackHandler] Human response grace period expired for conversation ${conversationId}. Resuming AI automatically.`
    );

    const control = await controlService.release(conversationId);

    // 7. Record event AI_RESUMED_AFTER_HUMAN
    await eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "AI_RESUMED_AFTER_HUMAN",
      inboundVersion,
      actor: "SYSTEM",
      payload: {
        reason: "human_response_wait_expired",
        inboundVersion,
        resumedEpoch: control.epoch,
      },
    });

    // 8. Enqueue debounce job immediately for this inboundVersion
    const now = new Date();
    await db
      .update(conversations)
      .set({ status: "DEBOUNCING", updatedAt: now })
      .where(eq(conversations.id, conversationId));

    await db
      .insert(conversationQueue)
      .values({
        channelAccountId,
        conversationId,
        inboundVersion,
        queuedAt: now,
        readyAt: now,
      })
      .onConflictDoUpdate({
        target: conversationQueue.conversationId,
        set: {
          inboundVersion,
          readyAt: now,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });

    await db
      .insert(jobs)
      .values({
        channelAccountId,
        queue: "debounce",
        jobType: "debounce",
        priority: 1,
        status: "READY",
        availableAt: now,
        payload: {
          channelAccountId,
          conversationId,
          inboundVersion,
        },
        idempotencyKey: `debounce:${channelAccountId}:${conversationId}:${inboundVersion}`,
      })
      .onConflictDoUpdate({
        target: jobs.idempotencyKey,
        set: {
          availableAt: now,
          status: "READY",
          updatedAt: now,
        },
      });

    await broadcaster.broadcast("conversation:resumed", {
      conversationId,
      inboundVersion,
      mode: "AUTO",
    });
  };
}
