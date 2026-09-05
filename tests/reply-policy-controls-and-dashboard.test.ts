import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { createAdminRoutes } from "../apps/core/src/routes/admin.js";
import {
  toSafePersonId,
  parseSafePersonId,
  resolveParticipantId,
  sanitizeApiOutput,
  ReplyPolicyService,
  type Database,
  type QueueRepository,
  type SettingsRepository,
  type AiConfigRepository,
  type IncidentRepository,
  type EventRepository,
  type JobRepository,
  type ParticipantRepository,
  type PolicyMemberRepository,
} from "../packages/db/src/index.js";
import {
  evaluateReplyEligibility,
  getHumanReadableReason,
  SystemSettingsSchema,
} from "../packages/contracts/src/index.js";

describe("Reply Policy Controls, Safe IDs & Data Sanitization", () => {
  const channelAccountId = "personal-messenger";

  // --------------------------------------------------------------------------
  // 1. Safe Person IDs & Channel Binding
  // --------------------------------------------------------------------------
  describe("Safe Person ID Cryptographic Tokens", () => {
    it("generates opaque ppl_ token bound to channelAccountId", () => {
      const participantId = "facebook-user-123456789";
      const token = toSafePersonId(channelAccountId, participantId);
      expect(token).toMatch(/^ppl_[A-Za-z0-9_-]+$/);

      // Successfully decodes with matching channelAccountId
      const parsed = parseSafePersonId(token, channelAccountId);
      expect(parsed).not.toBeNull();
      expect(parsed?.channelAccountId).toBe(channelAccountId);
      expect(parsed?.participantId).toBe(participantId);

      // Fails when attempted across different channelAccountId (tampering guard)
      const tampered = parseSafePersonId(token, "different-channel");
      expect(tampered).toBeNull();
    });

    it("resolveParticipantId correctly resolves safe tokens", () => {
      const participantId = "user-abc-999";
      const token = toSafePersonId(channelAccountId, participantId);
      const resolved = resolveParticipantId(token, channelAccountId);
      expect(resolved).toBe(participantId);

      // Resolves raw ID fallback in test env
      expect(resolveParticipantId("raw-id-123", channelAccountId)).toBe("raw-id-123");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Data Sanitization for Normal APIs
  // --------------------------------------------------------------------------
  describe("sanitizeApiOutput data masking", () => {
    it("strips Facebook external IDs and raw internal participant/thread IDs recursively", () => {
      const rawApiPayload = {
        conversation: {
          id: "conv-uuid-1",
          status: "WAITING",
          externalThreadId: "t_1002938481828",
          externalThreadRef: "https://www.facebook.com/messages/t/1002938481828",
          inboundVersion: 2,
        },
        customer: {
          id: "cust-uuid-2",
          externalCustomerId: "cust_998877",
          name: "Nguyễn Văn A",
        },
        messages: [
          {
            id: "msg-uuid-3",
            text: "Chào shop",
            senderExternalId: "sender_fb_123",
            senderParticipantId: "part_uuid_4",
            participantId: "part_uuid_4",
            senderName: "Nguyễn Văn A",
          },
        ],
        payload: {
          externalThreadId: "t_1002938481828",
          nested: {
            facebookId: "fb_sensitive_555",
            safeField: "ok",
          },
        },
      };

      const sanitized = sanitizeApiOutput(rawApiPayload);

      // Conversation external IDs stripped
      expect((sanitized.conversation as Record<string, unknown>).externalThreadId).toBeUndefined();
      expect((sanitized.conversation as Record<string, unknown>).externalThreadRef).toBeUndefined();
      expect(sanitized.conversation.id).toBe("conv-uuid-1");
      expect(sanitized.conversation.status).toBe("WAITING");

      // Customer external ID stripped
      expect((sanitized.customer as Record<string, unknown>).externalCustomerId).toBeUndefined();
      expect(sanitized.customer.name).toBe("Nguyễn Văn A");

      // Messages sensitive sender IDs stripped
      const msg = sanitized.messages[0] as Record<string, unknown>;
      expect(msg.senderExternalId).toBeUndefined();
      expect(msg.senderParticipantId).toBeUndefined();
      expect(msg.participantId).toBeUndefined();
      expect(msg.text).toBe("Chào shop");
      expect(msg.senderName).toBe("Nguyễn Văn A");

      // Nested object stripped
      expect((sanitized.payload as Record<string, unknown>).externalThreadId).toBeUndefined();
      expect(((sanitized.payload as Record<string, unknown>).nested as Record<string, unknown>).facebookId).toBeUndefined();
      expect(((sanitized.payload as Record<string, unknown>).nested as Record<string, unknown>).safeField).toBe("ok");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Human-readable Reason Translations
  // --------------------------------------------------------------------------
  describe("getHumanReadableReason Vietnamese explanations", () => {
    it("returns accurate Vietnamese explanations for policy skip reasons", () => {
      expect(getHumanReadableReason("AUTO_REPLY_DISABLED")).toContain("tắt tự động phản hồi");
      expect(getHumanReadableReason("UNKNOWN_THREAD_KIND")).toContain("Loại hội thoại không xác định");
      expect(getHumanReadableReason("UNVERIFIED_SENDER_CLASSIFICATION")).toContain("Danh tính người gửi chưa được xác minh");
      expect(getHumanReadableReason("PERSON_EXCLUDED")).toContain("danh sách loại trừ");
      expect(getHumanReadableReason("PERSON_NOT_SELECTED")).toContain("danh sách được chỉ định");
      expect(getHumanReadableReason("GROUP_MENTION_REQUIRED")).toContain("gắn thẻ");
      expect(getHumanReadableReason("STALE_INBOUND_VERSION")).toContain("Phiên bản tin nhắn đã cũ");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Settings API with Optimistic Concurrency & Safe IDs
  // --------------------------------------------------------------------------
  describe("Settings API & Policy Controls", () => {
    it("manages replyMode and source switches with optimistic concurrency", async () => {
      let currentRevision = 1;
      let currentSettings = {
        debounceMs: 3000,
        stickyWindowMs: 45000,
        stickyMaxTurns: 3,
        stickyMaxDurationMs: 120000,
        aiModel: "auto/best-chat",
        aiTimeoutMs: 20000,
        aiMaxResponseCount: 3,
        aiTotalMaxChars: 480,
        aiSystemPersona: "Test persona",
        businessProfile: "Test profile",
        typingTargetWpmMin: 55,
        typingTargetWpmMax: 65,
        busyMode: false,
        autoReplyEnabled: true,
        pauseIntakeProcessing: false,
        businessTimeZone: "Asia/Ho_Chi_Minh",
        replyMode: "EVERYONE_EXCEPT" as const,
        directRepliesEnabled: true,
        groupRepliesEnabled: false,
        pageRepliesEnabled: false,
        nonPersonRepliesEnabled: false,
        requireGroupMention: true,
        selectedParticipantIds: [] as string[],
        excludedParticipantIds: ["p-exclude-1"],
      };

      const mockSettingsRepo = {
        getSettings: vi.fn(async () => ({
          settings: currentSettings,
          revision: currentRevision,
        })),
        updateSettings: vi.fn(async (_channelId, newSettings, _actor, _reason) => {
          currentRevision += 1;
          currentSettings = { ...currentSettings, ...newSettings };
          return {
            settings: currentSettings,
            revision: currentRevision,
          };
        }),
      };

      const mockBroadcaster = {
        broadcast: vi.fn(async () => {}),
      };

      const mockEventRepo = {
        recordEvent: vi.fn(async () => {}),
      };

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: {} as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: mockSettingsRepo as unknown as SettingsRepository,
          aiConfigRepo: {
            getPublicConfig: vi.fn(async () => ({ apiFormat: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", model: "auto/best-chat", apiKeyConfigured: true })),
            getConfig: vi.fn(async () => ({ apiFormat: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", model: "auto/best-chat", apiKey: "secret" })),
          } as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: mockEventRepo as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-owner",
            email: "owner@messenger.local",
            role: "OWNER",
          }),
          channelAccountId,
        })
      );

      // GET /api/settings maps excluded participant ID to safe token
      const getRes = await fastify.inject({
        method: "GET",
        url: "/api/settings",
      });
      expect(getRes.statusCode).toBe(200);
      const getData = JSON.parse(getRes.body);
      expect(getData.revision).toBe(1);
      expect(getData.settings.replyMode).toBe("EVERYONE_EXCEPT");
      expect(getData.settings.excludedParticipantIds[0]).toMatch(/^ppl_/);

      // Optimistic concurrency conflict: sending stale revision returns 409
      const staleRes = await fastify.inject({
        method: "POST",
        url: "/api/settings",
        payload: {
          replyMode: "ONLY_SELECTED",
          expectedRevision: 999, // Stale!
        },
      });
      expect(staleRes.statusCode).toBe(409);

      // Successful update with matching expectedRevision
      const updateRes = await fastify.inject({
        method: "POST",
        url: "/api/settings",
        payload: {
          replyMode: "ONLY_SELECTED",
          groupRepliesEnabled: true,
          requireGroupMention: true,
          expectedRevision: 1,
        },
      });
      expect(updateRes.statusCode).toBe(200);
      const updateData = JSON.parse(updateRes.body);
      expect(updateData.revision).toBe(2);
      expect(updateData.settings.replyMode).toBe("ONLY_SELECTED");
      expect(updateData.settings.groupRepliesEnabled).toBe(true);
      expect(mockBroadcaster.broadcast).toHaveBeenCalledWith("settings:updated", { revision: 2 });
    });

    it("searchable people endpoint returns safe names, avatars, type, readable context and disambiguates duplicates", async () => {
      const mockParticipants = [
        {
          id: "uuid-p1",
          channelAccountId,
          participantId: "fb-user-1",
          displayName: "Nguyễn Văn A",
          avatarUrl: "https://avatar.example.com/1.jpg",
          senderKind: "PERSON",
          reliability: "VERIFIED",
          isVerified: true,
          updatedAt: new Date("2026-09-01"),
        },
        {
          id: "uuid-p2",
          channelAccountId,
          participantId: "fb-user-2",
          displayName: "Nguyễn Văn A", // Duplicate name!
          avatarUrl: "https://avatar.example.com/2.jpg",
          senderKind: "PERSON",
          reliability: "VERIFIED",
          isVerified: true,
          updatedAt: new Date("2026-09-02"),
        },
        {
          id: "uuid-p3",
          channelAccountId,
          participantId: "fb-page-3",
          displayName: "Shop Thời Trang",
          avatarUrl: null,
          senderKind: "PAGE",
          reliability: "VERIFIED",
          isVerified: true,
          updatedAt: new Date("2026-09-03"),
        },
      ];

      const mockParticipantRepo = {
        searchVerifiedPersons: vi.fn(async (_channelId, _q, _limit) => [
          mockParticipants[0],
          mockParticipants[1],
        ]),
      };

      const mockPolicyMemberRepo = {
        listMembers: vi.fn(async () => []),
        getMember: vi.fn(async () => null),
        addMember: vi.fn(async () => ({})),
        removeMember: vi.fn(async () => true),
      };

      const mockSettingsRepo = {
        getSettings: vi.fn(async () => ({
          settings: {
            ...SystemSettingsSchema.parse({}),
            selectedParticipantIds: [],
            excludedParticipantIds: [],
          },
          revision: 1,
        })),
        updateSettings: vi.fn(async (_ch, newSettings) => ({
          settings: newSettings,
          revision: 2,
        })),
      };

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: {
            select: vi.fn(() => ({
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(async () => []),
                  })),
                })),
                innerJoin: vi.fn(() => ({
                  where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(async () => [
                        {
                          senderParticipantId: "fb-user-1",
                          conversationId: "conv-1",
                          receivedAt: new Date("2026-09-04"),
                          title: "Áo Polo Nam",
                          threadKind: "DIRECT",
                        },
                        {
                          senderParticipantId: "fb-user-2",
                          conversationId: "conv-2",
                          receivedAt: new Date("2026-09-05"),
                          title: "Áo Khoác Gió",
                          threadKind: "DIRECT",
                        },
                      ]),
                    })),
                  })),
                })),
              })),
            })) as unknown as Database["select"],
          } as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: mockSettingsRepo as unknown as SettingsRepository,
          aiConfigRepo: {
            getPublicConfig: vi.fn(async () => ({ apiFormat: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", model: "auto/best-chat", apiKeyConfigured: true })),
            getConfig: vi.fn(async () => ({ apiFormat: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", model: "auto/best-chat", apiKey: "secret" })),
          } as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: { recordEvent: vi.fn(async () => {}) } as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn(async () => {}) } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-owner",
            email: "owner@messenger.local",
            role: "OWNER",
          }),
          channelAccountId,
          participantRepo: mockParticipantRepo as unknown as ParticipantRepository,
          policyMemberRepo: mockPolicyMemberRepo as unknown as PolicyMemberRepository,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/people?q=Nguyen",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.people).toBeDefined();
      expect(data.people.length).toBe(2);

      // Safe IDs used, raw external FB IDs / internal UUIDs hidden
      expect(data.people[0].id).toMatch(/^ppl_/);
      expect(data.people[1].id).toMatch(/^ppl_/);
      expect(data.people[0].participantId).toBeUndefined();
      expect(data.people[0].externalThreadId).toBeUndefined();

      // Duplicate names are distinguished via context
      expect(data.people[0].name).toContain("Áo Polo Nam");
      expect(data.people[1].name).toContain("Áo Khoác Gió");
      expect(data.people[0].conversationContext).toContain("Hội thoại:");
    });

    it("membership CRUD supports adding and deleting members with optimistic revision", async () => {
      let currentRevision = 1;
      let excludedList: string[] = [];

      const mockParticipantRepo = {
        getParticipant: vi.fn(async (_ch, participantId) => {
          if (participantId === "verified-user-1") {
            return {
              id: "uuid-verified-1",
              channelAccountId,
              participantId: "verified-user-1",
              displayName: "Khách Hàng Thân Thiết",
              senderKind: "PERSON",
              reliability: "VERIFIED",
              isVerified: true,
            };
          }
          return null;
        }),
      };

      const mockPolicyMemberRepo = {
        listMembers: vi.fn(async () =>
          excludedList.map((id) => ({
            id: `member-${id}`,
            channelAccountId,
            participantId: id,
            policyMode: "EXCLUDE",
            notes: "Test note",
            addedBy: "owner@messenger.local",
            createdAt: new Date(),
          }))
        ),
        getMember: vi.fn(async (_ch, id) =>
          excludedList.includes(id)
            ? {
                id: `member-${id}`,
                channelAccountId,
                participantId: id,
                policyMode: "EXCLUDE",
              }
            : null
        ),
        addMember: vi.fn(async (_ch, id) => {
          if (!excludedList.includes(id)) excludedList.push(id);
          return { id: `member-${id}`, participantId: id };
        }),
        removeMember: vi.fn(async (_ch, id) => {
          excludedList = excludedList.filter((item) => item !== id);
          return true;
        }),
      };

      const mockSettingsRepo = {
        getSettings: vi.fn(async () => ({
          settings: {
            ...SystemSettingsSchema.parse({}),
            selectedParticipantIds: [],
            excludedParticipantIds: [...excludedList],
          },
          revision: currentRevision,
        })),
        updateSettings: vi.fn(async (_ch, newSettings) => {
          currentRevision += 1;
          return {
            settings: newSettings,
            revision: currentRevision,
          };
        }),
      };

      const mockEventRepo = { recordEvent: vi.fn(async () => {}) };
      const mockBroadcaster = { broadcast: vi.fn(async () => {}) };

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: {} as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: mockSettingsRepo as unknown as SettingsRepository,
          aiConfigRepo: {
            getPublicConfig: vi.fn(async () => ({ apiFormat: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", model: "auto/best-chat", apiKeyConfigured: true })),
            getConfig: vi.fn(async () => ({ apiFormat: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", model: "auto/best-chat", apiKey: "secret" })),
          } as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: mockEventRepo as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-owner",
            email: "owner@messenger.local",
            role: "OWNER",
          }),
          channelAccountId,
          participantRepo: mockParticipantRepo as unknown as ParticipantRepository,
          policyMemberRepo: mockPolicyMemberRepo as unknown as PolicyMemberRepository,
        })
      );

      const safePersonToken = toSafePersonId(channelAccountId, "verified-user-1");

      // 1. Optimistic revision conflict on add
      const conflictRes = await fastify.inject({
        method: "POST",
        url: "/api/settings/members",
        payload: {
          personId: safePersonToken,
          policyMode: "EXCLUDE",
          expectedRevision: 999, // Stale!
        },
      });
      expect(conflictRes.statusCode).toBe(409);

      // 2. Successful add member with valid expectedRevision
      const addRes = await fastify.inject({
        method: "POST",
        url: "/api/settings/members",
        payload: {
          personId: safePersonToken,
          policyMode: "EXCLUDE",
          expectedRevision: 1,
        },
      });
      expect(addRes.statusCode).toBe(200);
      const addData = JSON.parse(addRes.body);
      expect(addData.success).toBe(true);
      expect(addData.revision).toBe(2);
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SETTING_CHANGED",
        })
      );

      // 3. Delete member with optimistic revision
      const deleteRes = await fastify.inject({
        method: "DELETE",
        url: `/api/settings/members/${safePersonToken}?expectedRevision=2`,
      });
      expect(deleteRes.statusCode).toBe(200);
      const deleteData = JSON.parse(deleteRes.body);
      expect(deleteData.success).toBe(true);
      expect(deleteData.revision).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Ingestion Defects & ReplyPolicyService Recheck
  // --------------------------------------------------------------------------
  describe("ReplyPolicyService Ingestion & Recheck Defects", () => {
    it("recheckEligibility missing/unreadable inbound fails closed with UNVERIFIED_SENDER_CLASSIFICATION", async () => {
      const service = new ReplyPolicyService({} as Database);

      const result = await service.recheckEligibility({
        channelAccountId,
        conversationId: "conv-1",
        inboundVersion: 2,
        conversation: {
          id: "conv-1",
          inboundVersion: 2,
          isBlocked: false,
          manualMode: false,
          threadKind: "DIRECT",
          externalThreadId: "t-1",
        },
        evaluationMode: "LIVE",
      });

      expect(result.eligible).toBe(false);
      expect(result.decision).toBe("INELIGIBLE");
      expect(result.reasonCode).toBe("UNVERIFIED_SENDER_CLASSIFICATION");
      expect(result.evaluationMode).toBe("LIVE");
    });

    it("recheckEligibility inbound version mismatch returns STALE_INBOUND_VERSION", async () => {
      const service = new ReplyPolicyService({} as Database);

      const result = await service.recheckEligibility({
        channelAccountId,
        conversationId: "conv-1",
        inboundVersion: 2, // Stale!
        conversation: {
          id: "conv-1",
          inboundVersion: 3, // Conversation is now at v3
          isBlocked: false,
          manualMode: false,
          threadKind: "DIRECT",
          externalThreadId: "t-1",
        },
      });

      expect(result.eligible).toBe(false);
      expect(result.decision).toBe("INELIGIBLE");
      expect(result.reasonCode).toBe("STALE_INBOUND_VERSION");
    });

    it("evaluates strict LIVE policy: unknown/unverified fails closed, direct verified succeeds", () => {
      // 1. Unknown thread kind fails closed
      const unknownResult = evaluateReplyEligibility({
        channel: { id: channelAccountId, accountType: "PERSONAL_MESSENGER", status: "RUNNING", isSuspended: false, isPaused: false },
        thread: { id: "conv-1", externalThreadId: "t-1", isBlocked: false, manualMode: false, kind: "UNKNOWN", reliability: "UNVERIFIED" },
        sender: { id: "sender-1", kind: "UNKNOWN", reliability: "UNVERIFIED" },
        message: { id: "msg-1", direction: "INBOUND", actor: "SYSTEM", text: "Xin chào" },
        settings: SystemSettingsSchema.parse({}),
      });
      expect(unknownResult.eligible).toBe(false);
      expect(unknownResult.reasonCode).toBe("UNKNOWN_THREAD_KIND");

      // 2. Thread ID cannot be used as participant identity (impersonation guard)
      const impersonationResult = evaluateReplyEligibility({
        channel: { id: channelAccountId, accountType: "PERSONAL_MESSENGER", status: "RUNNING", isSuspended: false, isPaused: false },
        thread: { id: "conv-1", externalThreadId: "shared-thread-id", isBlocked: false, manualMode: false, kind: "DIRECT", reliability: "VERIFIED" },
        sender: {
          id: "shared-thread-id", // Same as externalThreadId!
          kind: "PERSON",
          reliability: "VERIFIED",
          participantIdentity: {
            channelAccountId,
            participantId: "shared-thread-id",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        message: { id: "msg-1", direction: "INBOUND", actor: "SYSTEM", text: "Xin chào" },
        settings: SystemSettingsSchema.parse({}),
      });
      expect(impersonationResult.eligible).toBe(false);
      expect(impersonationResult.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");

      // 3. Direct verified person under default EVERYONE_EXCEPT is eligible
      const verifiedResult = evaluateReplyEligibility({
        channel: { id: channelAccountId, accountType: "PERSONAL_MESSENGER", status: "RUNNING", isSuspended: false, isPaused: false },
        thread: { id: "conv-1", externalThreadId: "t-1", isBlocked: false, manualMode: false, kind: "DIRECT", reliability: "VERIFIED" },
        sender: {
          id: "valid-person-1",
          kind: "PERSON",
          reliability: "VERIFIED",
          participantIdentity: {
            channelAccountId,
            participantId: "valid-person-1",
            displayName: "Lê Văn B",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        message: { id: "msg-1", direction: "INBOUND", actor: "SYSTEM", text: "Shop tư vấn giúp mình" },
        settings: SystemSettingsSchema.parse({}),
      });
      expect(verifiedResult.eligible).toBe(true);
      expect(verifiedResult.decision).toBe("ELIGIBLE");
      expect(verifiedResult.reasonCode).toBe("ELIGIBLE");
    });
  });
});
