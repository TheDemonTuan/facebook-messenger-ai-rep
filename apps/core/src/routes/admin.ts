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
  turns,
  outboundActions,
  customers,
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
    jobRepo,
    broadcaster,
    requireAuth,
    channelAccountId,
  } = options;

  const participantRepo = options.participantRepo ?? new ParticipantRepository(db);
  const policyMemberRepo = options.policyMemberRepo ?? new PolicyMemberRepository(db);
  const discoveryCandidates = new Map<string, { participantId: string; name: string; avatarUrl?: string; expiresAt: number }>();

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
      const openIncidentsCount = openIncidentsRes[0]?.count || 0;

      // Auto-heal: If channel was suspended due to incidents that have all been resolved, and channel is not manually paused, restore it!
      if (channel?.isSuspended && openIncidentsCount === 0 && !channel?.isPaused) {
        await db
          .update(channelAccounts)
          .set({
            isSuspended: false,
            status: "RUNNING",
            statusReason: null,
            updatedAt: new Date(),
          })
          .where(eq(channelAccounts.id, channelAccountId));
        channel.isSuspended = false;
        channel.status = "RUNNING";
        channel.statusReason = null;
        await broadcaster.broadcast("channel:status", { status: "RUNNING", isPaused: false, isSuspended: false });
      }

      const oldestWaitSeconds =
        queueList.length > 0
          ? Math.max(0, Math.floor((now.getTime() - new Date(queueList[0]!.queuedAt).getTime()) / 1000))
          : 0;

      const estimatedWaitSeconds = queueList.reduce((acc, curr) => Math.max(acc, curr.estimatedWaitSeconds), 0);

      return reply.send(
        sanitizeApiOutput({
          channelStatus: channel?.status || "RUNNING",
          channelStatusReason: channel?.statusReason || null,
          channelIsSuspended: channel?.isSuspended || false,
          channelIsPaused: channel?.isPaused || false,
          channelLastHealthCheckAt: channel?.lastHealthCheckAt || null,
          channelLastSeenActiveAt: channel?.lastSeenActiveAt || null,
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

    // Workflow Live Pipeline state for interactive n8n / flow graph
    fastify.get("/api/workflow/live", async (_request, reply) => {
      const now = new Date();
      const channel = await db
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.id, channelAccountId))
        .then((r) => r[0]);

      const [
        queueItems,
        recentTurn,
        recentAction,
        recentAiRun,
        recentInbound,
        openIncidents,
        settingsData,
      ] = await Promise.all([
        queueRepo.getQueueList(channelAccountId),
        db
          .select()
          .from(turns)
          .where(eq(turns.channelAccountId, channelAccountId))
          .orderBy(desc(turns.startedAt))
          .limit(1)
          .then((r) => r[0] || null),
        db
          .select()
          .from(outboundActions)
          .where(eq(outboundActions.channelAccountId, channelAccountId))
          .orderBy(desc(outboundActions.createdAt))
          .limit(1)
          .then((r) => r[0] || null),
        db
          .select()
          .from(aiRuns)
          .where(eq(aiRuns.channelAccountId, channelAccountId))
          .orderBy(desc(aiRuns.createdAt))
          .limit(1)
          .then((r) => r[0] || null),
        db
          .select()
          .from(inboundMessages)
          .where(eq(inboundMessages.channelAccountId, channelAccountId))
          .orderBy(desc(inboundMessages.receivedAt))
          .limit(1)
          .then((r) => r[0] || null),
        incidentRepo.getOpenIncidents(channelAccountId),
        settingsRepo.getSettings(channelAccountId),
      ]);

      let activeStage = "IDLE";
      let waitingReason = "Đang sẵn sàng chờ tin nhắn mới từ khách hàng";
      let activeConversationId: string | null = null;
      let activeConversationTitle: string | null = null;

      if (channel?.isSuspended || channel?.status === "SUSPENDED") {
        activeStage = "ERROR";
        waitingReason = `Kênh tạm dừng do sự cố: ${channel.statusReason || "Cần kiểm tra đối soát"}`;
      } else if (channel?.isPaused || channel?.status === "PAUSED") {
        activeStage = "PAUSED";
        waitingReason = "Kênh đang tạm dừng thủ công bởi chủ sở hữu";
      } else if (openIncidents.length > 0) {
        activeStage = "ERROR";
        waitingReason = `Có ${openIncidents.length} sự cố chưa giải quyết (${openIncidents[0]!.title})`;
      } else if (recentAction && (recentAction.status === "TYPING" || recentAction.status === "SEND_INTENT")) {
        if (recentAction.status === "TYPING") {
          activeStage = "TYPING";
          activeConversationId = recentAction.conversationId;
          waitingReason = `Đang gõ phím ảo mô phỏng người thật (${(recentAction.text || "").slice(0, 35)}...)`;
        } else {
          activeStage = "VERIFYING_SEND";
          activeConversationId = recentAction.conversationId;
          waitingReason = "Đã ấn phím Enter, đang quét DOM xác nhận bong bóng tin nhắn (tối đa 15s)";
        }
      } else if (recentTurn && recentTurn.status === "THINKING") {
        activeStage = "AI_THINKING";
        activeConversationId = recentTurn.conversationId;
        waitingReason = "Mô hình AI đang xử lý ngữ cảnh và tạo câu trả lời";
      } else if (queueItems.length > 0) {
        activeStage = "DEBOUNCE";
        activeConversationId = queueItems[0]!.conversationId;
        waitingReason = `Đang gom cụm tin nhắn (${queueItems.length} hội thoại trong hàng đợi)`;
      }

      if (activeConversationId) {
        const conv = await db
          .select({
            convId: conversations.id,
            threadId: conversations.externalThreadId,
            customerName: customers.name,
          })
          .from(conversations)
          .leftJoin(customers, eq(conversations.customerId, customers.id))
          .where(eq(conversations.id, activeConversationId))
          .then((r) => r[0]);
        if (conv) {
          activeConversationTitle = conv.customerName || `Khách #${(conv.threadId || "").slice(-4)}`;
        }
      }

      const nodes = [
        {
          id: "inbound",
          step: 1,
          name: "1. Tiếp nhận tin nhắn",
          subtitle: "DOM Observer & Deduplication",
          category: "intake",
          status: recentInbound && (now.getTime() - new Date(recentInbound.receivedAt).getTime()) < 60000 ? "active" : "idle",
          activity: recentInbound?.text ? `Tin mới: "${recentInbound.text.slice(0, 45)}..."` : "Sẵn sàng nhận tin",
          metrics: [
            { label: "Trạng thái", value: "Đang lắng nghe" },
            { label: "Tin gần nhất", value: recentInbound?.receivedAt ? new Date(recentInbound.receivedAt).toLocaleTimeString("vi-VN") : "—" },
          ],
          details: {
            mid: recentInbound?.id || "—",
            fullText: recentInbound?.text || "—",
            dedupeMethod: "CRC32 + Stable MID",
          },
        },
        {
          id: "debounce",
          step: 2,
          name: "2. Gom cụm & Hàng đợi",
          subtitle: "Debounce Window & Batching",
          category: "queue",
          status: activeStage === "DEBOUNCE" ? "waiting" : queueItems.length > 0 ? "active" : "idle",
          activity: queueItems.length > 0 ? `${queueItems.length} tin đang chờ xử lý` : "Hàng đợi trống",
          metrics: [
            { label: "Đang chờ", value: `${queueItems.length} hội thoại` },
            { label: "Cửa sổ gom", value: `${settingsData.settings.debounceMs || 3000}ms` },
          ],
          details: {
            queueLength: queueItems.length,
            debounceMs: settingsData.settings.debounceMs || 3000,
            stickyWindowMs: settingsData.settings.stickyWindowMs || 45000,
          },
        },
        {
          id: "policy",
          step: 3,
          name: "3. Kiểm duyệt chính sách",
          subtitle: "Reply Gating & Business Hours",
          category: "safety",
          status: activeStage === "AI_THINKING" || activeStage === "DEBOUNCE" ? "active" : "idle",
          activity: `Chế độ: ${settingsData.settings.replyMode}`,
          metrics: [
            { label: "Chế độ", value: settingsData.settings.replyMode === "EVERYONE_EXCEPT" ? "Mọi người trừ ds chặn" : "Chỉ danh sách chọn" },
            { label: "Tự động rep", value: settingsData.settings.autoReplyEnabled ? "BẬT" : "TẮT" },
          ],
          details: {
            directReplies: settingsData.settings.directRepliesEnabled,
            groupReplies: settingsData.settings.groupRepliesEnabled,
            timezone: settingsData.settings.businessTimeZone,
          },
        },
        {
          id: "context",
          step: 4,
          name: "4. Xây dựng ngữ cảnh",
          subtitle: "Token Budget & History Trimmer",
          category: "ai",
          status: activeStage === "AI_THINKING" ? "active" : "idle",
          activity: "Nạp 24h hội thoại + Persona Sin Sin Shop",
          metrics: [
            { label: "Token trần", value: `${settingsData.settings.contextMaxInputTokens || 4096} tokens` },
            { label: "Tin tối đa", value: `${settingsData.settings.contextMaxMessages || 12} tin` },
          ],
          details: {
            personaLen: (settingsData.settings.aiSystemPersona || "").length,
            businessProfileLen: (settingsData.settings.businessProfile || "").length,
            historyHours: settingsData.settings.contextHistoryMaxAgeHours || 24,
          },
        },
        {
          id: "llm",
          step: 5,
          name: "5. Trí tuệ nhân tạo (LLM)",
          subtitle: `${settingsData.settings.aiModel}`,
          category: "ai",
          status: activeStage === "AI_THINKING" ? "active" : recentAiRun ? "completed" : "idle",
          activity: activeStage === "AI_THINKING" ? "Đang suy nghĩ câu trả lời..." : `Lần gần nhất: ${recentAiRun?.latencyMs || 0}ms`,
          metrics: [
            { label: "Model", value: recentAiRun?.model || settingsData.settings.aiModel },
            { label: "Thời gian", value: `${recentAiRun?.latencyMs || 0}ms` },
            { label: "Tokens", value: `${(recentAiRun?.promptTokens || 0) + (recentAiRun?.completionTokens || 0)}` },
          ],
          details: {
            model: recentAiRun?.model || settingsData.settings.aiModel,
            promptTokens: recentAiRun?.promptTokens || 0,
            completionTokens: recentAiRun?.completionTokens || 0,
            lastStatus: recentAiRun?.status || "SUCCESS",
            rawOutputExcerpt: recentAiRun?.responseSnapshot ? JSON.stringify(recentAiRun.responseSnapshot).slice(0, 120) : "—",
          },
        },
        {
          id: "guards",
          step: 6,
          name: "6. Bộ lọc & Định dạng",
          subtitle: "Leak Guard, Single List & Question Split",
          category: "safety",
          status: activeStage === "TYPING" ? "completed" : "idle",
          activity: "Gộp danh sách vào Tin 1 & Tách câu hỏi vào Tin 2",
          metrics: [
            { label: "Chống lộ prompt", value: "BẢO VỆ" },
            { label: "Tách tin thông minh", value: "KÍCH HOẠT" },
          ],
          details: {
            maxResponseCount: settingsData.settings.aiMaxResponseCount || 3,
            totalMaxChars: settingsData.settings.aiTotalMaxChars || 1000,
            splitPolicy: "Danh sách sản phẩm gom thành 1 tin, câu hỏi chốt tách tin 2",
          },
        },
        {
          id: "typing",
          step: 7,
          name: "7. Mô phỏng gõ phím ảo",
          subtitle: "Human WPM Pacing & Multi-byte Emoji",
          category: "sender",
          status: activeStage === "TYPING" ? "active" : "idle",
          activity: activeStage === "TYPING" ? `Đang gõ: "${recentAction?.text?.slice(0, 35)}..."` : "Sẵn sàng",
          metrics: [
            { label: "Tốc độ WPM", value: `${settingsData.settings.typingTargetWpmMin || 55}-${settingsData.settings.typingTargetWpmMax || 65}` },
            { label: "Giới hạn trễ", value: "2500ms cap" },
          ],
          details: {
            activeTypingText: recentAction?.status === "TYPING" ? recentAction.text : "—",
            singleTabExclusion: true,
            emojiHandling: "Intl.Segmenter + keyboard.insertText",
          },
        },
        {
          id: "delivery",
          step: 8,
          name: "8. Gửi & Xác nhận đối soát",
          subtitle: "Enter Key & Post-Enter DOM Check",
          category: "delivery",
          status: activeStage === "VERIFYING_SEND" ? "active" : openIncidents.length > 0 ? "error" : "idle",
          activity: activeStage === "VERIFYING_SEND" ? "Đang chờ xác nhận từ Messenger..." : openIncidents.length > 0 ? "Cần đối soát sự cố" : "Gửi thành công",
          metrics: [
            { label: "Trạng thái", value: openIncidents.length > 0 ? "CÓ SỰ CỐ" : recentAction?.status || "CONFIRMED" },
            { label: "Hạn chờ", value: "15000ms" },
          ],
          details: {
            lastActionStatus: recentAction?.status || "CONFIRMED",
            confirmedAt: recentAction?.confirmedAt ? new Date(recentAction.confirmedAt).toLocaleTimeString("vi-VN") : "—",
            failClosedProtection: "No blind retry to prevent duplicate messages",
          },
        },
      ];

      return reply.send(
        sanitizeApiOutput({
          channel: {
            status: channel?.status || "RUNNING",
            isSuspended: channel?.isSuspended || false,
            isPaused: channel?.isPaused || false,
            statusReason: channel?.statusReason || null,
          },
          activeStage,
          waitingReason,
          activeConversation: activeConversationId
            ? {
                id: activeConversationId,
                title: activeConversationTitle || "Khách hàng",
              }
            : null,
          openIncidents: openIncidents.map((i) => ({
            id: i.id,
            title: i.title,
            type: i.type,
          })),
          nodes,
          latestTrace: {
            inboundText: recentInbound?.text || null,
            inboundTime: recentInbound?.receivedAt || null,
            aiModel: recentAiRun?.model || settingsData.settings.aiModel,
            aiLatencyMs: recentAiRun?.latencyMs || null,
            outboundText: recentAction?.text || null,
            outboundStatus: recentAction?.status || null,
            confirmedAt: recentAction?.confirmedAt || null,
          },
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

      // Optional Facebook discovery candidates if query provided and jobRepo is available
      if (q && q.length >= 1 && jobRepo) {
        try {
          const job = await jobRepo.enqueue({
            channelAccountId,
            queue: "browser",
            jobType: "DISCOVERY_SEARCH",
            payload: { query: q },
            priority: 10,
            maxAttempts: 1,
          });

          // Search includes navigation and Messenger's suggestion debounce.
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            const fresh = await jobRepo.getJobById(job.id);
            if (fresh?.status === "SUCCEEDED") {
              const resPayload = fresh.payload as {
                candidates?: Array<{ id: string; name: string; avatarUrl?: string; kind: "PERSON" | "GROUP" }>;
              };
              if (Array.isArray(resPayload?.candidates)) {
                const localPIds = new Set(filtered.map((p) => p.participantId));
                for (const fb of resPayload.candidates) {
                  if (!localPIds.has(fb.id)) {
                    const safeId = toSafePersonId(channelAccountId, fb.id);
                    if (fb.kind === "PERSON") {
                      discoveryCandidates.set(safeId, {
                        participantId: fb.id,
                        name: fb.name,
                        avatarUrl: fb.avatarUrl,
                        expiresAt: Date.now() + 5 * 60 * 1000,
                      });
                    }
                    result.push({
                      id: safeId,
                      name: fb.name,
                      rawName: fb.name,
                      avatarUrl: fb.avatarUrl || null,
                      type: fb.kind,
                      isVerified: false,
                      conversationContext: fb.kind === "GROUP" ? "Gợi ý nhóm từ Facebook" : "Gợi ý từ Facebook",
                      duplicateContext: undefined,
                      policyMode: policyMap.get(fb.id) || null,
                    });
                  }
                }
              }
              break;
            } else if (fresh?.status === "FAILED") {
              break;
            }
          }
        } catch (err) {
          console.warn("[Admin API] Facebook discovery search error or timeout:", err);
        }
      }

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
      let participant = await participantRepo.getParticipant(channelAccountId, participantId);
      if (!participant) {
        const candidate = discoveryCandidates.get(personId);
        if (!candidate || candidate.expiresAt < Date.now() || candidate.participantId !== participantId) {
          return reply.status(400).send({ error: "Facebook search result has expired. Search again before adding this person." });
        }
        discoveryCandidates.delete(personId);
        participant = await participantRepo.upsertParticipant({
          channelAccountId,
          participantId,
          senderKind: "PERSON",
          reliability: "VERIFIED",
          isVerified: true,
          displayName: candidate.name,
          avatarUrl: candidate.avatarUrl ?? null,
          metadata: { source: "FACEBOOK_DISCOVERY" },
        });
      }
      if (!participant.isVerified || participant.senderKind !== "PERSON") {
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

        const convIds = Array.from(new Set(items.map((r) => r.conversationId).filter(Boolean)));
        const convMetaMap = new Map<string, { title?: string | null; customerName?: string | null; customerAvatarUrl?: string | null }>();

        if (convIds.length > 0) {
          try {
            const convRows = await db
              .select({
                id: conversations.id,
                title: conversations.title,
                customerName: customers.name,
                customerAvatarUrl: customers.avatarUrl,
              })
              .from(conversations)
              .leftJoin(customers, eq(conversations.customerId, customers.id))
              .where(inArray(conversations.id, convIds));
            for (const c of convRows) {
              convMetaMap.set(c.id, {
                title: c.title,
                customerName: c.customerName,
                customerAvatarUrl: c.customerAvatarUrl,
              });
            }
          } catch {
            // Fallback gracefully if mock db in unit tests does not support join
          }
        }

        const sanitizedItems = items.map((item) => {
          const meta = convMetaMap.get(item.conversationId);
          return {
            ...item,
            conversationTitle: meta?.title || null,
            customerName: meta?.customerName || meta?.title || "Khách hàng Messenger",
            customerAvatarUrl: meta?.customerAvatarUrl || null,
            requestSnapshot: item.requestSnapshot ? stripSensitiveData(item.requestSnapshot) : null,
            responseSnapshot: item.responseSnapshot ? stripSensitiveData(item.responseSnapshot) : null,
            usedResult: item.usedResult ? sanitizeCustomerOutput(item.usedResult) : null,
          };
        });

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

        // 1. If incident was attached to a specific conversation, restore it out of manual mode
        if (resolved.conversationId) {
          await db
            .update(conversations)
            .set({
              manualMode: false,
              status: "WAITING_CUSTOMER",
              updatedAt: new Date(),
            })
            .where(eq(conversations.id, resolved.conversationId));

          await broadcaster.broadcast("conversation:status", {
            conversationId: resolved.conversationId,
            manualMode: false,
            status: "WAITING_CUSTOMER",
          });
        }

        // 2. Auto un-suspend channel account if no other open incidents remain
        const targetChannelId = resolved.channelAccountId || channelAccountId;
        const openIncidents = await incidentRepo.getOpenIncidents(targetChannelId);
        const hasRemainingOpen = openIncidents.some((i) => i.status === "OPEN" && i.id !== incidentId);

        if (!hasRemainingOpen) {
          await db
            .update(channelAccounts)
            .set({
              isSuspended: false,
              status: "RUNNING",
              statusReason: null,
              updatedAt: new Date(),
            })
            .where(eq(channelAccounts.id, targetChannelId));

          await broadcaster.broadcast("channel:status", {
            status: "RUNNING",
            isPaused: false,
            isSuspended: false,
          });
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
          if (item.conversationId) {
            await db
              .update(conversations)
              .set({
                manualMode: false,
                status: "WAITING_CUSTOMER",
                updatedAt: new Date(),
              })
              .where(eq(conversations.id, item.conversationId));

            await broadcaster.broadcast("conversation:status", {
              conversationId: item.conversationId,
              manualMode: false,
              status: "WAITING_CUSTOMER",
            });
          }
        }

        // Auto un-suspend channel after resolving all incidents
        await db
          .update(channelAccounts)
          .set({
            isSuspended: false,
            status: "RUNNING",
            statusReason: null,
            updatedAt: new Date(),
          })
          .where(eq(channelAccounts.id, channelAccountId));

        await broadcaster.broadcast("channel:status", {
          status: "RUNNING",
          isPaused: false,
          isSuspended: false,
        });

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
