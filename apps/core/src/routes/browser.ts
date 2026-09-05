import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  ConversationRepository,
  OutboundRepository,
  JobRepository,
  EventRepository,
  SettingsRepository,
  OutboxRepository,
} from "@messenger/db";
import { InboundMessagePayloadSchema, type InboundMessagePayload, type OutboundActionStatus } from "@messenger/contracts";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import { requireRole } from "../auth/roles.js";
import type { SessionUser } from "@messenger/contracts";

export interface BrowserRoutesOptions {
  db: Database;
  convRepo: ConversationRepository;
  outboundRepo: OutboundRepository;
  jobRepo: JobRepository;
  eventRepo: EventRepository;
  settingsRepo: SettingsRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
}

export function createBrowserRoutes(options: BrowserRoutesOptions): FastifyPluginAsync {
  const {
    convRepo,
    outboundRepo,
    jobRepo: _jobRepo,
    eventRepo,
    settingsRepo,
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

    // 1. Ingest Inbound Message from browser-agent
    fastify.post<{ Body: InboundMessagePayload }>(
      "/api/browser/inbound",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const parsed = InboundMessagePayloadSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: "Invalid inbound payload", details: parsed.error.issues });
        }

        const payload = parsed.data;

        // Get debounce window from settings
        const { settings } = await settingsRepo.getSettings(payload.channelAccountId);
        const debounceMs = settings.debounceMs || 3000;

        // Ingest into database (deduplication, bumps version, records message, atomically sets up debounce job if eligible LIVE)
        const result = await convRepo.ingestInboundMessage(payload, { debounceMs });
        if (result.isDuplicate) {
          return reply.send(result);
        }

        const isEligibleLive = Boolean(result.eligibility?.eligible && result.decision?.evaluationMode === "LIVE");

        if (isEligibleLive) {
          // Record audit event
          await eventRepo.recordEvent({
            channelAccountId: payload.channelAccountId,
            conversationId: result.conversationId,
            type: "DEBOUNCE_STARTED",
            inboundVersion: result.inboundVersion,
            actor: "BROWSER_AGENT",
            payload: { debounceMs },
          });
        }

        await outboxRepo.enqueue({
          channelAccountId: payload.channelAccountId,
          conversationId: result.conversationId,
          eventType: "inbound:received",
          payload: {
            conversationId: result.conversationId,
            inboundVersion: result.inboundVersion,
            text: payload.text,
            eligible: result.eligibility?.eligible,
            decision: result.eligibility?.decision,
            reasonCode: result.eligibility?.reasonCode,
          },
        });

        await broadcaster.broadcast("inbound:received", {
          conversationId: result.conversationId,
          inboundVersion: result.inboundVersion,
          eligible: result.eligibility?.eligible,
          decision: result.eligibility?.decision,
          reasonCode: result.eligibility?.reasonCode,
        });

        return reply.send(result);
      }
    );

    // 2. Fetch Pending Outbound Actions ready for browser sending
    fastify.get(
      "/api/browser/actions/pending",
      { preHandler: [requireRole("OPERATOR")] },
      async (_request, reply) => {
        const items = await outboundRepo.getPendingActions(channelAccountId, 20);
        return reply.send({ items });
      }
    );

    // 3. Status transition for outbound action
    fastify.post<{
      Params: { actionId: string };
      Body: {
        fromStatus: OutboundActionStatus;
        toStatus: OutboundActionStatus;
        externalMessageRef?: string;
        errorMessage?: string;
      };
    }>(
      "/api/browser/actions/:actionId/transition",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const { actionId } = request.params;
        const { fromStatus, toStatus, externalMessageRef, errorMessage } = request.body || {};

        try {
          const updated = await outboundRepo.transitionStatus(actionId, fromStatus, toStatus, {
            externalMessageRef,
            errorMessage,
          });

          await broadcaster.broadcast("outbound:transition", {
            actionId,
            fromStatus,
            toStatus,
          });

          return reply.send({ success: true, action: updated });
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
      }
    );

    // 4. Confirm Sent
    fastify.post<{
      Params: { actionId: string };
      Body: { externalMessageRef: string };
    }>(
      "/api/browser/actions/:actionId/confirm",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const { actionId } = request.params;
        const { externalMessageRef } = request.body || {};

        if (!externalMessageRef) {
          return reply.status(400).send({ error: "externalMessageRef is required" });
        }

        try {
          const action = await outboundRepo.confirmSent(actionId, externalMessageRef);
          await broadcaster.broadcast("outbound:confirmed", {
            actionId,
            externalMessageRef,
          });
          return reply.send({ success: true, action });
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
      }
    );

    // 5. Mark Send Uncertain
    fastify.post<{
      Params: { actionId: string };
      Body: { reason: string };
    }>(
      "/api/browser/actions/:actionId/uncertain",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const { actionId } = request.params;
        const { reason } = request.body || {};

        try {
          const action = await outboundRepo.markSendUncertain(actionId, reason || "Send verification uncertain");
          await broadcaster.broadcast("outbound:uncertain", {
            actionId,
            reason,
          });
          return reply.send({ success: true, action });
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
      }
    );
  };
}
