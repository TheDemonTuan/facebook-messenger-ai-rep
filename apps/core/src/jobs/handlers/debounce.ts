import type { JobExecutionContext } from "@messenger/db";
import type { Database, TurnRepository, JobRepository, OutboxRepository, EventRepository } from "@messenger/db";
import { conversations, channelAccounts } from "@messenger/db";
import { eq } from "drizzle-orm";
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
}

export function createDebounceHandler(deps: DebounceHandlerDeps) {
  const { db, turnRepo, jobRepo, outboxRepo, eventRepo, broadcaster } = deps;

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

    // 3. Check manual mode or blocked
    if (conv.manualMode || conv.isBlocked) {
      console.log(
        `[DebounceHandler] Conversation ${conversationId} is manualMode or blocked. Skipping AI generation.`
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

    // 5. Transition conversation to THINKING
    await db
      .update(conversations)
      .set({ status: "THINKING", updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

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
