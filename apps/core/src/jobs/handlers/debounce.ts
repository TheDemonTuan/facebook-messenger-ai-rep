import type { JobExecutionContext } from "@messenger/db";
import type { Database, TurnRepository, JobRepository, OutboxRepository, EventRepository } from "@messenger/db";
import { conversations, channelAccounts, ReplyPolicyService, ConversationControlService } from "@messenger/db";
import { eq, and } from "drizzle-orm";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";

export interface DebounceJobPayload {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
}

export interface DebounceHandlerDeps {
  db: Database;
  turnRepo: TurnRepository;
  jobRepo: JobRepository;
  outboxRepo: OutboxRepository;
  eventRepo: EventRepository;
  broadcaster: OutboxBroadcaster;
  replyPolicyService?: ReplyPolicyService;
}

export function createDebounceHandler(deps: DebounceHandlerDeps) {
  const { db, turnRepo, jobRepo, outboxRepo, eventRepo, broadcaster } = deps;
  const replyPolicyService = deps.replyPolicyService ?? new ReplyPolicyService(db);
  const controlService = new ConversationControlService(db);

  return async function handleDebounce(context: JobExecutionContext): Promise<void> {
    const payload = context.job.payload as unknown as DebounceJobPayload;
    const { channelAccountId, conversationId, inboundVersion } = payload;

    if (!channelAccountId || !conversationId || typeof inboundVersion !== "number") {
      console.warn("[DebounceHandler] Missing required payload fields", payload);
      return;
    }

    // 1. Fetch current conversation state
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv) {
      console.warn(`[DebounceHandler] Conversation ${conversationId} not found`);
      return;
    }

    // 2. Stale debounce check: if inboundVersion has moved past this job, ignore
    if (conv.inboundVersion !== inboundVersion) {
      console.log(
        `[DebounceHandler] Stale debounce: jobVersion=${inboundVersion}, actualVersion=${conv.inboundVersion}. Skipping.`
      );
      await eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "SCHEDULER",
        payload: { jobVersion: inboundVersion, actualVersion: conv.inboundVersion },
      });
      return;
    }

    // 3. Check reply control, manual mode, human hold, or blocked
    // Older in-memory test doubles do not implement transactions. Production always does.
    const control = typeof (db as unknown as { transaction?: unknown }).transaction === "function"
      ? await controlService.expireSessionIfDue(conversationId)
      : {
          mode: ((conv.replyControlMode || "AUTO") as "AUTO" | "HUMAN_DRAFT" | "HUMAN_SESSION" | "HUMAN_PINNED" | "REVIEW_HOLD"),
          epoch: conv.controlEpoch ?? 0,
          holdUntil: conv.humanHoldUntil ?? null,
          suppressedThroughInboundVersion: conv.suppressedThroughInboundVersion ?? 0,
        };
    if (!control) return;
    if (control.mode !== "AUTO" || inboundVersion <= control.suppressedThroughInboundVersion) {
      console.log(
        `[DebounceHandler] Conversation ${conversationId} is controlled by ${control.mode} or inbound v${inboundVersion} is suppressed through v${control.suppressedThroughInboundVersion}. Skipping.`
      );
      return;
    }

    if (conv.isBlocked) {
      console.log(`[DebounceHandler] Conversation ${conversationId} is blocked. Skipping.`);
      return;
    }

    if (conv.humanHoldUntil) {
      const now = new Date();
      if (conv.humanHoldUntil > now) {
        console.log(
          `[DebounceHandler] Conversation ${conversationId} is in human hold until ${conv.humanHoldUntil.toISOString()}. Skipping AI generation.`
        );
        return;
      }
      // Hold has expired. Verify if this inbound is strictly newer than suppressed watermark
      if (inboundVersion <= (conv.suppressedThroughInboundVersion ?? 0)) {
        console.log(
          `[DebounceHandler] Conversation ${conversationId} human hold expired, but inbound v${inboundVersion} is at or below watermark (${conv.suppressedThroughInboundVersion}). No replay of stale messages.`
        );
        return;
      }
      // New inbound after expiry: automatically clear temporary human hold
      console.log(
        `[DebounceHandler] Conversation ${conversationId} human hold expired and received new inbound v${inboundVersion}. Clearing hold.`
      );
      await db
        .update(conversations)
        .set({
          manualMode: false,
          humanHoldUntil: null,
          status: "WAITING_CUSTOMER",
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversationId));
      conv.manualMode = false;
    }

    if (conv.manualMode) {
      console.log(
        `[DebounceHandler] Conversation ${conversationId} is in manualMode. Skipping AI generation.`
      );
      return;
    }

    // 4. Check channel status
    const [channel] = await db
      .select({
        status: channelAccounts.status,
        isPaused: channelAccounts.isPaused,
        isSuspended: channelAccounts.isSuspended,
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, channelAccountId))
      .limit(1);

    if (!channel || channel.isPaused || channel.isSuspended || channel.status !== "RUNNING") {
      console.log(
        `[DebounceHandler] Channel ${channelAccountId} not running (paused/suspended). Setting conversation to QUEUED.`
      );
      await db
        .update(conversations)
        .set({ status: "QUEUED", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
      return;
    }

    // 4b. Re-check policy revision & eligibility (stops newly-disallowed work or race)
    const policyResult = await replyPolicyService.recheckEligibility({
      channelAccountId,
      conversationId,
      inboundVersion,
      conversation: conv,
    });

    if (!policyResult.eligible) {
      console.log(
        `[DebounceHandler] Inbound v${inboundVersion} for conv ${conversationId} is no longer eligible (${policyResult.reasonCode}): ${policyResult.reason}. Skipping AI generation.`
      );
      await db
        .update(conversations)
        .set({ status: "WAITING_CUSTOMER", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));

      await eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "SCHEDULER",
        payload: {
          reason: "POLICY_INELIGIBLE",
          reasonCode: policyResult.reasonCode,
          details: policyResult.details,
        },
      });
      return;
    }

    // 5. Transition conversation to THINKING with CAS version check
    const updateBuilder = db
      .update(conversations)
      .set({ status: "THINKING", claimedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.inboundVersion, inboundVersion)
        )
      );

    const builderWithReturning = updateBuilder as unknown as { returning?: () => Promise<unknown[]> };
    if (typeof builderWithReturning.returning === "function") {
      const [updatedConv] = await builderWithReturning.returning();
      if (!updatedConv) {
        console.log(
          `[DebounceHandler] Inbound version moved during debounce processing for ${conversationId}. Skipping.`
        );
        return;
      }
    } else {
      await updateBuilder;
    }

    // 6. Create or get turn record
    const turn = await turnRepo.createOrGetTurn({
      channelAccountId,
      conversationId,
      inboundVersion,
    });

    // 7. Enqueue AI job into jobs table
    await jobRepo.enqueue({
      channelAccountId,
      queue: "ai",
      jobType: "ai",
      priority: 10,
      payload: {
        channelAccountId,
        conversationId,
        inboundVersion,
        controlEpoch: control.epoch,
        turnId: turn.id,
      },
      idempotencyKey: `ai:${channelAccountId}:${conversationId}:${inboundVersion}`,
    });

    // 8. Record outbox event & broadcast
    await outboxRepo.enqueue({
      channelAccountId,
      conversationId,
      eventType: "turn:created",
      payload: {
        turnId: turn.id,
        conversationId,
        inboundVersion,
        status: "THINKING",
      },
    });

    await eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "AI_STARTED",
      inboundVersion,
      actor: "SCHEDULER",
      payload: { turnId: turn.id },
    });

    await broadcaster.broadcast("conversation:status", {
      conversationId,
      status: "THINKING",
      inboundVersion,
    });
  };
}
