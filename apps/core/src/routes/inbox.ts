import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  OutboxRepository,
} from "@messenger/db";
import {
  conversations,
  customers,
  messages,
  conversationQueue,
  aiRuns,
  outboundActions,
  channelAccounts,
} from "@messenger/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import type { SessionUser } from "@messenger/contracts";
import { requireRole } from "../auth/roles.js";

export interface InboxRoutesOptions {
  db: Database;
  convRepo: ConversationRepository;
  queueRepo: QueueRepository;
  outboundRepo: OutboundRepository;
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
    queueRepo,
    outboundRepo,
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

    // 1. List conversations with Pagination
    fastify.get<{ Querystring: { filter?: string; limit?: string; offset?: string } }>(
      "/api/inbox",
      async (request, reply) => {
        const limit = Math.min(Math.max(1, parseInt(request.query.limit || "50", 10)), 100);
        const offset = Math.max(0, parseInt(request.query.offset || "0", 10));
        const filter = request.query.filter || "all";

        const conditions = [eq(conversations.channelAccountId, channelAccountId)];

        if (filter === "manual") {
          conditions.push(eq(conversations.manualMode, true));
        } else if (filter === "queued") {
          conditions.push(sql`${conversations.status} IN ('QUEUED', 'DEBOUNCING')`);
        } else if (filter === "error") {
          conditions.push(eq(conversations.status, "ERROR"));
        }

        const [rows, totalRes] = await Promise.all([
          db
            .select({
              conversation: conversations,
              customer: customers,
            })
            .from(conversations)
            .innerJoin(customers, eq(conversations.customerId, customers.id))
            .where(and(...conditions))
            .orderBy(desc(conversations.lastInboundAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(conversations)
            .where(and(...conditions)),
        ]);

        const total = totalRes[0]?.count || 0;
        const hasMore = offset + rows.length < total;

        return reply.send({
          conversations: rows,
          total,
          limit,
          offset,
          hasMore,
        });
      }
    );

    // 2. Conversation timeline details
    fastify.get<{ Params: { conversationId: string } }>(
      "/api/inbox/:conversationId",
      async (request, reply) => {
        const { conversationId } = request.params;
        const convData = await convRepo.getConversationById(conversationId);
        if (!convData) {
          return reply.status(404).send({ error: "Conversation not found" });
        }

        const [convMessages, runs, actions, events] = await Promise.all([
          db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .orderBy(messages.timestamp),
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
        ]);

        return reply.send({
          ...convData,
          messages: convMessages,
          aiRuns: runs,
          outboundActions: actions,
          events,
        });
      }
    );

    // 3. Manual takeover
    fastify.post<{ Params: { conversationId: string } }>(
      "/api/inbox/:conversationId/takeover",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;

        await convRepo.setManualMode(conversationId, true);
        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "MANUAL_TAKEOVER",
          actor: user.email,
        });

        await broadcaster.broadcast("conversation:takeover", { conversationId, manualMode: true });
        return reply.send({ success: true, conversationId, manualMode: true });
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

        if (resolution === "MARK_SENT") {
          await outboundRepo.confirmSent(actionId, `reconciled-by-${user.email}`);
          await eventRepo.recordEvent({
            channelAccountId,
            conversationId,
            type: "SEND_CONFIRMED",
            actor: user.email,
            payload: { actionId, reconciled: true },
          });

          // Resume channel if was suspended
          await db
            .update(channelAccounts)
            .set({ isSuspended: false, status: "RUNNING", statusReason: null, updatedAt: new Date() })
            .where(eq(channelAccounts.id, channelAccountId));

          await broadcaster.broadcast("action:reconciled", { actionId, resolution: "MARK_SENT" });
          return reply.send({ success: true, actionId, status: "CONFIRMED" });
        }

        if (resolution === "RETRY") {
          await outboundRepo.reconcileUncertain(actionId, "RETRY_APPROVED");
          await outboundRepo.transitionStatus(actionId, "RETRY_APPROVED", "PENDING");

          await eventRepo.recordEvent({
            channelAccountId,
            conversationId,
            type: "SEND_STARTED",
            actor: user.email,
            payload: { actionId, retryApproved: true },
          });

          await broadcaster.broadcast("action:reconciled", { actionId, resolution: "RETRY" });
          return reply.send({ success: true, actionId, status: "PENDING" });
        }

        return reply.status(400).send({ error: "Invalid resolution" });
      }
    );
  };
}
