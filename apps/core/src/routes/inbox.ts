import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  OutboxRepository,
  JobRepository,
} from "@messenger/db";
import {
  conversations,
  customers,
  messages,
  conversationQueue,
  aiRuns,
  outboundActions,
  channelAccounts,
  participants,
  inboundMessages,
  replyEligibilityDecisions,
  sanitizeApiOutput,
} from "@messenger/db";
import { eq, and, desc, sql, ne, inArray } from "drizzle-orm";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import { getHumanReadableReason, type SessionUser } from "@messenger/contracts";
import { requireRole } from "../auth/roles.js";

export interface InboxRoutesOptions {
  db: Database;
  convRepo: ConversationRepository;
  queueRepo: QueueRepository;
  outboundRepo: OutboundRepository;
  jobRepo?: JobRepository;
  eventRepo: EventRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
}

export function createInboxRoutes(options: InboxRoutesOptions): FastifyPluginAsync {
  const {
    db,
    convRepo,
    outboundRepo,
    jobRepo,
    eventRepo,
    outboxRepo,
    broadcaster,
    requireAuth,
    channelAccountId,
  } = options;

  return async function (fastify) {
    fastify.addHook("preHandler", async (request, reply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;
      (request as unknown as { user: SessionUser }).user = user;
    });

    // 1. List conversations with Pagination (supports limit/offset and cursor)
    fastify.get<{ Querystring: { filter?: string; limit?: string; offset?: string; cursor?: string } }>(
      "/api/inbox",
      async (request, reply) => {
        const limit = Math.min(Math.max(1, parseInt(request.query.limit || "50", 10)), 100);
        const offset = Math.max(0, parseInt(request.query.offset || "0", 10));
        const filter = request.query.filter || "all";
        const cursor = request.query.cursor;

        const conditions = [eq(conversations.channelAccountId, channelAccountId)];

        if (filter === "manual") {
          conditions.push(eq(conversations.manualMode, true));
        } else if (filter === "queued") {
          conditions.push(sql`${conversations.status} IN ('QUEUED', 'DEBOUNCING')`);
        } else if (filter === "error") {
          conditions.push(eq(conversations.status, "ERROR"));
        }

        if (cursor) {
          const cursorDate = new Date(cursor);
          if (!isNaN(cursorDate.getTime())) {
            conditions.push(sql`${conversations.lastInboundAt} < ${cursorDate}`);
          }
        }

        const [rows, totalRes] = await Promise.all([
          db
            .select({
              conversation: conversations,
              customer: customers,
            })
            .from(conversations)
            .leftJoin(customers, eq(conversations.customerId, customers.id))
            .where(and(...conditions))
            .orderBy(desc(conversations.lastInboundAt))
            .limit(limit)
            .offset(cursor ? 0 : offset),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(conversations)
            .where(and(...conditions)),
        ]);

        const total = totalRes[0]?.count || 0;
        const lastItem = rows[rows.length - 1];
        const nextCursor =
          rows.length >= limit && lastItem?.conversation?.lastInboundAt
            ? new Date(lastItem.conversation.lastInboundAt).toISOString()
            : null;

        const hasMore = Boolean(nextCursor) || offset + rows.length < total;

        const safeRows = rows.map((r) => {
          const isGroup = r.conversation.threadKind === "GROUP";
          const defaultName = isGroup ? "Nhóm Messenger" : "Khách hàng Messenger";
          const fallbackCustomer = {
            id: r.conversation.customerId ?? "00000000-0000-0000-0000-000000000000",
            channelAccountId: r.conversation.channelAccountId,
            name: r.conversation.title || defaultName,
            avatarUrl: null,
            notes: null,
            createdAt: r.conversation.createdAt,
            updatedAt: r.conversation.updatedAt,
          };
          return {
            conversation: r.conversation,
            customer: r.customer ?? fallbackCustomer,
          };
        });

        return reply.send(
          sanitizeApiOutput({
            conversations: safeRows,
            total,
            limit,
            offset,
            hasMore,
            nextCursor,
          })
        );
      }
    );

    // 2. Conversation timeline details (supports messageCursor pagination)
    fastify.get<{
      Params: { conversationId: string };
      Querystring: { messageCursor?: string; messageLimit?: string };
    }>(
      "/api/inbox/:conversationId",
      async (request, reply) => {
        const { conversationId } = request.params;
        const convData = await convRepo.getConversationById(conversationId);
        if (!convData) {
          return reply.status(404).send({ error: "Conversation not found" });
        }

        const messageLimit = Math.min(Math.max(1, parseInt(request.query?.messageLimit || "50", 10)), 200);
        const messageCursor = request.query?.messageCursor;

        const msgConditions = [eq(messages.conversationId, conversationId)];
        if (messageCursor) {
          const cursorDate = new Date(messageCursor);
          if (!isNaN(cursorDate.getTime())) {
            msgConditions.push(sql`${messages.timestamp} < ${cursorDate}`);
          }
        }

        const [convMessages, runs, actions, events, decisions, inbounds] = await Promise.all([
          db
            .select()
            .from(messages)
            .where(and(...msgConditions))
            .orderBy(desc(messages.timestamp))
            .limit(messageLimit),
          db
            .select()
            .from(aiRuns)
            .where(eq(aiRuns.conversationId, conversationId))
            .orderBy(desc(aiRuns.createdAt))
            .limit(10),
          db
            .select()
            .from(outboundActions)
            .where(eq(outboundActions.conversationId, conversationId))
            .orderBy(desc(outboundActions.createdAt))
            .limit(10),
          eventRepo.getRecentEvents(conversationId, 30),
          db
            .select()
            .from(replyEligibilityDecisions)
            .where(eq(replyEligibilityDecisions.conversationId, conversationId))
            .orderBy(desc(replyEligibilityDecisions.evaluatedAt))
            .limit(50),
          db
            .select({ id: inboundMessages.id, sourceMessageId: inboundMessages.sourceMessageId })
            .from(inboundMessages)
            .where(eq(inboundMessages.conversationId, conversationId))
            .limit(100),
        ]);

        const inboundMap = new Map<string, string>();
        for (const ib of inbounds) {
          inboundMap.set(ib.id, ib.sourceMessageId);
        }
        const decisionBySourceId = new Map<string, typeof decisions[0]>();
        for (const d of decisions) {
          const srcId = inboundMap.get(d.inboundMessageId);
          if (srcId && !decisionBySourceId.has(srcId)) {
            decisionBySourceId.set(srcId, d);
          }
        }

        const participantIds = Array.from(
          new Set(
            convMessages
              .map((m) => m.senderParticipantId)
              .filter((id): id is string => Boolean(id && id.trim().length > 0))
          )
        );
        const participantMap = new Map<string, { displayName: string | null; avatarUrl: string | null; senderKind: string; isVerified: boolean }>();
        if (participantIds.length > 0) {
          try {
            const parts = await db
              .select()
              .from(participants)
              .where(
                and(
                  eq(participants.channelAccountId, channelAccountId),
                  inArray(participants.participantId, participantIds)
                )
              );
            for (const p of parts) {
              participantMap.set(p.participantId, {
                displayName: p.displayName,
                avatarUrl: p.avatarUrl || p.profileUrl || null,
                senderKind: p.senderKind,
                isVerified: p.isVerified,
              });
            }
          } catch {
            // ignore
          }
        }

        const chronologicalMessages = [...convMessages]
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .map((msg) => {
            const isInbound = msg.direction === "INBOUND";
            const part = msg.senderParticipantId ? participantMap.get(msg.senderParticipantId) : null;
            const decision = decisionBySourceId.get(msg.externalMessageId);
            const defaultSenderName = isInbound
              ? (part?.displayName || convData.customer?.name || (convData.conversation.threadKind === "GROUP" ? "Thành viên nhóm" : "Khách hàng Messenger"))
              : (msg.actor === "AI" ? "Trợ lý AI" : (msg.actor === "MANUAL_OWNER" ? "Nhân viên hỗ trợ" : "Hệ thống"));
            const senderAvatar = isInbound ? (part?.avatarUrl || convData.customer?.avatarUrl || null) : null;
            const skipReason = decision
              ? {
                  decision: decision.decision,
                  eligible: decision.eligible,
                  reasonCode: decision.reasonCode,
                  reason: decision.reason,
                  humanReadableReason: getHumanReadableReason(decision.reasonCode, decision.reason),
                  precedenceStep: decision.precedenceStep,
                  evaluationMode: decision.evaluationMode,
                }
              : null;

            return {
              ...msg,
              senderName: defaultSenderName,
              avatarUrl: senderAvatar,
              senderKind: part?.senderKind || msg.senderKind,
              isVerified: part?.isVerified ?? false,
              skipReason,
            };
          });

        const oldestMessage = convMessages[convMessages.length - 1];
        const nextMessageCursor =
          convMessages.length >= messageLimit && oldestMessage
            ? new Date(oldestMessage.timestamp).toISOString()
            : null;

        return reply.send(
          sanitizeApiOutput({
            ...convData,
            messages: chronologicalMessages,
            nextMessageCursor,
            hasMoreMessages: Boolean(nextMessageCursor),
            aiRuns: runs,
            outboundActions: actions,
            events,
          })
        );
      }
    );

    // 3. Manual takeover (aborts active typing, sends cancel ack)
    fastify.post<{ Params: { conversationId: string } }>(
      "/api/inbox/:conversationId/takeover",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;

        await convRepo.setManualMode(conversationId, true);
        await outboundRepo.abortStaleActions(conversationId, 9999999);
        try {
          await db.execute(
            sql`SELECT pg_notify('browser_cancel_typing', ${JSON.stringify({
              channelAccountId,
              conversationId,
              inboundVersion: 9999999,
            })})`
          );
        } catch {
          /* ignore notification failure */
        }

        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "MANUAL_TAKEOVER",
          actor: user.email,
        });

        await broadcaster.broadcast("conversation:takeover", {
          conversationId,
          manualMode: true,
          cancelAck: true,
        });
        return reply.send({ success: true, conversationId, manualMode: true, cancelAck: true });
      }
    );

    // 4. Release manual takeover
    fastify.post<{ Params: { conversationId: string } }>(
      "/api/inbox/:conversationId/release",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;

        await convRepo.setManualMode(conversationId, false);
        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "MANUAL_RELEASED",
          actor: user.email,
        });

        await broadcaster.broadcast("conversation:takeover", { conversationId, manualMode: false });
        return reply.send({ success: true, conversationId, manualMode: false });
      }
    );

    // 5. Block / Unblock conversation
    fastify.post<{ Params: { conversationId: string }; Body: { isBlocked: boolean } }>(
      "/api/inbox/:conversationId/block",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;
        const { isBlocked } = request.body || { isBlocked: true };

        await db
          .update(conversations)
          .set({
            isBlocked,
            status: isBlocked ? "BLOCKED" : "WAITING_CUSTOMER",
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId));

        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "CONVERSATION_RELEASED",
          actor: user.email,
          payload: { action: isBlocked ? "BLOCKED" : "UNBLOCKED" },
        });

        if (isBlocked) {
          await db.delete(conversationQueue).where(eq(conversationQueue.conversationId, conversationId));
        }

        await broadcaster.broadcast("conversation:block", { conversationId, isBlocked });
        return reply.send({ success: true, isBlocked });
      }
    );

    // 6. Manual Send message from dashboard
    fastify.post<{ Params: { conversationId: string }; Body: { text: string } }>(
      "/api/inbox/:conversationId/manual-send",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;
        const { text } = request.body || {};

        if (!text || text.trim().length === 0) {
          return reply.status(400).send({ error: "Text cannot be empty" });
        }

        const convData = await convRepo.getConversationById(conversationId);
        if (!convData) {
          return reply.status(404).send({ error: "Conversation not found" });
        }

        const currentVersion = convData.conversation.inboundVersion;

        // Create outbound action in PENDING status
        const action = await outboundRepo.createAction({
          channelAccountId,
          conversationId,
          inboundVersion: currentVersion,
          responseIndex: 0,
          text: text.trim(),
          actor: "MANUAL_OWNER",
          claimToken: "manual-send-token",
          fencingToken: 1,
        });

        if (!action) {
          return reply.status(500).send({ error: "Failed to create outbound action" });
        }

        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "SEND_STARTED",
          inboundVersion: currentVersion,
          actor: user.email,
          payload: { actionId: action.actionId, manualSend: true },
        });

        await outboxRepo.enqueue({
          channelAccountId,
          conversationId,
          eventType: "outbound:manual_send",
          payload: {
            actionId: action.actionId,
            conversationId,
            text: text.trim(),
          },
        });

        await broadcaster.broadcast("conversation:manual-send", {
          conversationId,
          actionId: action.actionId,
        });

        if (jobRepo) {
          await jobRepo.enqueue({
            channelAccountId,
            queue: "browser",
            jobType: "BROWSER_SEND",
            priority: 20,
            payload: {
              actionId: action.actionId,
              channelAccountId,
              conversationId,
              externalThreadRef: convData.conversation.externalThreadRef,
              inboundVersion: currentVersion,
              responseIndex: 0,
              text: text.trim(),
              textHash: action.textHash,
              actor: "MANUAL_OWNER",
              claimToken: action.claimToken || "manual-send-token",
              ownerToken: action.ownerToken || "manual-send-token",
              fencingToken: action.fencingToken ?? 1,
              fencingEpoch: action.fencingEpoch ?? 1,
            },
            idempotencyKey: `browser-send:${action.actionId}`,
          });
        }

        return reply.send({ success: true, actionId: action.actionId });
      }
    );

    // 7. Reconcile Unconfirmed / SEND_UNCERTAIN Action
    fastify.post<{
      Params: { conversationId: string };
      Body: { actionId: string; resolution: "MARK_SENT" | "RETRY" };
    }>(
      "/api/inbox/:conversationId/reconcile-action",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;
        const { actionId, resolution } = request.body || {};

        if (!actionId || !resolution) {
          return reply.status(400).send({ error: "actionId and resolution are required" });
        }

        const action = await outboundRepo.getActionById(actionId);
        if (!action) {
          return reply.status(404).send({ error: "Action not found" });
        }

        const isUncertain = action.status === "SEND_UNCERTAIN" || action.status === "UNCONFIRMED";
        if (!isUncertain) {
          return reply.status(400).send({ error: `Action is in status ${action.status}, not uncertain/unconfirmed` });
        }

        const targetChannelAccountId = action.channelAccountId || channelAccountId;

        if (resolution === "MARK_SENT") {
          await outboundRepo.confirmSent(actionId, `reconciled-by-${user.email}`);
          await eventRepo.recordEvent({
            channelAccountId: targetChannelAccountId,
            conversationId,
            type: "SEND_CONFIRMED",
            actor: user.email,
            payload: { actionId, reconciled: true },
          });

          // Resume channel only if no other uncertain action remains
          const remainingUncertain = await db
            .select({ id: outboundActions.id })
            .from(outboundActions)
            .where(
              and(
                eq(outboundActions.channelAccountId, targetChannelAccountId),
                ne(outboundActions.actionId, action.actionId),
                sql`${outboundActions.status} IN ('SEND_UNCERTAIN', 'UNCONFIRMED')`
              )
            )
            .limit(1);

          if (remainingUncertain.length === 0) {
            await db
              .update(channelAccounts)
              .set({ isSuspended: false, status: "RUNNING", statusReason: null, updatedAt: new Date() })
              .where(eq(channelAccounts.id, targetChannelAccountId));

            await broadcaster.broadcast("channel:status", { status: "RUNNING", isPaused: false, isSuspended: false });
          }

          await broadcaster.broadcast("action:reconciled", { actionId, resolution: "MARK_SENT" });
          return reply.send({ success: true, actionId, status: "CONFIRMED" });
        }

        if (resolution === "RETRY") {
          // Explicit check: ensure no other active or uncertain action exists before retry
          const otherActiveOrUncertain = await db
            .select({
              id: outboundActions.id,
              actionId: outboundActions.actionId,
              status: outboundActions.status,
            })
            .from(outboundActions)
            .where(
              and(
                eq(outboundActions.channelAccountId, targetChannelAccountId),
                ne(outboundActions.actionId, action.actionId),
                sql`${outboundActions.status} IN ('TYPING', 'SEND_INTENT', 'SENDING', 'SEND_UNCERTAIN', 'UNCONFIRMED', 'PENDING', 'RETRY_APPROVED')`
              )
            )
            .limit(1);

          const [blocking] = otherActiveOrUncertain;
          if (blocking) {
            return reply.status(409).send({
              error: `Cannot retry action: channel has another active or uncertain action (${blocking.actionId} in status ${blocking.status})`,
              blockingActionId: blocking.actionId,
              blockingStatus: blocking.status,
            });
          }

          await outboundRepo.reconcileUncertain(actionId, "RETRY_APPROVED");

          await eventRepo.recordEvent({
            channelAccountId: targetChannelAccountId,
            conversationId,
            type: "SEND_STARTED",
            actor: user.email,
            payload: { actionId, retryApproved: true },
          });

          // Safely resume channel before enqueue
          await db
            .update(channelAccounts)
            .set({ isSuspended: false, status: "RUNNING", statusReason: null, updatedAt: new Date() })
            .where(eq(channelAccounts.id, targetChannelAccountId));

          await broadcaster.broadcast("channel:status", { status: "RUNNING", isPaused: false, isSuspended: false });

          if (jobRepo) {
            const convData = await convRepo.getConversationById(conversationId);
            await jobRepo.enqueue({
              channelAccountId: targetChannelAccountId,
              queue: "browser",
              jobType: "BROWSER_SEND",
              priority: 20,
              payload: {
                actionId: action.actionId,
                channelAccountId: targetChannelAccountId,
                conversationId: action.conversationId,
                externalThreadRef: convData?.conversation.externalThreadRef || "",
                inboundVersion: action.inboundVersion,
                responseIndex: action.responseIndex,
                text: action.text,
                textHash: action.textHash,
                actor: action.actor,
              },
              idempotencyKey: `browser-send:${action.actionId}:retry-${Date.now()}`,
            });
          }

          await broadcaster.broadcast("action:reconciled", { actionId, resolution: "RETRY" });
          return reply.send({ success: true, actionId, status: "PENDING" });
        }

        return reply.status(400).send({ error: "Invalid resolution" });
      }
    );
  };
}
