import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type {
  Database,
  QueueRepository,
  SettingsRepository,
  AiConfigRepository,
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
  participants,
  replyPolicyMembers,
  inboundMessages,
  toSafePersonId,
  resolveParticipantId,
  sanitizeApiOutput,
  ParticipantRepository,
  PolicyMemberRepository,
  stripSensitiveData,
  sanitizeCustomerOutput,
} from "@messenger/db";
import { eq, and, sql, gte, lt, desc, inArray } from "drizzle-orm";
import type { OutboxBroadcaster } from "../sse/outbox-broadcaster.js";
import {
  AiApiFormatSchema,
  SystemSettingsSchema,
  isValidAiBaseUrl,
  isValidAiModel,
  getBusinessDayRange,
  type SessionUser,
  type SenderKind,
} from "@messenger/contracts";
import { checkAiHealth, AiReplyGenerator } from "@messenger/ai";
import { requireRole } from "../auth/roles.js";

export interface AdminRoutesOptions {
  db: Database;
  queueRepo: QueueRepository;
  settingsRepo: SettingsRepository;
  aiConfigRepo: AiConfigRepository;
  incidentRepo: IncidentRepository;
  eventRepo: EventRepository;
  jobRepo: JobRepository;
  broadcaster: OutboxBroadcaster;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
  channelAccountId: string;
  participantRepo?: ParticipantRepository;
  policyMemberRepo?: PolicyMemberRepository;
}

