import type { JobExecutionContext } from "@messenger/db";
import type { Database, JobRepository, EventRepository, OutboxRepository } from "@messenger/db";
import { channelAccounts, conversations, turns, outboundActions, incidents, messages, ConversationControlService } from "@messenger/db";
import { eq, and, or, sql, lte, gte, gt, isNotNull, isNull, inArray } from "drizzle-orm";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";

export interface ReconcileHandlerDeps {
  db: Database;
  jobRepo: JobRepository;
  eventRepo: EventRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
}

export function createReconcileHandler(deps: ReconcileHandlerDeps) {
  const { db, jobRepo, eventRepo, broadcaster } = deps;

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

    // 3. Reconcile turns stuck in THINKING using startedAt timestamp
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
          or(
            and(isNotNull(turns.startedAt), lte(turns.startedAt, twoMinutesAgo)),
            and(isNull(turns.startedAt), lte(turns.createdAt, twoMinutesAgo))
          )
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

    if (staleTurns.length > 0) {
      const staleTurnIds = staleTurns.map((t) => t.id);
      await db
        .update(channelAccounts)
        .set({
          activeTurnId: null,
          currentOwnerToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(inArray(channelAccounts.activeTurnId, staleTurnIds));
    }

    // 4. Reconcile conversations stuck in active processing states (e.g. THINKING) with stale leases/claims
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
          or(
            and(isNotNull(conversations.claimedAt), lte(conversations.claimedAt, twoMinutesAgo)),
            and(isNull(conversations.claimedAt), lte(conversations.updatedAt, twoMinutesAgo))
          )
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

    // 5. Reconcile outbound actions stuck in TYPING (phase-aware: safe to cancel/requeue without send uncertainty)
    const staleTyping = await db
      .update(outboundActions)
      .set({
        status: "CANCELLED",
        errorMessage: "Typing timed out before send intent",
        updatedAt: now,
      })
      .where(
        and(
          eq(outboundActions.status, "TYPING"),
          or(
            and(isNotNull(outboundActions.startedTypingAt), lte(outboundActions.startedTypingAt, ninetySecondsAgo)),
            and(isNull(outboundActions.startedTypingAt), lte(outboundActions.updatedAt, ninetySecondsAgo))
          )
        )
      )
      .returning({
        id: outboundActions.id,
        conversationId: outboundActions.conversationId,
        channelAccountId: outboundActions.channelAccountId,
      });

    for (const a of staleTyping) {
      await eventRepo.recordEvent({
        channelAccountId: a.channelAccountId,
        conversationId: a.conversationId,
        type: "TYPING_ABORTED",
        actor: "RECONCILER",
        payload: { actionId: a.id, reason: "Typing timed out before send intent" },
      });
    }

    // 6. Reconcile outbound actions stuck in SEND_INTENT (phase-aware: Enter was pressed, must transition to SEND_UNCERTAIN)
    // CRITICAL: Isolate failure to the specific conversation via REVIEW_HOLD. Do NOT suspend the entire channel account!
    const staleSendIntent = await db
      .update(outboundActions)
      .set({
        status: "SEND_UNCERTAIN",
        unconfirmedReason: "Outbound send verification timed out after send intent",
        updatedAt: now,
      })
      .where(
        and(
          sql`${outboundActions.status} IN ('SEND_INTENT', 'SENDING')`,
          or(
            and(isNotNull(outboundActions.startedSendingAt), lte(outboundActions.startedSendingAt, ninetySecondsAgo)),
            and(isNull(outboundActions.startedSendingAt), lte(outboundActions.updatedAt, ninetySecondsAgo))
          )
        )
      )
      .returning({
        id: outboundActions.id,
        conversationId: outboundActions.conversationId,
        channelAccountId: outboundActions.channelAccountId,
      });

    for (const a of staleSendIntent) {
      await eventRepo.recordEvent({
        channelAccountId: a.channelAccountId,
        conversationId: a.conversationId,
        type: "SEND_UNCERTAIN",
        actor: "RECONCILER",
        payload: { actionId: a.id, reason: "Send verification timed out after send intent" },
      });

      // Isolate to conversation using REVIEW_HOLD (channel remains RUNNING for other customers)
      const controlService = new ConversationControlService(db);
      await controlService.acquireReviewHold(a.conversationId, "SEND_UNCERTAIN").catch(() => {});

      if (typeof db.insert === "function") {
        await db
          .insert(incidents)
          .values({
            channelAccountId: a.channelAccountId,
            conversationId: a.conversationId,
            outboundActionId: a.id,
            type: "SEND_UNCERTAIN",
            title: `Outbound action ${a.id} timed out after send intent (isolated to conversation)`,
            description: "Enter was pressed but verification timed out. Conversation placed in REVIEW_HOLD fail-closed.",
            metadata: { actionId: a.id, timeoutAfterMs: 90000 },
            status: "OPEN",
            createdAt: now,
            updatedAt: now,
          })
          .catch(() => {});
      }
    }

    // 7. Auto-reconcile SEND_UNCERTAIN outbound actions:
    // If subsequent customer messages exist in the conversation, the thread has progressed past the uncertainty.
    // Unblock the conversation review hold so AI can continue serving customer, but do NOT fake CONFIRMED delivery!
    if (typeof db.select === "function") {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      const uncertainActions = await db
        .select({
          id: outboundActions.id,
          conversationId: outboundActions.conversationId,
          channelAccountId: outboundActions.channelAccountId,
          createdAt: outboundActions.createdAt,
          startedSendingAt: outboundActions.startedSendingAt,
        })
        .from(outboundActions)
        .where(
          and(
            eq(outboundActions.status, "SEND_UNCERTAIN"),
            gte(outboundActions.createdAt, twoHoursAgo)
          )
        )
        .limit(20);

      for (const a of uncertainActions) {
        const sendCutoff = a.startedSendingAt ?? a.createdAt;
        const [laterMsg] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, a.conversationId),
              eq(messages.direction, "INBOUND"),
              gt(messages.createdAt, sendCutoff)
            )
          )
          .limit(1);

        if (laterMsg) {
          await db
            .update(outboundActions)
            .set({
              metadata: sql`jsonb_set(COALESCE(${outboundActions.metadata}, '{}'::jsonb), '{threadProgressed}', 'true'::jsonb)`,
              updatedAt: now,
            })
            .where(eq(outboundActions.id, a.id));

          await eventRepo.recordEvent({
            channelAccountId: a.channelAccountId,
            conversationId: a.conversationId,
            type: "CONVERSATION_RELEASED",
            actor: "RECONCILER",
            payload: { actionId: a.id, reason: "Customer activity observed after uncertain send" },
          });

          await db
            .update(incidents)
            .set({
              status: "RESOLVED",
              resolvedAt: now,
              resolvedBy: "system:reconciler",
              resolutionNote: "Khách đã gửi tin nhắn mới sau hành động gửi chưa chắc chắn; gỡ chặn hội thoại để tiếp tục phục vụ",
              updatedAt: now,
            })
            .where(
              and(
                eq(incidents.conversationId, a.conversationId),
                eq(incidents.status, "OPEN"),
                or(
                  eq(incidents.outboundActionId, a.id),
                  sql`${incidents.metadata}->>'actionId' = ${a.id}`
                )
              )
            );

          const controlService = new ConversationControlService(db);
          await controlService.releaseTechnicalReviewHold(a.conversationId, "SEND_UNCERTAIN");
        }
      }
    }

    return {
      reconciledJobs: jobStats,
      clearedChannelLeases: expiredChannels.length,
      staleTurnsFailed: staleTurns.length,
      staleConversationsQueued: staleConversations.length,
      staleTypingCancelled: staleTyping.length,
      staleSendIntentUncertain: staleSendIntent.length,
      staleActionsUncertain: staleSendIntent.length,
    };
  };
}
