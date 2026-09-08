import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import { and } from "drizzle-orm";
import { createInboxRoutes } from "../apps/core/src/routes/inbox.js";
import { createAdminRoutes } from "../apps/core/src/routes/admin.js";
import {
  getPolicyAudienceConditions,
  extractParticipantIds,
} from "../apps/core/src/routes/policy-audience.js";
import {
  toSafePersonId,
  type Database,
  type ConversationRepository,
  type QueueRepository,
  type OutboundRepository,
  type EventRepository,
  type OutboxRepository,
  type SettingsRepository,
  type AiConfigRepository,
  type IncidentRepository,
  type JobRepository,
  type OutboxBroadcaster,
} from "../packages/db/src/index.js";
import type { SystemSettings } from "../packages/contracts/src/index.js";

describe("Policy Audience Filtering (Inbox + Overview)", () => {
  const channelAccountId = "personal-messenger";
  const dialect = new PgDialect();

  const createMockDb = (options: {
    policyMembers?: { participantId: string }[];
    conversations?: unknown[];
    totalCount?: number;
    todayConvCount?: number;
    todayMsgCount?: number;
  } = {}) => {
    const {
      policyMembers = [],
      conversations = [],
      totalCount = conversations.length,
      todayConvCount = 0,
      todayMsgCount = 0,
    } = options;

    const createChain = (data: unknown[]) => {
      const chain: Record<string, unknown> = {};
      chain.where = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.offset = vi.fn(() => chain);
      chain.then = (resolve: (v: unknown) => unknown) => resolve(data);
      return chain;
    };

    const mockDb = {
      select: vi.fn((selector?: unknown) => {
        return {
          from: vi.fn((table: unknown) => {
            const tableName =
              table && typeof table === "object" && Symbol.for("drizzle:Name") in table
                ? (table as { [k: symbol]: string })[Symbol.for("drizzle:Name")]
                : "";

            if (tableName === "reply_policy_members") {
              return createChain(policyMembers);
            }
            if (tableName === "conversations") {
              if (selector && typeof selector === "object" && "count" in selector) {
                return createChain([{ count: todayConvCount || totalCount }]);
              }
              return createChain(conversations);
            }
            if (tableName === "messages") {
              if (selector && typeof selector === "object" && "count" in selector) {
                return createChain([{ count: todayMsgCount }]);
              }
              return createChain([]);
            }
            if (tableName === "channel_accounts") {
              return createChain([
                {
                  id: channelAccountId,
                  status: "RUNNING",
                  isPaused: false,
                  isSuspended: false,
                  metadata: {},
                },
              ]);
            }
            return createChain([]);
          }),
        };
      }),
      selectDistinctOn: vi.fn(() => ({
        from: vi.fn(() => createChain([])),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Database;

    return mockDb;
  };

  const createMockSettingsRepo = (settings: Partial<SystemSettings> | null, throws = false) => {
    if (throws) {
      return {
        getSettings: vi.fn(async () => {
          throw new Error("DB connection failure in settings");
        }),
      } as unknown as SettingsRepository;
    }
    const defaultSettings: SystemSettings = {
      businessTimeZone: "Asia/Ho_Chi_Minh",
      autoReplyEnabled: true,
      pauseIntakeProcessing: false,
      replyMode: "ONLY_SELECTED",
      selectedParticipantIds: [],
      excludedParticipantIds: [],
      directRepliesEnabled: true,
      groupRepliesEnabled: false,
      pageRepliesEnabled: false,
      nonPersonRepliesEnabled: false,
      requireGroupMention: false,
      debounceWindowSeconds: 5,
      defaultLanguage: "vi",
      ...settings,
    };
    return {
      getSettings: vi.fn(async () => ({
        channelAccountId,
        settings: defaultSettings,
        revision: 1,
        updatedBy: "owner@messenger.local",
        updatedAt: new Date(),
      })),
    } as unknown as SettingsRepository;
  };

  // --------------------------------------------------------------------------
  // 1. SQL Dialect AST & Root Cause Tests: Sin Sin group leak prevention
  // --------------------------------------------------------------------------
  describe("Root cause AST & SQL validation", () => {
    it("extractParticipantIds resolves raw, scoped, and ppl_ safe tokens", () => {
      const sinSinRaw = "fb-user-sinsin-123";
      const sinSinSafeToken = toSafePersonId(channelAccountId, sinSinRaw);

      const ids = extractParticipantIds(
        [sinSinRaw, `${channelAccountId}:scoped-user`, sinSinSafeToken],
        channelAccountId
      );

      expect(ids).toContain(sinSinRaw);
      expect(ids).toContain(`${channelAccountId}:${sinSinRaw}`);
      expect(ids).toContain("scoped-user");
      expect(ids).toContain(`${channelAccountId}:scoped-user`);
    });

    it("ONLY_SELECTED: never matches conversations.externalThreadId as a person and requires allowed threadKind", async () => {
      const sinSinId = "fb-user-sinsin-123";
      const mockDb = createMockDb({
        policyMembers: [{ participantId: sinSinId }],
      });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: [sinSinId],
        groupRepliesEnabled: false, // Groups disabled
      });

      const { isPolicyEmpty, conditions } = await getPolicyAudienceConditions(
        mockDb,
        settingsRepo,
        channelAccountId
      );

      expect(isPolicyEmpty).toBe(false);
      const compiled = dialect.sqlToQuery(and(...conditions)!);

      // NEVER check externalThreadId as person!
      expect(compiled.sql).not.toContain('"conversations"."external_thread_id"');

      // Restricts threadKind strictly to DIRECT (no group, no unknown fallback)
      expect(compiled.sql).toContain('"conversations"."thread_kind" in');
      expect(compiled.params).toContain("DIRECT");
      expect(compiled.params).not.toContain("GROUP");

      // Checks customer identity for direct AND verified sender in inbound_messages
      expect(compiled.sql).toContain('"customers"."external_customer_id" in');
      expect(compiled.sql).toContain('"inbound_messages"."sender_participant_id" in');
    });

    it("ONLY_SELECTED: allows GROUP threadKind ONLY when groupRepliesEnabled is explicitly true", async () => {
      const sinSinId = "fb-user-sinsin-123";
      const mockDb = createMockDb({
        policyMembers: [{ participantId: sinSinId }],
      });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: [sinSinId],
        groupRepliesEnabled: true, // Groups explicitly enabled
      });

      const { isPolicyEmpty, conditions } = await getPolicyAudienceConditions(
        mockDb,
        settingsRepo,
        channelAccountId
      );

      expect(isPolicyEmpty).toBe(false);
      const compiled = dialect.sqlToQuery(and(...conditions)!);

      // Allowed thread kinds now include GROUP
      expect(compiled.params).toContain("DIRECT");
      expect(compiled.params).toContain("GROUP");

      // Still NEVER matches externalThreadId! Group matches via inboundMessages sender
      expect(compiled.sql).not.toContain('"conversations"."external_thread_id"');
    });

    it("EVERYONE_EXCEPT: excludes via customers/inboundMessages, never uses externalThreadId in exclusion", async () => {
      const spammerId = "fb-spammer-999";
      const mockDb = createMockDb({
        policyMembers: [{ participantId: spammerId }],
      });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "EVERYONE_EXCEPT",
        excludedParticipantIds: [spammerId],
        groupRepliesEnabled: false,
      });

      const { isPolicyEmpty, conditions } = await getPolicyAudienceConditions(
        mockDb,
        settingsRepo,
        channelAccountId
      );

      expect(isPolicyEmpty).toBe(false);
      const compiled = dialect.sqlToQuery(and(...conditions)!);

      // Excludes via customers external ID and inboundMessages sender
      expect(compiled.sql).toContain('"customers"."external_customer_id" not in');
      expect(compiled.sql).toContain('"inbound_messages"."sender_participant_id" in');
      // NEVER does notInArray on externalThreadId!
      expect(compiled.sql).not.toContain('"conversations"."external_thread_id"');
    });

    it("fails closed when ONLY_SELECTED has 0 selected participants", async () => {
      const mockDb = createMockDb({ policyMembers: [] });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: [],
      });

      const { isPolicyEmpty, conditions } = await getPolicyAudienceConditions(
        mockDb,
        settingsRepo,
        channelAccountId
      );

      expect(isPolicyEmpty).toBe(true);
      expect(conditions).toHaveLength(0);
    });

    it("fails closed when both directRepliesEnabled and groupRepliesEnabled are false", async () => {
      const mockDb = createMockDb();
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ALL",
        directRepliesEnabled: false,
        groupRepliesEnabled: false,
      });

      const { isPolicyEmpty, conditions } = await getPolicyAudienceConditions(
        mockDb,
        settingsRepo,
        channelAccountId
      );

      expect(isPolicyEmpty).toBe(true);
      expect(conditions).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Inbox Fastify Route API Tests
  // --------------------------------------------------------------------------
  describe("GET /api/inbox policy filtering", () => {
    it("returns empty list immediately when ONLY_SELECTED policy is empty", async () => {
      const mockDb = createMockDb({ policyMembers: [] });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: [],
      });

      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: mockDb,
          convRepo: {} as ConversationRepository,
          queueRepo: {} as QueueRepository,
          outboundRepo: {} as OutboundRepository,
          eventRepo: {} as EventRepository,
          outboxRepo: {} as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "op@messenger.local", role: "OPERATOR" }),
          channelAccountId,
          settingsRepo,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/inbox",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.conversations).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.hasMore).toBe(false);
    });

    it("fails closed with HTTP 503 when settings repository throws an error", async () => {
      const mockDb = createMockDb();
      const settingsRepo = createMockSettingsRepo(null, true); // throws!

      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: mockDb,
          convRepo: {} as ConversationRepository,
          queueRepo: {} as QueueRepository,
          outboundRepo: {} as OutboundRepository,
          eventRepo: {} as EventRepository,
          outboxRepo: {} as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "op@messenger.local", role: "OPERATOR" }),
          channelAccountId,
          settingsRepo,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/inbox",
      });

      expect(res.statusCode).toBe(503);
      const data = JSON.parse(res.payload);
      expect(data.error).toContain("Unable to apply reply policy to inbox");
    });

    it("guards scope=all: blocks non-OWNER (OPERATOR/VIEWER) with 403", async () => {
      const mockDb = createMockDb();
      const settingsRepo = createMockSettingsRepo({ replyMode: "ONLY_SELECTED" });

      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: mockDb,
          convRepo: {} as ConversationRepository,
          queueRepo: {} as QueueRepository,
          outboundRepo: {} as OutboundRepository,
          eventRepo: {} as EventRepository,
          outboxRepo: {} as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "op@messenger.local", role: "OPERATOR" }),
          channelAccountId,
          settingsRepo,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/inbox?scope=all",
      });

      expect(res.statusCode).toBe(403);
      const data = JSON.parse(res.payload);
      expect(data.error).toContain("Only OWNER role can access all conversation history");
      expect(data.requiredRole).toBe("OWNER");
    });

    it("allows scope=all for OWNER role to read full conversation history", async () => {
      const mockDb = createMockDb({
        conversations: [
          {
            conversation: {
              id: "conv-hist-1",
              threadKind: "GROUP",
              title: "Nhóm bạn cũ",
              lastInboundAt: new Date(),
            },
            customer: null,
          },
        ],
      });
      const settingsRepo = createMockSettingsRepo({ replyMode: "ONLY_SELECTED" });

      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: mockDb,
          convRepo: {} as ConversationRepository,
          queueRepo: {} as QueueRepository,
          outboundRepo: {} as OutboundRepository,
          eventRepo: {} as EventRepository,
          outboxRepo: {} as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "owner@messenger.local", role: "OWNER" }),
          channelAccountId,
          settingsRepo,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/inbox?scope=all",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.conversations).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Admin Overview Fastify Route API Tests
  // --------------------------------------------------------------------------
  describe("GET /api/overview audience metrics", () => {
    it("returns 0 todayConversationsCount and todayMessagesCount when policy is empty", async () => {
      const mockDb = createMockDb({ policyMembers: [] });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: [],
      });

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: mockDb,
          queueRepo: { getQueueList: vi.fn(async () => []) } as unknown as QueueRepository,
          settingsRepo,
          aiConfigRepo: {
            getPublicConfig: vi.fn(async () => ({
              apiFormat: "OPENAI_COMPATIBLE",
              baseUrl: "https://api.openai.com/v1",
              model: "auto",
              apiKeyConfigured: true,
            })),
          } as unknown as AiConfigRepository,
          incidentRepo: { getOpenIncidents: vi.fn(async () => []) } as unknown as IncidentRepository,
          eventRepo: { recordEvent: vi.fn(async () => {}) } as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "owner@messenger.local", role: "OWNER" }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/overview",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.todayConversationsCount).toBe(0);
      expect(data.todayMessagesCount).toBe(0);
    });

    it("returns today counts scoped to active audience and preserves side effects", async () => {
      const mockDb = createMockDb({
        policyMembers: [{ participantId: "fb-user-1" }],
        todayConvCount: 3,
        todayMsgCount: 15,
      });
      const settingsRepo = createMockSettingsRepo({
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: ["fb-user-1"],
      });

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: mockDb,
          queueRepo: { getQueueList: vi.fn(async () => []) } as unknown as QueueRepository,
          settingsRepo,
          aiConfigRepo: {
            getPublicConfig: vi.fn(async () => ({
              apiFormat: "OPENAI_COMPATIBLE",
              baseUrl: "https://api.openai.com/v1",
              model: "auto",
              apiKeyConfigured: true,
            })),
          } as unknown as AiConfigRepository,
          incidentRepo: { getOpenIncidents: vi.fn(async () => []) } as unknown as IncidentRepository,
          eventRepo: { recordEvent: vi.fn(async () => {}) } as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "owner@messenger.local", role: "OWNER" }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/overview",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.todayConversationsCount).toBe(3);
      expect(data.todayMessagesCount).toBe(15);
      expect(data.channelStatus).toBe("RUNNING");
      expect(data.channelIsPaused).toBe(false);
    });

    it("fails closed to 0 counts without crashing overview when settings error occurs", async () => {
      const mockDb = createMockDb();
      const settingsRepo = createMockSettingsRepo(null, true); // throws!

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: mockDb,
          queueRepo: { getQueueList: vi.fn(async () => []) } as unknown as QueueRepository,
          settingsRepo,
          aiConfigRepo: {
            getPublicConfig: vi.fn(async () => ({
              apiFormat: "OPENAI_COMPATIBLE",
              baseUrl: "https://api.openai.com/v1",
              model: "auto",
              apiKeyConfigured: true,
            })),
          } as unknown as AiConfigRepository,
          incidentRepo: { getOpenIncidents: vi.fn(async () => []) } as unknown as IncidentRepository,
          eventRepo: { recordEvent: vi.fn(async () => {}) } as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({ id: "u1", email: "owner@messenger.local", role: "OWNER" }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/overview",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.todayConversationsCount).toBe(0);
      expect(data.todayMessagesCount).toBe(0);
    });
  });
});