export function createAdminRoutes(options: AdminRoutesOptions): FastifyPluginAsync {
  const {
    db,
    queueRepo,
    settingsRepo,
    aiConfigRepo,
    incidentRepo,
    eventRepo,
    broadcaster,
    requireAuth,
    channelAccountId,
  } = options;

  const participantRepo = options.participantRepo ?? new ParticipantRepository(db);
  const policyMemberRepo = options.policyMemberRepo ?? new PolicyMemberRepository(db);

  return async function (fastify) {
    fastify.addHook("preHandler", async (request, reply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;
      (request as unknown as { user: SessionUser }).user = user;
    });

    // 1. Overview metrics
    fastify.get("/api/overview", async (_request, reply) => {
      const now = new Date();
      const settingsData = await settingsRepo.getSettings(channelAccountId);
      const businessTimeZone = settingsData?.settings?.businessTimeZone || "Asia/Ho_Chi_Minh";
      const { startOfDay, endOfDay } = getBusinessDayRange(now, businessTimeZone);

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
            gte(conversations.createdAt, startOfDay),
            lt(conversations.createdAt, endOfDay)
          )
        );

      // Today messages count
      const todayMsgRes = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, channelAccountId),
            gte(messages.createdAt, startOfDay),
            lt(messages.createdAt, endOfDay)
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

      return reply.send(
        sanitizeApiOutput({
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
          businessTimeZone,
        })
      );
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
      return reply.send(sanitizeApiOutput({ items, jobs: jobsList }));
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
      let policyMembers: (typeof replyPolicyMembers.$inferSelect)[] = [];
      try {
        if (typeof (policyMemberRepo as unknown as { listMembers?: (id: string) => Promise<typeof replyPolicyMembers.$inferSelect[]> })?.listMembers === "function") {
          policyMembers = await policyMemberRepo.listMembers(channelAccountId);
        }
      } catch {
        policyMembers = [];
      }

      const [data, aiProvider] = await Promise.all([
        settingsRepo.getSettings(channelAccountId),
        aiConfigRepo.getPublicConfig(channelAccountId),
      ]);

      const participantIds = policyMembers.map((m) => m.participantId);
      let participantRows: (typeof participants.$inferSelect)[] = [];
      if (participantIds.length > 0) {
        try {
          if (typeof (db as unknown as { select?: unknown })?.select === "function") {
            participantRows = await db
              .select()
              .from(participants)
              .where(
                and(
                  eq(participants.channelAccountId, channelAccountId),
                  inArray(participants.participantId, participantIds)
                )
              );
          } else if (participantRepo) {
            const rows = await Promise.all(
              participantIds.map((id) => participantRepo.getParticipant(channelAccountId, id))
            );
            participantRows = rows.filter(Boolean) as (typeof participants.$inferSelect)[];
          }
        } catch {
          participantRows = [];
        }
      }
      const partMap = new Map(participantRows.map((p) => [p.participantId, p]));

      const safeMembers = policyMembers.map((m) => {
        const p = partMap.get(m.participantId);
        const name = p?.displayName || "Người dùng";
        return {
          id: toSafePersonId(channelAccountId, m.participantId),
          displayName: name,
          name,
          avatarUrl: p?.avatarUrl || p?.profileUrl || null,
          type: p?.senderKind || "PERSON",
          policyMode: m.policyMode,
          notes: m.notes,
          addedBy: m.addedBy,
          createdAt: m.createdAt,
        };
      });

      const safeSettings = {
        ...data.settings,
        selectedParticipantIds: (data.settings?.selectedParticipantIds || []).map((id) =>
          toSafePersonId(channelAccountId, id)
        ),
        excludedParticipantIds: (data.settings?.excludedParticipantIds || []).map((id) =>
          toSafePersonId(channelAccountId, id)
        ),
      };

      return reply.send({
        settings: safeSettings,
        revision: data.revision,
        aiProvider,
        policyMembers: safeMembers,
      });
    });

    fastify.put<{ Body: { apiFormat?: string; baseUrl?: string; model?: string; apiKey?: string } }>(
      "/api/settings/ai-provider",
      { preHandler: [requireRole("OWNER")] },
      async (request, reply) => {
        const user = (request as unknown as { user: SessionUser }).user;
        const apiFormat = AiApiFormatSchema.safeParse(request.body?.apiFormat);
        const baseUrl = request.body?.baseUrl?.trim() || "";
        const model = request.body?.model?.trim() || "";
        if (!apiFormat.success || !isValidAiBaseUrl(baseUrl) || !isValidAiModel(model)) {
          return reply.status(400).send({ error: "Invalid AI provider configuration" });
        }
        try {
          const aiProvider = await aiConfigRepo.saveConfig(
            channelAccountId,
            { apiFormat: apiFormat.data, baseUrl, model, apiKey: request.body?.apiKey },
            user.email
          );
          await eventRepo.recordEvent({
            channelAccountId,
            type: "SETTING_CHANGED",
            actor: user.email,
            payload: { section: "AI_PROVIDER", apiFormat: aiProvider.apiFormat, baseUrl: aiProvider.baseUrl, model: aiProvider.model },
          });
          await broadcaster.broadcast("settings:updated", { section: "AI_PROVIDER" });
          return reply.send({ aiProvider });
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : "Unable to save AI provider" });
        }
      }
    );

    const handleUpdateSettings = async (
      request: unknown,
      reply: { status: (code: number) => { send: (data: unknown) => unknown }; send: (data: unknown) => unknown }
    ) => {
      const user = (request as unknown as { user: SessionUser }).user;
      const body = { ...((request as unknown as { body: Record<string, unknown> }).body || {}) };

      // Map any safe person IDs in selection lists back to internal participant IDs
      if (Array.isArray(body.selectedParticipantIds)) {
        const resolved: string[] = [];
        for (const id of body.selectedParticipantIds) {
          if (typeof id !== "string") continue;
          const resolvedId = resolveParticipantId(id, channelAccountId);
          if (!resolvedId) {
            return reply.status(400).send({ error: `Invalid or unresolvable person ID in selectedParticipantIds: ${id}` });
          }
          resolved.push(resolvedId);
        }
        body.selectedParticipantIds = resolved;
      }
      if (Array.isArray(body.excludedParticipantIds)) {
        const resolved: string[] = [];
        for (const id of body.excludedParticipantIds) {
          if (typeof id !== "string") continue;
          const resolvedId = resolveParticipantId(id, channelAccountId);
          if (!resolvedId) {
            return reply.status(400).send({ error: `Invalid or unresolvable person ID in excludedParticipantIds: ${id}` });
          }
          resolved.push(resolvedId);
        }
        body.excludedParticipantIds = resolved;
      }

      // Optimistic concurrency check
      const expectedRevision =
        typeof body.expectedRevision === "number"
          ? body.expectedRevision
          : typeof body.revision === "number"
          ? body.revision
          : undefined;

      const currentSettingsData = await settingsRepo.getSettings(channelAccountId);
      if (expectedRevision !== undefined && currentSettingsData.revision !== expectedRevision) {
        return reply.status(409).send({
          error: "Settings conflict: configuration modified by another operator.",
          currentRevision: currentSettingsData.revision,
        });
      }

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

      const safeSettings = {
        ...updated.settings,
        selectedParticipantIds: (updated.settings?.selectedParticipantIds || []).map((id) =>
          toSafePersonId(channelAccountId, id)
        ),
        excludedParticipantIds: (updated.settings?.excludedParticipantIds || []).map((id) =>
          toSafePersonId(channelAccountId, id)
        ),
      };

      return reply.send({
        settings: safeSettings,
        revision: updated.revision,
      });
    };

    fastify.post<{ Body: Record<string, unknown> }>(
      "/api/settings",
      { preHandler: [requireRole("OWNER")] },
      async (request, reply) => handleUpdateSettings(request, reply)
    );

    fastify.put<{ Body: Record<string, unknown> }>(
      "/api/settings",
      { preHandler: [requireRole("OWNER")] },
      async (request, reply) => handleUpdateSettings(request, reply)
    );

    // 4b. Searchable People Endpoint (safe names, avatars, type, readable conversation context, duplicate names distinguished via context)
    const handleSearchPeople = async (
      request: FastifyRequest<{ Querystring: { q?: string; type?: string; limit?: string } }>,
      reply: FastifyReply
    ) => {
      const q = request.query?.q?.trim().toLowerCase();
      const typeFilter = request.query?.type?.trim() || "PERSON";
      const limit = Math.min(Math.max(1, parseInt(request.query?.limit || "20", 10)), 50);

      const conditions = [
        eq(participants.channelAccountId, channelAccountId),
        eq(participants.isVerified, true),
      ];

      if (typeFilter && typeFilter !== "ALL") {
        conditions.push(eq(participants.senderKind, typeFilter));
      }

      let filtered: (typeof participants.$inferSelect)[] = [];
      try {
        if (participantRepo && typeof participantRepo.searchVerifiedPersons === "function") {
          filtered = await participantRepo.searchVerifiedPersons(
            channelAccountId,
            q,
            limit,
            typeFilter as SenderKind
          );
        } else {
          const allParticipants = await db
            .select()
            .from(participants)
            .where(and(...conditions))
            .orderBy(desc(participants.updatedAt))
            .limit(limit * 2);
          filtered = q
            ? allParticipants.filter((p) => (p.displayName || "").toLowerCase().includes(q))
            : allParticipants;
        }
      } catch {
        filtered = [];
      }

      const pIds = filtered.map((p) => p.participantId);

      // Find recent conversation context for these participants
      const convMap = new Map<string, { title: string | null; lastActive: Date | null }>();
      if (pIds.length > 0) {
        try {
          const recentInbounds = await db
            .select({
              senderParticipantId: inboundMessages.senderParticipantId,
              conversationId: inboundMessages.conversationId,
              receivedAt: inboundMessages.receivedAt,
              title: conversations.title,
              threadKind: conversations.threadKind,
            })
            .from(inboundMessages)
            .innerJoin(conversations, eq(inboundMessages.conversationId, conversations.id))
            .where(
              and(
                eq(inboundMessages.channelAccountId, channelAccountId),
                inArray(inboundMessages.senderParticipantId, pIds)
              )
            )
            .orderBy(desc(inboundMessages.receivedAt))
            .limit(100);

          for (const row of recentInbounds) {
            if (row.senderParticipantId && !convMap.has(row.senderParticipantId)) {
              convMap.set(row.senderParticipantId, {
                title: row.title || (row.threadKind === "GROUP" ? "Nhóm chat" : "Hội thoại trực tiếp"),
                lastActive: row.receivedAt,
              });
            }
          }
        } catch {
          // Ignore
        }
      }

      // Check current policy membership for these participants
      let policyRows: (typeof replyPolicyMembers.$inferSelect)[] = [];
      try {
        policyRows = await policyMemberRepo.listMembers(channelAccountId);
      } catch {
        policyRows = [];
      }
      const policyMap = new Map(policyRows.map((m) => [m.participantId, m.policyMode]));

      // Check for duplicate names to distinguish via context
      const nameCounts = new Map<string, number>();
      for (const p of filtered) {
        const name = (p.displayName || "Khách hàng Messenger").trim();
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }

      const result = filtered.slice(0, limit).map((p) => {
        const name = p.displayName || "Khách hàng Messenger";
        const ctx = convMap.get(p.participantId);
        const isDuplicate = (nameCounts.get(name.trim()) || 0) > 1;

        let conversationContext = "Khách hàng đã xác minh";
        if (ctx?.title) {
          const timeStr = ctx.lastActive ? new Date(ctx.lastActive).toLocaleDateString("vi-VN") : "";
          conversationContext = timeStr ? `Hội thoại: ${ctx.title} • ${timeStr}` : `Hội thoại: ${ctx.title}`;
        }

        return {
          id: toSafePersonId(channelAccountId, p.participantId),
          name: isDuplicate && ctx?.title ? `${name} (${ctx.title})` : name,
          rawName: name,
          avatarUrl: p.avatarUrl || p.profileUrl || null,
          type: p.senderKind,
          isVerified: p.isVerified,
          conversationContext,
          duplicateContext: isDuplicate ? (ctx?.title ? `Hội thoại: ${ctx.title}` : "Khách hàng khác cùng tên") : undefined,
          policyMode: policyMap.get(p.participantId) || null,
        };
      });

      return reply.send({ people: result });
    };

    fastify.get("/api/people", handleSearchPeople);
    fastify.get("/api/settings/people", handleSearchPeople);

    // 4c. Membership CRUD with optimistic settings revision & audit
    const handleGetMembers = async (_request: FastifyRequest, reply: FastifyReply) => {
      const [members, settingsData] = await Promise.all([
        policyMemberRepo.listMembers(channelAccountId),
        settingsRepo.getSettings(channelAccountId),
      ]);

      const pIds = members.map((m) => m.participantId);
      let participantRows: (typeof participants.$inferSelect)[] = [];
      if (pIds.length > 0) {
        try {
          if (typeof (db as unknown as { select?: unknown })?.select === "function") {
            participantRows = await db
              .select()
              .from(participants)
              .where(
                and(
                  eq(participants.channelAccountId, channelAccountId),
                  inArray(participants.participantId, pIds)
                )
              );
          } else if (participantRepo) {
            const rows = await Promise.all(
              pIds.map((id) => participantRepo.getParticipant(channelAccountId, id))
            );
            participantRows = rows.filter(Boolean) as (typeof participants.$inferSelect)[];
          }
        } catch {
          participantRows = [];
        }
      }
      const partMap = new Map(participantRows.map((p) => [p.participantId, p]));

      const safeMembers = members.map((m) => {
        const p = partMap.get(m.participantId);
        const name = p?.displayName || "Người dùng đã xác minh";
        return {
          id: toSafePersonId(channelAccountId, m.participantId),
          name,
          displayName: name,
          avatarUrl: p?.avatarUrl || p?.profileUrl || null,
          type: p?.senderKind || "PERSON",
          policyMode: m.policyMode,
          notes: m.notes,
          addedBy: m.addedBy,
          createdAt: m.createdAt,
        };
      });

      return reply.send({ members: safeMembers, revision: settingsData.revision });
    };

    fastify.get("/api/settings/members", handleGetMembers);
    fastify.get("/api/settings/policy-members", handleGetMembers);

    const handlePostMember = async (
      request: FastifyRequest<{
        Body: { personId: string; policyMode?: string; notes?: string; expectedRevision?: number };
      }>,
      reply: FastifyReply
    ) => {
      const user = (request as unknown as { user: SessionUser }).user;
      const { personId, policyMode = "EXCLUDE", notes, expectedRevision } = request.body || {};

      if (!personId) {
        return reply.status(400).send({ error: "Missing personId" });
      }

      const participantId = resolveParticipantId(personId, channelAccountId);
      if (!participantId) {
        return reply.status(400).send({ error: "Invalid person identifier" });
      }

      // Verify channel-scoped VERIFIED PERSON selection
      const participant = await participantRepo.getParticipant(channelAccountId, participantId);
      if (!participant || !participant.isVerified || participant.senderKind !== "PERSON") {
        return reply.status(400).send({
          error: "Only verified persons (PERSON) can be added to reply policy.",
        });
      }

      // Optimistic concurrency check
      const currentSettingsData = await settingsRepo.getSettings(channelAccountId);
      if (expectedRevision !== undefined && currentSettingsData.revision !== expectedRevision) {
        return reply.status(409).send({
          error: "Settings conflict: configuration modified by another user.",
          currentRevision: currentSettingsData.revision,
        });
      }

      const mode = policyMode === "INCLUDE" ? "INCLUDE" : "EXCLUDE";

      // Save member
      await policyMemberRepo.addMember({
        channelAccountId,
        participantId,
        policyMode: mode,
        notes: notes || null,
        addedBy: user.email,
      });

      // Update settings arrays & revision
      const curSettings = currentSettingsData.settings;
      let newSelected = [...curSettings.selectedParticipantIds];
      let newExcluded = [...curSettings.excludedParticipantIds];

      if (mode === "EXCLUDE") {
        if (!newExcluded.includes(participantId)) newExcluded.push(participantId);
        newSelected = newSelected.filter((id) => id !== participantId);
      } else {
        if (!newSelected.includes(participantId)) newSelected.push(participantId);
        newExcluded = newExcluded.filter((id) => id !== participantId);
      }

      const updated = await settingsRepo.updateSettings(
        channelAccountId,
        {
          selectedParticipantIds: newSelected,
          excludedParticipantIds: newExcluded,
        },
        user.email,
        `Thêm người dùng vào danh sách ${mode === "EXCLUDE" ? "loại trừ" : "chỉ định"}`
      );

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SETTING_CHANGED",
        actor: user.email,
        payload: {
          action: "ADD_POLICY_MEMBER",
          policyMode: mode,
          revision: updated.revision,
        },
      });

      await broadcaster.broadcast("settings:updated", {
        revision: updated.revision,
        section: "POLICY_MEMBERS",
      });

      const memberName = participant.displayName || "Người dùng đã xác minh";
      return reply.send({
        success: true,
        revision: updated.revision,
        member: {
          id: toSafePersonId(channelAccountId, participantId),
          name: memberName,
          displayName: memberName,
          avatarUrl: participant.avatarUrl || participant.profileUrl || null,
          type: participant.senderKind,
          policyMode: mode,
          notes: notes || null,
        },
      });
    };

    fastify.post<{
      Body: { personId: string; policyMode?: string; notes?: string; expectedRevision?: number };
    }>("/api/settings/members", { preHandler: [requireRole("OWNER")] }, handlePostMember);
    fastify.post<{
      Body: { personId: string; policyMode?: string; notes?: string; expectedRevision?: number };
    }>("/api/settings/policy-members", { preHandler: [requireRole("OWNER")] }, handlePostMember);

    const handleDeleteMember = async (
      request: FastifyRequest<{
        Params: { personId: string };
        Querystring: { expectedRevision?: string };
      }>,
      reply: FastifyReply
    ) => {
      const user = (request as unknown as { user: SessionUser }).user;
      const { personId } = request.params;
      const expectedRevision = request.query?.expectedRevision ? parseInt(request.query.expectedRevision, 10) : undefined;

      const participantId = resolveParticipantId(personId, channelAccountId);
      if (!participantId) {
        return reply.status(400).send({ error: "Invalid person identifier" });
      }

      // Optimistic concurrency check
      const currentSettingsData = await settingsRepo.getSettings(channelAccountId);
      if (expectedRevision !== undefined && !isNaN(expectedRevision) && currentSettingsData.revision !== expectedRevision) {
        return reply.status(409).send({
          error: "Settings conflict: configuration modified by another user.",
          currentRevision: currentSettingsData.revision,
        });
      }

      await policyMemberRepo.removeMember(channelAccountId, participantId);

      // Update settings arrays & revision
      const curSettings = currentSettingsData.settings;
      const newSelected = curSettings.selectedParticipantIds.filter((id) => id !== participantId);
      const newExcluded = curSettings.excludedParticipantIds.filter((id) => id !== participantId);

      const updated = await settingsRepo.updateSettings(
        channelAccountId,
        {
          selectedParticipantIds: newSelected,
          excludedParticipantIds: newExcluded,
        },
        user.email,
        "Xóa người dùng khỏi danh sách chính sách"
      );

      await eventRepo.recordEvent({
        channelAccountId,
        type: "SETTING_CHANGED",
        actor: user.email,
        payload: {
          action: "REMOVE_POLICY_MEMBER",
          revision: updated.revision,
        },
      });

      await broadcaster.broadcast("settings:updated", {
        revision: updated.revision,
        section: "POLICY_MEMBERS",
      });

      return reply.send({ success: true, revision: updated.revision });
    };

    fastify.delete<{
      Params: { personId: string };
      Querystring: { expectedRevision?: string };
    }>("/api/settings/members/:personId", { preHandler: [requireRole("OWNER")] }, handleDeleteMember);
    fastify.delete<{
      Params: { personId: string };
      Querystring: { expectedRevision?: string };
    }>("/api/settings/policy-members/:personId", { preHandler: [requireRole("OWNER")] }, handleDeleteMember);

    fastify.post<{ Body: { apiFormat?: string; baseUrl?: string; model?: string; apiKey?: string } }>(
      "/api/settings/test-ai",
      { preHandler: [requireRole("OPERATOR")] },
      async (request, reply) => {
        const current = await aiConfigRepo.getConfig(channelAccountId);
        const apiFormat = AiApiFormatSchema.safeParse(request.body?.apiFormat || current.apiFormat);
        const baseUrl = request.body?.baseUrl?.trim() || current.baseUrl;
        const model = request.body?.model?.trim() || current.model;
        const apiKey = request.body?.apiKey?.trim() || current.apiKey || "dummy-dev-key";
        if (!apiFormat.success || !isValidAiBaseUrl(baseUrl) || !isValidAiModel(model)) {
          return reply.status(400).send({
            ok: false,
            healthy: false,
            status: "unhealthy",
            message: "Invalid AI provider configuration",
          });
        }
        const health = await checkAiHealth({ apiFormat: apiFormat.data, baseUrl, apiKey, model });
        return reply.send({
          ...health,
          healthy: health.healthy ?? health.ok,
          status: health.status ?? (health.ok ? "healthy" : "unhealthy"),
          model,
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

        const sanitizedItems = items.map((item) => ({
          ...item,
          requestSnapshot: item.requestSnapshot ? stripSensitiveData(item.requestSnapshot) : null,
          responseSnapshot: item.responseSnapshot ? stripSensitiveData(item.responseSnapshot) : null,
          usedResult: item.usedResult ? sanitizeCustomerOutput(item.usedResult) : null,
        }));

        return reply.send({
          items: sanitizedItems,
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
            errorMessage: `Model '${requestedModel}' has an invalid name`,
          });
        }
        const model = requestedModel || settings.aiModel;
        const testText = request.body?.message || "Xin chào, shop có bán áo thun không?";

        const generator = new AiReplyGenerator();
        const aiConfig = await aiConfigRepo.getConfig(channelAccountId);
        const result = await generator.generateReply({
          customerName: "Khách test debug",
          customerSummary: "Khách hàng thử nghiệm kết nối proxy",
          recentMessages: [{ direction: "INBOUND", text: testText }],
          settings: {
            ...settings,
            aiModel: model,
          },
        }, {
          apiFormat: aiConfig.apiFormat,
          baseUrl: aiConfig.baseUrl,
          apiKey: aiConfig.apiKey,
          model,
          timeoutMs: settings.aiTimeoutMs,
        });

        const customerData = result.data
          ? {
              messages: result.data.messages,
              needsClarification: result.data.needsClarification,
            }
          : undefined;

        return reply.send({
          success: result.success,
          latencyMs: result.latencyMs,
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          promptHash: result.promptHash,
          responseHash: result.responseHash,
          requestSnapshot: result.requestSnapshot ? stripSensitiveData(result.requestSnapshot) : null,
          responseSnapshot: result.responseSnapshot ? stripSensitiveData(result.responseSnapshot) : null,
          usedResult: result.usedResult ? sanitizeCustomerOutput(result.usedResult) : null,
          data: customerData,
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

        return reply.send(
          sanitizeApiOutput({
            items,
            total,
            limit,
            offset,
            hasMore,
          })
        );
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
