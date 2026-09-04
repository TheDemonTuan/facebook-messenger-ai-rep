import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import type { SessionUser } from "@messenger/contracts";

export interface EventsRoutesOptions {
  broadcaster: OutboxBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
}

export function createEventsRoutes(options: EventsRoutesOptions): FastifyPluginAsync {
  const { broadcaster, requireAuth, channelAccountId } = options;

  return async function (fastify) {
    const handleSse = async (
      request: FastifyRequest<{ Querystring: { cursor?: string; lastEventId?: string } }>,
      reply: FastifyReply
    ) => {
      const user = await requireAuth(request, reply);
      if (!user) return;

      const lastEventId =
        (request.headers["last-event-id"] as string | undefined) ||
        request.query.lastEventId ||
        request.query.cursor;

      await broadcaster.addClient(reply, {
        lastEventId,
        channelAccountId,
      });
    };

    fastify.get("/events", handleSse);
    fastify.get("/api/events", handleSse);
  };
}
