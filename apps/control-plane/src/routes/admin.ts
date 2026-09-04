import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  QueueRepository,
  SettingsRepository,
  IncidentRepository,
  EventRepository,
} from "@messenger/db";
import { channelAccounts, conversations, messages, conversationQueue, incidents, aiRuns } from "@messenger/db";
import { eq, and, sql, gte, desc } from "drizzle-orm";
import type { SseBroadcaster } from "../sse/broadcaster.js";
import { SystemSettingsSchema, type SessionUser } from "@messenger/contracts";
import { checkAiHealth, AiReplyGenerator } from "@messenger/ai";

export interface AdminRoutesOptions {
  db: Database;
  queueRepo: QueueRepository;
  settingsRepo: SettingsRepository;
  incidentRepo: IncidentRepository;
  eventRepo: EventRepository;
  broadcaster: SseBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
}

export function createAdminRoutes(options: AdminRoutesOptions): FastifyPluginAsync {
  const { db, queueRepo, settingsRepo, incidentRepo, eventRepo, broadcaster, requireAuth, channelAccountId } = options;

  return async function (fastify) {
    fastify.addHook("preHandler", async (request, reply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;
      (request as unknown as { user: SessionUser }).user = user;
    });

    // 1. Overview metrics
    fastify.get("/api/overview", async (_request, reply) => {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const [channel] = await db
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.id, channelAccountId))
        .limit(1);

      // Active conversation being served
      const activeConv = await db
        .select({
          id: conversations.id,
          status: conversations.status,
          externalThreadId: conversations.externalThreadId,
          claimedAt: conversations.claimedAt,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelAccountId, channelAccountId),
            sql`${conversations.status} IN ('CLAIMED', 'THINKING', 'DRAFT_READY', 'TYPING', 'SENDING')`
          )
        )
        .limit(1);

      // Queue items
      const queueList = await queueRepo.getQueueList(channelAccountId);

      // Today conversations count
      const todayConvRes = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelAccountId, channelAccountId),
            gte(conversations.createdAt, startOfDay)
          )
        );

      // Today messages count
      const todayMsgRes = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, channelAccountId),
            gte(messages.createdAt, startOfDay)
          )
        );

      // Open incidents
      const openIncidentsRes = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(incidents)
        .where(
          and(
            eq(incidents.channelAccountId, channelAccountId),
            eq(incidents.status, "OPEN")
          )
        );

      const oldestWaitSeconds = queueList.length > 0
        ? Math.max(0, Math.floor((now.getTime() - new Date(queueList[0]!.queuedAt).getTime()) / 1000))
        : 0;

      const estimatedWaitSeconds = queueList.reduce((acc, curr) => Math.max(acc, curr.estimatedWaitSeconds), 0);

      return reply.send({
        channelStatus: channel?.status || "RUNNING",
        channelIsSuspended: channel?.isSuspended || false,
        channelIsPaused: channel?.isPaused || false,
        activeConversation: activeConv[0] || null,
        queueLength: queueList.length,
        oldestWaitSeconds,
        estimatedWaitSeconds,
        todayConversationsCount: todayConvRes[0]?.count || 0,
        todayMessagesCount: todayMsgRes[0]?.count || 0,
        openIncidentsCount: openIncidentsRes[0]?.count || 0,
      });
    });

    // 2. Queue list
    fastify.get("/api/queue", async (_request, reply) => {
      const items = await queueRepo.getQueueList(channelAccountId);
      return reply.send({ items });
    });

    fastify.post<{ Params: { conversationId: string } }>(
      "/api/queue/:conversationId/prioritize",
      async (request, reply) => {
        const { conversationId } = request.params;
        const success = await queueRepo.prioritizeConversation(conversationId);
        if (!success) {
          return reply.status(404).send({ error: "Conversation not found in queue" });
        }
        broadcaster.broadcast("queue:updated", { conversationId, prioritized: true });
        return reply.send({ success: true, conversationId });
      }
    );

    // 3. Channel controls
    fastify.post("/api/channel/pause", async (request, reply) => {
      const user = (request as unknown as { user: SessionUser }).user;
      await db
        .update(channelAccounts)
        .set({ isPaused: true, status: "PAUSED", updatedAt: new Date() })
        .where(eq(channelAccounts.id, channelAccountId));

      await settingsRepo.updateSettings(
        channelAccountId,
        { pauseIntakeProcessing: true },
        user.email,
        "Paused intake processing via dashboard"
      );

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SESSION_SUSPENDED",
        actor: user.email,
        payload: { action: "PAUSE_INTAKE" },
      });

      broadcaster.broadcast("channel:status", { status: "PAUSED", isPaused: true });
      return reply.send({ success: true, status: "PAUSED" });
    });

    fastify.post("/api/channel/resume", async (request, reply) => {
      const user = (request as unknown as { user: SessionUser }).user;
      await db
        .update(channelAccounts)
        .set({ isPaused: false, isSuspended: false, status: "RUNNING", statusReason: null, updatedAt: new Date() })
        .where(eq(channelAccounts.id, channelAccountId));

      await settingsRepo.updateSettings(
        channelAccountId,
        { pauseIntakeProcessing: false },
        user.email,
        "Resumed intake processing via dashboard"
      );

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SESSION_RESUMED",
        actor: user.email,
        payload: { action: "RESUME_INTAKE" },
      });

      broadcaster.broadcast("channel:status", { status: "RUNNING", isPaused: false, isSuspended: false });
      return reply.send({ success: true, status: "RUNNING" });
    });

    fastify.post("/api/channel/suspend", async (request, reply) => {
      const user = (request as unknown as { user: SessionUser }).user;
      await db
        .update(channelAccounts)
        .set({ isSuspended: true, status: "SUSPENDED", statusReason: "Manually suspended by operator", updatedAt: new Date() })
        .where(eq(channelAccounts.id, channelAccountId));

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SESSION_SUSPENDED",
        actor: user.email,
        payload: { action: "MANUAL_SUSPEND" },
      });

      broadcaster.broadcast("channel:status", { status: "SUSPENDED", isSuspended: true });
      return reply.send({ success: true, status: "SUSPENDED" });
    });

    // 4. Settings
    fastify.get("/api/settings", async (_request, reply) => {
      const result = await settingsRepo.getSettings(channelAccountId);
      return reply.send(result);
    });

    fastify.put("/api/settings", async (request, reply) => {
      const user = (request as unknown as { user: SessionUser }).user;
      const parsed = SystemSettingsSchema.partial().safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid settings payload", details: parsed.error.format() });
      }

      const updated = await settingsRepo.updateSettings(
        channelAccountId,
        parsed.data,
        user.email,
        (request.body as { reason?: string })?.reason || "Updated via dashboard settings"
      );

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SETTING_CHANGED",
        actor: user.email,
        payload: { revision: updated.revision, changedFields: Object.keys(parsed.data) },
      });

      broadcaster.broadcast("settings:updated", { revision: updated.revision });
      return reply.send(updated);
    });

    fastify.post("/api/settings/test-ai", async (request, reply) => {
      const body = (request.body || {}) as {
        aiBaseUrl?: string;
        aiApiKey?: string;
        aiModel?: string;
      };
      const current = await settingsRepo.getSettings(channelAccountId);
      const baseURL = body.aiBaseUrl || current.settings.aiBaseUrl;
      const apiKey = body.aiApiKey || current.settings.aiApiKey;
      const model = body.aiModel || current.settings.aiModel;

      const health = await checkAiHealth({ baseURL, apiKey, model });
      return reply.send(health);
    });

    // 4b. AI Runs & Proxy Debug Logs
    fastify.get<{ Querystring: { conversationId?: string; status?: string; limit?: string } }>(
      "/api/ai-runs",
      async (request, reply) => {
        const limit = Math.min(parseInt(request.query.limit || "50", 10), 100);
        const conditions = [eq(aiRuns.channelAccountId, channelAccountId)];
        if (request.query.conversationId) {
          conditions.push(eq(aiRuns.conversationId, request.query.conversationId));
        }
        if (request.query.status) {
          conditions.push(eq(aiRuns.status, request.query.status));
        }
        const items = await db
          .select()
          .from(aiRuns)
          .where(and(...conditions))
          .orderBy(desc(aiRuns.createdAt))
          .limit(limit);

        return reply.send({ items });
      }
    );

    fastify.post<{
      Body: {
        message?: string;
        model?: string;
        aiBaseUrl?: string;
        aiApiKey?: string;
      };
    }>("/api/ai-runs/test", async (request, reply) => {
      const current = await settingsRepo.getSettings(channelAccountId);
      const settings = current.settings;
      const baseURL = request.body?.aiBaseUrl || settings.aiBaseUrl;
      const apiKey = request.body?.aiApiKey || settings.aiApiKey;
      const model = request.body?.model || settings.aiModel;
      const testText = request.body?.message || "Xin chào, shop có bán áo thun không?";

      const generator = new AiReplyGenerator();
      const result = await generator.generateReply({
        customerName: "Khách test debug",
        customerSummary: "Khách hàng thử nghiệm kết nối proxy",
        recentMessages: [{ direction: "INBOUND", text: testText }],
        settings: {
          ...settings,
          aiBaseUrl: baseURL,
          aiApiKey: apiKey,
          aiModel: model,
        },
      });

      return reply.send({
        success: result.success,
        model: result.model,
        baseURL,
        latencyMs: result.latencyMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        requestMessages: result.requestMessages,
        rawResponse: result.rawResponse,
        data: result.data,
        errorMessage: result.errorMessage,
      });
    });

    // 5. Incidents
    fastify.get("/api/incidents", async (_request, reply) => {
      const items = await incidentRepo.getOpenIncidents(channelAccountId);
      return reply.send({ items });
    });

    fastify.post<{ Params: { id: string }; Body: { resolutionNote?: string } }>(
      "/api/incidents/:id/resolve",
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const incidentId = request.params.id;
        const resolved = await incidentRepo.resolveIncident(
          incidentId,
          user.email,
          request.body?.resolutionNote
        );
        if (!resolved) {
          return reply.status(404).send({ error: "Incident not found" });
        }
        broadcaster.broadcast("incident:resolved", { incidentId });
        return reply.send({ success: true, incident: resolved });
      }
    );

    // 6. Audit logs
    fastify.get<{ Querystring: { conversationId?: string; limit?: string } }>(
      "/api/audit",
      async (request, reply) => {
        const limit = parseInt(request.query.limit || "50", 10);
        const events = await eventRepo.getRecentEvents(request.query.conversationId, limit);
        return reply.send({ events });
      }
    );

    fastify.get<{ Querystring: { conversationId?: string; limit?: string } }>(
      "/api/audit/csv",
      async (request, reply) => {
        const limit = parseInt(request.query.limit || "500", 10);
        const events = await eventRepo.getRecentEvents(request.query.conversationId, limit);

        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="audit_events.csv"');

        let csv = "ID,Timestamp,Type,ConversationID,InboundVersion,Actor,Payload\n";
        for (const ev of events) {
          const payloadStr = JSON.stringify(ev.payload).replace(/"/g, '""');
          csv += `"${ev.id}","${new Date(ev.createdAt).toISOString()}","${ev.type}","${ev.conversationId || ""}","${ev.inboundVersion ?? ""}","${ev.actor}","${payloadStr}"\n`;
        }
        return reply.send(csv);
      }
    );
  };
}
