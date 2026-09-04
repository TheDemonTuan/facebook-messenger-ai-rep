import type { JobExecutionContext } from "@messenger/db";
import type { Database, JobRepository, EventRepository, OutboxRepository } from "@messenger/db";
import { channelAccounts, conversations, turns, outboundActions } from "@messenger/db";
import { eq, and, sql, lte, isNotNull } from "drizzle-orm";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";

export interface ReconcileHandlerDeps {
  db: Database;
  jobRepo: JobRepository;
  eventRepo: EventRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
}

export function createReconcileHandler(deps: ReconcileHandlerDeps) {
  const { db, jobRepo, eventRepo, outboxRepo, broadcaster } = deps;

  return async function handleReconcile(_context?: JobExecutionContext): Promise<Record<string, unknown>> {
    const now = new Date();
    const twoMinutesAgo = new Date(Date.now() - 120000);
    const ninetySecondsAgo = new Date(Date.now() - 90000);

    // 1. Reconcile stale jobs in jobs table
    const jobStats = await jobRepo.reconcileStaleJobs();

    // 2. Reconcile channel accounts with expired leases
    const expiredChannels = await db
      .update(channelAccounts)
      .set({
        activeTurnId: null,
        currentOwnerToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          isNotNull(channelAccounts.activeTurnId),
          lte(channelAccounts.leaseExpiresAt, now)
        )
      )
      .returning({ id: channelAccounts.id });

    // 3. Reconcile turns stuck in THINKING
    const staleTurns = await db
      .update(turns)
      .set({
        status: "FAILED",
        errorMessage: "Turn timed out during processing (lease expired)",
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.status, "THINKING"),
          lte(turns.startedAt, twoMinutesAgo)
        )
      )
      .returning({ id: turns.id, conversationId: turns.conversationId, channelAccountId: turns.channelAccountId });

    for (const t of staleTurns) {
      await eventRepo.recordEvent({
        channelAccountId: t.channelAccountId,
        conversationId: t.conversationId,
        type: "ERROR",
        actor: "RECONCILER",
        payload: { turnId: t.id, reason: "Turn timed out" },
      });
    }

    // 4. Reconcile conversations stuck in active processing states with stale leases/claims
    const staleConversations = await db
      .update(conversations)
      .set({
        status: "QUEUED",
        claimToken: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          sql`${conversations.status} IN ('CLAIMED', 'READING', 'THINKING', 'DRAFT_READY', 'TYPING', 'SENDING')`,
          lte(conversations.claimedAt, twoMinutesAgo)
        )
      )
      .returning({ id: conversations.id, channelAccountId: conversations.channelAccountId });

    for (const c of staleConversations) {
      await eventRepo.recordEvent({
        channelAccountId: c.channelAccountId,
        conversationId: c.id,
        type: "CONVERSATION_RELEASED",
        actor: "RECONCILER",
        payload: { reason: "Claim expired or worker crashed" },
      });
      await broadcaster.broadcast("conversation:status", {
        conversationId: c.id,
        status: "QUEUED",
      });
    }

    // 5. Reconcile outbound actions stuck in TYPING or SEND_INTENT
    const staleActions = await db
      .update(outboundActions)
      .set({
        status: "SEND_UNCERTAIN",
        unconfirmedReason: "Outbound send verification timed out during active phase",
        updatedAt: now,
      })
      .where(
        and(
          sql`${outboundActions.status} IN ('TYPING', 'SEND_INTENT')`,
          lte(outboundActions.startedSendingAt, ninetySecondsAgo)
        )
      )
      .returning({ id: outboundActions.id, conversationId: outboundActions.conversationId, channelAccountId: outboundActions.channelAccountId });

    for (const a of staleActions) {
      await eventRepo.recordEvent({
        channelAccountId: a.channelAccountId,
        conversationId: a.conversationId,
        type: "SEND_UNCERTAIN",
        actor: "RECONCILER",
        payload: { actionId: a.id },
      });
    }

    return {
      reconciledJobs: jobStats,
      clearedChannelLeases: expiredChannels.length,
      staleTurnsFailed: staleTurns.length,
      staleConversationsQueued: staleConversations.length,
      staleActionsUncertain: staleActions.length,
    };
  };
}
