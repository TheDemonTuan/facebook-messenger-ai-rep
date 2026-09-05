import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  QueueRepository,
  SettingsRepository,
  IncidentRepository,
  EventRepository,
  JobRepository,
} from "@messenger/db";
import {
  channelAccounts,
  conversations,
  messages,
  incidents,
  aiRuns,
  conversationEvents,
  jobs,
} from "@messenger/db";
import { eq, and, sql, gte, desc } from "drizzle-orm";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import { SystemSettingsSchema, isValidAiModel, type SessionUser } from "@messenger/contracts";
import { checkAiHealth, AiReplyGenerator } from "@messenger/ai";
import { requireRole } from "../auth/roles.js";

export interface AdminRoutesOptions {
  db: Database;
  queueRepo: QueueRepository;
  settingsRepo: SettingsRepository;
  incidentRepo: IncidentRepository;
  eventRepo: EventRepository;
  jobRepo: JobRepository;
  broadcaster: OutboxBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
}

export function createAdminRoutes(options: AdminRoutesOptions): FastifyPluginAsync {
  const {
    db,
    queueRepo,
    settingsRepo,
    incidentRepo,
    eventRepo,
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
          inboundVersion: conversations.inboundVersion,
          claimedAt: conversations.claimedAt,
          claimToken: conversations.claimToken,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelAccountId, channelAccountId),
            sql`${conversations.status} IN ('READING', 'THINKING', 'DRAFT_READY', 'TYPING', 'SENDING')`
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

      const oldestWaitSeconds =
        queueList.length > 0
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
    fastify.get<{ Querystring: { limit?: string } }>("/api/queue", async (request, reply) => {
      const jobLimit = Math.min(Math.max(1, parseInt(request.query?.limit || "50", 10)), 100);
      const [items, jobsList] = await Promise.all([
        queueRepo.getQueueList(channelAccountId),
        db
          .select()
          .from(jobs)
          .where(eq(jobs.channelAccountId, channelAccountId))
          .orderBy(desc(jobs.createdAt))
          .limit(jobLimit),
      ]);
      return reply.send({ items, jobs: jobsList });
    });

    fastify.post<{ Params: { conversationId: string } }>(
      "/api/queue/:conversationId/prioritize",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const { conversationId } = request.params;
        const success = await queueRepo.prioritizeConversation(conversationId);
        if (!success) {
          return reply.status(404).send({ error: "Conversation not found in queue" });
        }
        await broadcaster.broadcast("queue:updated", { conversationId, prioritized: true });
        return reply.send({ success: true, conversationId });
      }
    );

    // 3. Channel controls
    fastify.post(
      "/api/channel/pause",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
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

        await broadcaster.broadcast("channel:status", { status: "PAUSED", isPaused: true });
        return reply.send({ success: true, status: "PAUSED" });
      }
    );

    fastify.post(
      "/api/channel/resume",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
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

        await broadcaster.broadcast("channel:status", { status: "RUNNING", isPaused: false, isSuspended: false });
        return reply.send({ success: true, status: "RUNNING" });
      }
    );

    fastify.post(
      "/api/channel/suspend",
      { preHandler: [requireRole("OWNER")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        await db
          .update(channelAccounts)
          .set({ isSuspended: true, status: "SUSPENDED", statusReason: "Manual suspension by owner", updatedAt: new Date() })
          .where(eq(channelAccounts.id, channelAccountId));

        await eventRepo.recordEvent({
          channelAccountId,
          type: "SESSION_SUSPENDED",
          actor: user.email,
          payload: { action: "MANUAL_SUSPEND" },
        });

        await broadcaster.broadcast("channel:status", { status: "SUSPENDED", isSuspended: true });
        return reply.send({ success: true, status: "SUSPENDED" });
      }
    );

    // 4. Settings
    fastify.get("/api/settings", async (_request, reply) => {
      const data = await settingsRepo.getSettings(channelAccountId);
      return reply.send(data);
    });

    const handleUpdateSettings = async (
      request: unknown,
      reply: { status: (code: number) => { send: (data: unknown) => unknown }; send: (data: unknown) => unknown }
    ) => {
      const user = (request as unknown as { user: SessionUser }).user;
      const body = (request as unknown as { body: Record<string, unknown> }).body;
      const parsed = SystemSettingsSchema.partial().safeParse(body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid settings format", details: parsed.error.issues });
      }

      const reason =
        typeof body?.reason === "string" && body.reason.trim().length > 0
          ? body.reason.trim()
          : "Updated settings from core control plane";

      const updated = await settingsRepo.updateSettings(
        channelAccountId,
        parsed.data,
        user.email,
        reason
      );

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SETTING_CHANGED",
        actor: user.email,
        payload: { revision: updated.revision, reason },
      });

      await broadcaster.broadcast("settings:updated", { revision: updated.revision });
      return reply.send(updated);
    };

    fastify.post<{ Body: Record<string, unknown> }>(
      "/api/settings",
      { preHandler: [requireRole("OWNER")] },
      handleUpdateSettings as any
    );

    fastify.put<{ Body: Record<string, unknown> }>(
      "/api/settings",
      { preHandler: [requireRole("OWNER")] },
      handleUpdateSettings as any
    );

    fastify.post<{ Body: { model?: string } }>(
      "/api/settings/test-ai",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const { model } = request.body || {};
        if (model && !isValidAiModel(model)) {
          return reply.status(400).send({
            ok: false,
            healthy: false,
            status: "unhealthy",
            message: `Model '${model}' is not in approved allowlist`,
          });
        }
        const health = await checkAiHealth({ model });
        return reply.send({
          ...health,
          healthy: health.healthy ?? health.ok,
          status: health.status ?? (health.ok ? "healthy" : "unhealthy"),
          model: model || health.model,
        });
      }
    );

    // 5. AI Runs with Pagination
    fastify.get<{ Querystring: { conversationId?: string; status?: string; limit?: string; offset?: string } }>(
      "/api/ai-runs",
      async (request, reply) => {
        const limit = Math.min(Math.max(1, parseInt(request.query.limit || "50", 10)), 100);
        const offset = Math.max(0, parseInt(request.query.offset || "0", 10));

        const conditions = [eq(aiRuns.channelAccountId, channelAccountId)];
        if (request.query.conversationId) {
          conditions.push(eq(aiRuns.conversationId, request.query.conversationId));
        }
        if (request.query.status) {
          conditions.push(eq(aiRuns.status, request.query.status));
        }

        const [items, totalRes] = await Promise.all([
          db
            .select()
            .from(aiRuns)
            .where(and(...conditions))
            .orderBy(desc(aiRuns.createdAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(aiRuns)
            .where(and(...conditions)),
        ]);

        const total = totalRes[0]?.count || 0;
        const hasMore = offset + items.length < total;

        return reply.send({
          items,
          total,
          limit,
          offset,
          hasMore,
        });
      }
    );

    fastify.post<{
      Body: {
        message?: string;
        model?: string;
      };
    }>(
      "/api/ai-runs/test",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const current = await settingsRepo.getSettings(channelAccountId);
        const settings = current.settings;
        const requestedModel = request.body?.model;
        if (requestedModel && !isValidAiModel(requestedModel)) {
          return reply.status(400).send({
            success: false,
            errorMessage: `Model '${requestedModel}' is not in approved allowlist`,
          });
        }
        const model = requestedModel || settings.aiModel;
        const testText = request.body?.message || "Xin chào, shop có bán áo thun không?";

        const generator = new AiReplyGenerator();
        const result = await generator.generateReply({
          customerName: "Khách test debug",
          customerSummary: "Khách hàng thử nghiệm kết nối proxy",
          recentMessages: [{ direction: "INBOUND", text: testText }],
          settings: {
            ...settings,
            aiModel: model,
          },
        });

        return reply.send({
          success: result.success,
          latencyMs: result.latencyMs,
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          promptHash: result.promptHash,
          responseHash: result.responseHash,
          data: result.data,
          errorMessage: result.errorMessage,
        });
      }
    );

    // 6. Incidents with Pagination
    fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
      "/api/incidents",
      async (request, reply) => {
        const limit = Math.min(Math.max(1, parseInt(request.query.limit || "50", 10)), 100);
        const offset = Math.max(0, parseInt(request.query.offset || "0", 10));

        const conditions = [eq(incidents.channelAccountId, channelAccountId)];
        if (request.query.status) {
          conditions.push(eq(incidents.status, request.query.status));
        }

        const [items, totalRes] = await Promise.all([
          db
            .select()
            .from(incidents)
            .where(and(...conditions))
            .orderBy(desc(incidents.createdAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(incidents)
            .where(and(...conditions)),
        ]);

        const total = totalRes[0]?.count || 0;
        const hasMore = offset + items.length < total;

        return reply.send({
          items,
          total,
          limit,
          offset,
          hasMore,
        });
      }
    );

    fastify.post<{ Params: { id: string }; Body: { resolutionNote?: string } }>(
      "/api/incidents/:id/resolve",
      { preHandler: [requireRole("OPERATOR")] },
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
        await broadcaster.broadcast("incident:resolved", { incidentId });
        return reply.send({ success: true, incident: resolved });
      }
    );

    fastify.post(
      "/api/incidents/resolve-all",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const allIncidents = await incidentRepo.getOpenIncidents(channelAccountId);
        const openItems = allIncidents.filter((i) => i.status === "OPEN");

        for (const item of openItems) {
          await incidentRepo.resolveIncident(item.id, user.email, "Đã đóng hàng loạt từ quản lý sự cố");
        }

        await broadcaster.broadcast("incident:resolved", { count: openItems.length });
        return reply.send({ success: true, count: openItems.length });
      }
    );

    // 7. Audit logs with Pagination
    fastify.get<{ Querystring: { conversationId?: string; limit?: string; offset?: string } }>(
      "/api/audit",
      async (request, reply) => {
        const limit = Math.min(Math.max(1, parseInt(request.query.limit || "100", 10)), 200);
        const offset = Math.max(0, parseInt(request.query.offset || "0", 10));

        const conditions = [eq(conversationEvents.channelAccountId, channelAccountId)];
        if (request.query.conversationId) {
          conditions.push(eq(conversationEvents.conversationId, request.query.conversationId));
        }

        const [items, totalRes] = await Promise.all([
          db
            .select()
            .from(conversationEvents)
            .where(and(...conditions))
            .orderBy(desc(conversationEvents.createdAt))
            .limit(limit)
            .offset(offset),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(conversationEvents)
            .where(and(...conditions)),
        ]);

        const total = totalRes[0]?.count || 0;
        const hasMore = offset + items.length < total;

        return reply.send({
          items,
          total,
          limit,
          offset,
          hasMore,
        });
      }
    );

    // 8. Audit CSV Export
    fastify.get<{ Querystring: { conversationId?: string } }>(
      "/api/audit/csv",
      async (request, reply) => {
        const conditions = [eq(conversationEvents.channelAccountId, channelAccountId)];
        if (request.query.conversationId) {
          conditions.push(eq(conversationEvents.conversationId, request.query.conversationId));
        }

        const rows = await db
          .select()
          .from(conversationEvents)
          .where(and(...conditions))
          .orderBy(desc(conversationEvents.createdAt))
          .limit(1000);

        let csv = "id,channelAccountId,conversationId,type,inboundVersion,actor,createdAt,payload\n";
        for (const r of rows) {
          const payloadStr = JSON.stringify(r.payload || {}).replace(/"/g, '""');
          csv += `"${r.id}","${r.channelAccountId}","${r.conversationId || ""}","${r.type}",${r.inboundVersion || ""},"${r.actor}","${r.createdAt?.toISOString() || ""}","${payloadStr}"\n`;
        }

        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", "attachment; filename=\"audit-logs.csv\"");
        return reply.send(csv);
      }
    );
  };
}
