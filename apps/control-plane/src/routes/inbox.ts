import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
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
import type { SseBroadcaster } from "../sse/broadcaster.js";
import type { SessionUser, SenderActor } from "@messenger/contracts";
import type { AppQueues } from "@messenger/queue";

export interface InboxRoutesOptions {
  db: Database;
  queues: AppQueues;
  convRepo: ConversationRepository;
  queueRepo: QueueRepository;
  outboundRepo: OutboundRepository;
  eventRepo: EventRepository;
  broadcaster: SseBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
}

export function createInboxRoutes(options: InboxRoutesOptions): FastifyPluginAsync {
  const {
    db,
    queues,
    convRepo,
    queueRepo,
    outboundRepo,
    eventRepo,
    broadcaster,
    requireAuth,
    channelAccountId,
  } = options;

  return async function (fastify) {
    fastify.addHook("preHandler", async (request, reply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;
    });

    // 1. List conversations
    fastify.get<{ Querystring: { filter?: string; limit?: string } }>(
      "/api/inbox",
      async (request, reply) => {
        const limit = parseInt(request.query.limit || "50", 10);
        const filter = request.query.filter || "all";

        const baseQuery = db
          .select({
            conversation: conversations,
            customer: customers,
          })
          .from(conversations)
          .innerJoin(customers, eq(conversations.customerId, customers.id))
          .where(eq(conversations.channelAccountId, channelAccountId));

        let rows = await baseQuery.orderBy(desc(conversations.lastInboundAt)).limit(limit);

        if (filter === "manual") {
          rows = rows.filter((r) => r.conversation.manualMode);
        } else if (filter === "queued") {
          rows = rows.filter((r) => r.conversation.status === "QUEUED" || r.conversation.status === "DEBOUNCING");
        } else if (filter === "error") {
          rows = rows.filter((r) => r.conversation.status === "ERROR");
        }

        return reply.send({ conversations: rows });
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
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;

        await convRepo.setManualMode(conversationId, true);
        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "MANUAL_TAKEOVER",
          actor: user.email,
          payload: { manualMode: true },
        });

        broadcaster.broadcast("conversation:takeover", { conversationId, manualMode: true });
        return reply.send({ success: true, manualMode: true });
      }
    );

    // 4. Release to auto
    fastify.post<{ Params: { conversationId: string } }>(
      "/api/inbox/:conversationId/release",
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;

        await convRepo.setManualMode(conversationId, false);
        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "MANUAL_RELEASED",
          actor: user.email,
          payload: { manualMode: false },
        });

        broadcaster.broadcast("conversation:release", { conversationId, manualMode: false });
        return reply.send({ success: true, manualMode: false });
      }
    );

    // 5. Block / Unblock
    fastify.post<{ Params: { conversationId: string }; Body: { isBlocked: boolean } }>(
      "/api/inbox/:conversationId/block",
      async (request, reply) => {
        const { conversationId } = request.params;
        const { isBlocked } = request.body || { isBlocked: true };

        await db
          .update(conversations)
          .set({ isBlocked, status: isBlocked ? "BLOCKED" : "WAITING_CUSTOMER", updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));

        if (isBlocked) {
          await db.delete(conversationQueue).where(eq(conversationQueue.conversationId, conversationId));
        }

        broadcaster.broadcast("conversation:block", { conversationId, isBlocked });
        return reply.send({ success: true, isBlocked });
      }
    );

    // 6. Manual Send message from dashboard (guarantees single-sender serialization!)
    fastify.post<{ Params: { conversationId: string }; Body: { text: string } }>(
      "/api/inbox/:conversationId/manual-send",
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;
        const { text } = request.body;

        if (!text || text.trim().length === 0) {
          return reply.status(400).send({ error: "Text cannot be empty" });
        }

        const convData = await convRepo.getConversationById(conversationId);
        if (!convData) {
          return reply.status(404).send({ error: "Conversation not found" });
        }

        const currentVersion = convData.conversation.inboundVersion;

        // Create outbound action
        const action = await outboundRepo.createAction({
          channelAccountId,
          conversationId,
          inboundVersion: currentVersion,
          responseIndex: 0,
          text: text.trim(),
          actor: "MANUAL_OWNER",
          claimToken: "manual-owner-token",
          fencingToken: 1,
        });

        if (!action) {
          return reply.status(500).send({ error: "Failed to create outbound action" });
        }
        // Enqueue to single browser sender queue
        await queues.browserActions.add(
          "send-action",
          {
            actionId: action.actionId,
            channelAccountId,
            conversationId,
            externalThreadRef: convData.conversation.externalThreadRef,
            inboundVersion: currentVersion,
            responseIndex: 0,
            text: text.trim(),
            textHash: action.textHash,
            actor: "MANUAL_OWNER",
            claimToken: "manual-owner-token",
            fencingToken: 1,
          },
          {
            jobId: `outbound_${action.actionId}`,
            removeOnComplete: true,
            removeOnFail: true,
          }
        );

        await eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "SEND_STARTED",
          inboundVersion: currentVersion,
          actor: user.email,
          payload: { actionId: action.actionId, manualSend: true },
        });

        broadcaster.broadcast("conversation:manual-send", { conversationId, actionId: action.actionId });
        return reply.send({ success: true, actionId: action.actionId });
      }
    );

    // 7. Reconcile Unconfirmed Action
    fastify.post<{ Params: { conversationId: string }; Body: { actionId: string; resolution: "MARK_SENT" | "RETRY" } }>(
      "/api/inbox/:conversationId/reconcile-action",
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const { conversationId } = request.params;
        const { actionId, resolution } = request.body;

        const action = await outboundRepo.getActionById(actionId);
        if (!action || action.status !== "UNCONFIRMED") {
          return reply.status(400).send({ error: "Action is not in UNCONFIRMED state" });
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

          broadcaster.broadcast("action:reconciled", { actionId, resolution: "MARK_SENT" });
          return reply.send({ success: true, resolution: "MARK_SENT" });
        } else {
          // RETRY
          const convData = await convRepo.getConversationById(conversationId);
          if (!convData) return reply.status(404).send({ error: "Conversation not found" });

          // Resume channel
          await db
            .update(channelAccounts)
            .set({ isSuspended: false, status: "RUNNING", statusReason: null, updatedAt: new Date() })
            .where(eq(channelAccounts.id, channelAccountId));

          // Re-enqueue
          await queues.browserActions.add(
            "send-action",
            {
              actionId: action.actionId,
              channelAccountId,
              conversationId,
              externalThreadRef: convData.conversation.externalThreadRef,
              inboundVersion: action.inboundVersion,
              responseIndex: action.responseIndex,
              text: action.text,
              textHash: action.textHash,
              actor: action.actor as SenderActor,
              claimToken: action.claimToken || "retry-token",
              fencingToken: action.fencingToken || 1,
            },
            {
              jobId: `outbound_retry_${action.actionId}_${Date.now()}`,
              removeOnComplete: true,
              removeOnFail: true,
            }
          );

          broadcaster.broadcast("action:reconciled", { actionId, resolution: "RETRY" });
          return reply.send({ success: true, resolution: "RETRY" });
        }
      }
    );
  };
}
