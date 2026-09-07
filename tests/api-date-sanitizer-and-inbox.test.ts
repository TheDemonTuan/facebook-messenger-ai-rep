import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import {
  sanitizeApiOutput,
  type Database,
  type ConversationRepository,
  type QueueRepository,
  type OutboundRepository,
  type JobRepository,
  type EventRepository,
  type OutboxRepository,
} from "../packages/db/src/index.js";
import { createInboxRoutes } from "../apps/core/src/routes/inbox.js";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";
import type { SessionUser } from "../packages/contracts/src/index.js";

describe("PR-01: API Date Sanitizer & Wire Semantics", () => {
  describe("sanitizeApiOutput unit semantics", () => {
    it("preserves top-level valid Date instances and valid JSON ISO wire serialization", () => {
      const validDate = new Date("2026-09-07T12:26:00.000Z");
      const sanitized = sanitizeApiOutput(validDate);

      expect(sanitized).toBeInstanceOf(Date);
      expect(sanitized.getTime()).toBe(validDate.getTime());
      expect(sanitized.toISOString()).toBe("2026-09-07T12:26:00.000Z");

      // Wire serialization
      expect(JSON.stringify(sanitized)).toBe('"2026-09-07T12:26:00.000Z"');
    });

    it("preserves invalid Date according to JSON/wire semantics (not empty object {})", () => {
      const invalidDate = new Date(NaN);
      const sanitized = sanitizeApiOutput(invalidDate);

      // In-memory: remains Date instance, NOT {}
      expect(sanitized).toBeInstanceOf(Date);
      expect(Number.isNaN(sanitized.getTime())).toBe(true);

      // Wire serialization: Date.prototype.toJSON() yields null, never {}
      expect(JSON.stringify(sanitized)).toBe("null");

      const objWithInvalid = sanitizeApiOutput({
        timestamp: new Date("not-a-valid-date-string"),
      });
      expect(objWithInvalid.timestamp).toBeInstanceOf(Date);
      expect(JSON.stringify(objWithInvalid)).toBe('{"timestamp":null}');
    });

    it("preserves nested Date instances in objects and deep structures", () => {
      const payload = {
        conversation: {
          id: "conv-1",
          createdAt: new Date("2026-09-07T10:00:00.000Z"),
          updatedAt: new Date("2026-09-07T11:30:00.000Z"),
        },
        metadata: {
          deep: {
            observedTimestamp: new Date("2026-09-07T12:26:02.000Z"),
          },
        },
      };

      const sanitized = sanitizeApiOutput(payload);

      expect(sanitized.conversation.createdAt).toBeInstanceOf(Date);
      expect(sanitized.conversation.updatedAt).toBeInstanceOf(Date);
      expect(sanitized.metadata.deep.observedTimestamp).toBeInstanceOf(Date);

      const serialized = JSON.parse(JSON.stringify(sanitized));
      expect(serialized.conversation.createdAt).toBe("2026-09-07T10:00:00.000Z");
      expect(serialized.conversation.updatedAt).toBe("2026-09-07T11:30:00.000Z");
      expect(serialized.metadata.deep.observedTimestamp).toBe("2026-09-07T12:26:02.000Z");
    });

    it("preserves Date instances inside arrays and arrays of objects", () => {
      const datesArray = [
        new Date("2026-09-07T08:00:00.000Z"),
        new Date("2026-09-07T09:00:00.000Z"),
        new Date(NaN),
      ];

      const sanitizedDates = sanitizeApiOutput(datesArray);
      expect(sanitizedDates[0]).toBeInstanceOf(Date);
      expect(sanitizedDates[1]).toBeInstanceOf(Date);
      expect(sanitizedDates[2]).toBeInstanceOf(Date);

      expect(JSON.stringify(sanitizedDates)).toBe(
        '["2026-09-07T08:00:00.000Z","2026-09-07T09:00:00.000Z",null]'
      );

      const messagesList = [
        { id: "m-1", text: "Hi", timestamp: new Date("2026-09-07T12:26:00.000Z") },
        { id: "m-2", text: "Hello", timestamp: new Date("2026-09-07T12:27:00.000Z") },
        { id: "m-3", text: "Broken", timestamp: new Date(NaN) },
      ];

      const sanitizedList = sanitizeApiOutput(messagesList);
      expect(sanitizedList[0].timestamp).toBeInstanceOf(Date);
      expect(sanitizedList[1].timestamp).toBeInstanceOf(Date);
      expect(sanitizedList[2].timestamp).toBeInstanceOf(Date);

      const serialized = JSON.parse(JSON.stringify(sanitizedList));
      expect(serialized[0].timestamp).toBe("2026-09-07T12:26:00.000Z");
      expect(serialized[1].timestamp).toBe("2026-09-07T12:27:00.000Z");
      expect(serialized[2].timestamp).toBeNull();
    });

    it("handles null and undefined safely at root and nested properties", () => {
      expect(sanitizeApiOutput(null)).toBeNull();
      expect(sanitizeApiOutput(undefined)).toBeUndefined();

      const objWithNulls = {
        id: "test-id",
        nullableDate: null,
        missingValue: undefined,
        activeDate: new Date("2026-09-07T12:00:00.000Z"),
      };

      const sanitized = sanitizeApiOutput(objWithNulls);
      expect(sanitized.nullableDate).toBeNull();
      expect(sanitized.missingValue).toBeUndefined();
      expect(sanitized.activeDate).toBeInstanceOf(Date);

      const serialized = JSON.parse(JSON.stringify(sanitized));
      expect(serialized.nullableDate).toBeNull();
      expect(serialized.missingValue).toBeUndefined();
      expect(serialized.activeDate).toBe("2026-09-07T12:00:00.000Z");
    });

    it("masks sensitive Facebook IDs while preserving adjacent valid Dates and non-sensitive fields", () => {
      const rawApiPayload = {
        conversation: {
          id: "conv-uuid-1",
          status: "WAITING",
          externalThreadId: "t_1002938481828",
          externalThreadRef: "https://www.facebook.com/messages/t/1002938481828",
          createdAt: new Date("2026-09-07T10:00:00.000Z"),
          updatedAt: new Date("2026-09-07T12:00:00.000Z"),
        },
        customer: {
          id: "cust-uuid-2",
          externalCustomerId: "cust_fb_998877",
          name: "Khách hàng Messenger",
          createdAt: new Date("2026-09-07T09:00:00.000Z"),
        },
        messages: [
          {
            id: "msg-uuid-3",
            text: "Shop có áo sơ mi trắng không?",
            timestamp: new Date("2026-09-07T12:26:00.000Z"),
            createdAt: new Date("2026-09-07T12:26:01.000Z"),
            senderExternalId: "sender_fb_123456",
            senderParticipantId: "part_uuid_4",
            participantId: "part_uuid_4",
            senderName: "Khách hàng Messenger",
          },
        ],
        payload: {
          externalThreadId: "t_1002938481828",
          nested: {
            facebookId: "fb_sensitive_555",
            senderId: "sender_raw_777",
            eventTimestamp: new Date("2026-09-07T12:26:00.000Z"),
            safeField: "allowed",
          },
        },
      };

      const sanitized = sanitizeApiOutput(rawApiPayload);

      // Sensitive fields omitted
      expect((sanitized.conversation as Record<string, unknown>).externalThreadId).toBeUndefined();
      expect((sanitized.conversation as Record<string, unknown>).externalThreadRef).toBeUndefined();
      expect((sanitized.customer as Record<string, unknown>).externalCustomerId).toBeUndefined();

      const msg = sanitized.messages[0] as Record<string, unknown>;
      expect(msg.senderExternalId).toBeUndefined();
      expect(msg.senderParticipantId).toBeUndefined();
      expect(msg.participantId).toBeUndefined();

      const payloadNested = (sanitized.payload as Record<string, unknown>).nested as Record<string, unknown>;
      expect(payloadNested.facebookId).toBeUndefined();
      expect(payloadNested.senderId).toBeUndefined();

      // Adjacent fields preserved
      expect(sanitized.conversation.id).toBe("conv-uuid-1");
      expect(sanitized.conversation.status).toBe("WAITING");
      expect(sanitized.conversation.createdAt).toBeInstanceOf(Date);
      expect(sanitized.conversation.updatedAt).toBeInstanceOf(Date);
      expect(sanitized.customer.name).toBe("Khách hàng Messenger");
      expect(msg.text).toBe("Shop có áo sơ mi trắng không?");
      expect(msg.timestamp).toBeInstanceOf(Date);
      expect(msg.createdAt).toBeInstanceOf(Date);
      expect(payloadNested.eventTimestamp).toBeInstanceOf(Date);
      expect(payloadNested.safeField).toBe("allowed");

      // Wire verification
      const serialized = JSON.parse(JSON.stringify(sanitized));
      expect(serialized.conversation.createdAt).toBe("2026-09-07T10:00:00.000Z");
      expect(serialized.conversation.updatedAt).toBe("2026-09-07T12:00:00.000Z");
      expect(serialized.messages[0].timestamp).toBe("2026-09-07T12:26:00.000Z");
      expect(serialized.messages[0].createdAt).toBe("2026-09-07T12:26:01.000Z");
      expect(serialized.payload.nested.eventTimestamp).toBe("2026-09-07T12:26:00.000Z");
    });

    it("does not mutate the input object", () => {
      const original = {
        externalThreadId: "secret-thread",
        timestamp: new Date("2026-09-07T12:26:00.000Z"),
        nested: {
          facebookId: "fb-123",
          date: new Date("2026-09-07T12:30:00.000Z"),
        },
      };

      const sanitized = sanitizeApiOutput(original);

      // Input remains untouched
      expect(original.externalThreadId).toBe("secret-thread");
      expect(original.nested.facebookId).toBe("fb-123");
      expect(original.timestamp.toISOString()).toBe("2026-09-07T12:26:00.000Z");

      // Output sanitized
      expect((sanitized as Record<string, unknown>).externalThreadId).toBeUndefined();
      expect((sanitized.nested as Record<string, unknown>).facebookId).toBeUndefined();
    });

    it("preserves primitive types and pre-formatted ISO strings", () => {
      const input = {
        isoString: "2026-09-07T12:26:00.000Z",
        numericCount: 42,
        booleanFlag: true,
        zero: 0,
        emptyString: "",
      };

      const sanitized = sanitizeApiOutput(input);
      expect(sanitized).toEqual(input);
    });
  });

  describe("Fastify Route-Level Injection with real Date instances", () => {
    interface QueryChain {
      from: (target: unknown) => QueryChain;
      leftJoin: (...args: unknown[]) => QueryChain;
      where: (...args: unknown[]) => QueryChain;
      orderBy: (...args: unknown[]) => QueryChain;
      limit: (...args: unknown[]) => QueryChain;
      offset: (...args: unknown[]) => QueryChain;
      then: (resolve: (val: unknown[]) => unknown) => unknown;
      [Symbol.iterator]: () => Generator<unknown, void, unknown>;
    }

    const createChainFor = (rows: unknown[]): QueryChain => {
      const chain: QueryChain = {
        from: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        offset: vi.fn(() => chain),
        then: (resolve: (val: unknown[]) => unknown) => resolve(rows),
        [Symbol.iterator]: function* () {
          for (const row of rows) {
            yield row;
          }
        },
      };
      return chain;
    };

    const getTableName = (table: unknown): string => {
      if (!table || typeof table !== "object") return "";
      const nameSym = Object.getOwnPropertySymbols(table).find(
        (s) => s.description === "drizzle:Name" || s.description === "drizzle:OriginalName"
      );
      if (nameSym) {
        return String((table as Record<symbol, unknown>)[nameSym]);
      }
      return "";
    };

    const setupInboxApp = async (options: {
      conversationRows?: unknown[];
      totalCount?: number;
      latestInbounds?: unknown[];
      timelineConvData?: unknown;
      timelineMessages?: unknown[];
      timelineAiRuns?: unknown[];
      timelineActions?: unknown[];
      timelineEvents?: unknown[];
      timelineDecisions?: unknown[];
      timelineInbounds?: unknown[];
      timelineParticipants?: unknown[];
    }) => {
      const {
        conversationRows = [],
        totalCount = conversationRows.length,
        latestInbounds = [],
        timelineConvData = null,
        timelineMessages = [],
        timelineAiRuns = [],
        timelineActions = [],
        timelineEvents = [],
        timelineDecisions = [],
        timelineInbounds = [],
        timelineParticipants = [],
      } = options;

      const mockDb = {
        select: vi.fn((selector?: unknown) => {
          return {
            from: vi.fn((table: unknown) => {
              const name = getTableName(table);
              if (name === "conversations") {
                if (selector && typeof selector === "object" && "count" in selector) {
                  return createChainFor([{ count: totalCount }]);
                }
                return createChainFor(conversationRows);
              }
              if (name === "messages") {
                return createChainFor(timelineMessages);
              }
              if (name === "ai_runs") {
                return createChainFor(timelineAiRuns);
              }
              if (name === "outbound_actions") {
                return createChainFor(timelineActions);
              }
              if (name === "reply_eligibility_decisions") {
                return createChainFor(timelineDecisions);
              }
              if (name === "inbound_messages") {
                return createChainFor(timelineInbounds);
              }
              if (name === "participants") {
                return createChainFor(timelineParticipants);
              }
              return createChainFor([]);
            }),
          };
        }),
        selectDistinctOn: vi.fn(() => ({
          from: vi.fn(() => createChainFor(latestInbounds)),
        })),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      } as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue(timelineConvData),
        getMessages: vi.fn().mockResolvedValue(timelineMessages),
      } as unknown as ConversationRepository;

      const mockEventRepo = {
        getRecentEvents: vi.fn().mockResolvedValue(timelineEvents),
      } as unknown as EventRepository;

      const requireAuth = vi.fn().mockResolvedValue({
        id: "user-1",
        email: "operator@example.com",
        name: "Operator User",
        role: "OPERATOR",
      } as SessionUser);

      const app = Fastify();
      await app.register(
        createInboxRoutes({
          db: mockDb,
          convRepo: mockConvRepo,
          queueRepo: {} as QueueRepository,
          outboundRepo: {} as OutboundRepository,
          jobRepo: {} as JobRepository,
          eventRepo: mockEventRepo,
          outboxRepo: {} as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth,
          channelAccountId: "channel-1",
        })
      );

      return app;
    };

    it("GET /api/inbox preserves real Date instances as valid ISO strings over HTTP wire and masks IDs", async () => {
      const convCreated = new Date("2026-09-07T10:00:00.000Z");
      const convUpdated = new Date("2026-09-07T12:25:00.000Z");
      const custCreated = new Date("2026-09-07T09:30:00.000Z");
      const inboundTime = new Date("2026-09-07T12:25:00.000Z");

      const conversationRows = [
        {
          conversation: {
            id: "conv-101",
            channelAccountId: "channel-1",
            customerId: "cust-202",
            threadKind: "DIRECT",
            externalThreadId: "t_fb_sensitive_888",
            externalThreadRef: "https://facebook.com/messages/t/t_fb_sensitive_888",
            status: "OPEN",
            title: "Trần Thị B",
            createdAt: convCreated,
            updatedAt: convUpdated,
            lastInboundAt: inboundTime,
          },
          customer: {
            id: "cust-202",
            channelAccountId: "channel-1",
            externalCustomerId: "cust_fb_sensitive_999",
            name: "Trần Thị B",
            avatarUrl: "https://cdn.example.com/avatar.jpg",
            notes: null,
            createdAt: custCreated,
            updatedAt: convUpdated,
          },
        },
      ];

      const latestInbounds = [
        {
          conversationId: "conv-101",
          text: "Cho mình hỏi giá sản phẩm này",
          timestamp: inboundTime,
        },
      ];

      const app = await setupInboxApp({
        conversationRows,
        totalCount: 1,
        latestInbounds,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox?limit=10&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);

      expect(json.conversations).toHaveLength(1);
      const item = json.conversations[0];

      // Verify Dates over wire are valid ISO strings, NEVER empty objects {}
      expect(item.conversation.createdAt).toBe("2026-09-07T10:00:00.000Z");
      expect(item.conversation.updatedAt).toBe("2026-09-07T12:25:00.000Z");
      expect(item.conversation.lastInboundAt).toBe("2026-09-07T12:25:00.000Z");
      expect(item.customer.createdAt).toBe("2026-09-07T09:30:00.000Z");
      expect(item.latestInboundMessage.timestamp).toBe("2026-09-07T12:25:00.000Z");

      // Verify UI can parse them into finite timestamps
      expect(Number.isFinite(new Date(item.conversation.createdAt).getTime())).toBe(true);
      expect(Number.isFinite(new Date(item.conversation.updatedAt).getTime())).toBe(true);
      expect(Number.isFinite(new Date(item.latestInboundMessage.timestamp).getTime())).toBe(true);

      // Verify sensitive IDs are masked from the wire
      expect(item.conversation.externalThreadId).toBeUndefined();
      expect(item.conversation.externalThreadRef).toBeUndefined();
      expect(item.customer.externalCustomerId).toBeUndefined();
    });

    it("GET /api/inbox/:conversationId timeline delivers valid ISO timestamps and wire null for invalid Dates", async () => {
      const msgTime1 = new Date("2026-09-07T12:26:00.000Z");
      const msgCreated1 = new Date("2026-09-07T12:26:01.000Z");
      const invalidLegacyDate = new Date(NaN);
      const eventCreated = new Date("2026-09-07T12:26:05.000Z");
      const runCreated = new Date("2026-09-07T12:26:02.000Z");
      const actionCreated = new Date("2026-09-07T12:26:03.000Z");

      const timelineConvData = {
        conversation: {
          id: "conv-101",
          channelAccountId: "channel-1",
          customerId: "cust-202",
          threadKind: "DIRECT",
          externalThreadId: "t_sensitive_111",
          status: "OPEN",
          createdAt: new Date("2026-09-07T10:00:00.000Z"),
          updatedAt: msgTime1,
        },
        customer: {
          id: "cust-202",
          name: "Nguyễn Văn A",
          externalCustomerId: "cust_sensitive_222",
          avatarUrl: null,
        },
      };

      const timelineMessages = [
        {
          id: "msg-1",
          conversationId: "conv-101",
          senderParticipantId: "part-1",
          senderExternalId: "fb-sender-1",
          participantId: "part-1",
          senderKind: "CUSTOMER",
          text: "Chào shop Sin Sin",
          timestamp: msgTime1,
          createdAt: msgCreated1,
          updatedAt: msgCreated1,
          direction: "INBOUND",
        },
        {
          id: "msg-2",
          conversationId: "conv-101",
          senderParticipantId: "part-1",
          senderExternalId: "fb-sender-1",
          participantId: "part-1",
          senderKind: "CUSTOMER",
          text: "Tin nhắn có timestamp lỗi legacy",
          timestamp: invalidLegacyDate,
          createdAt: msgCreated1,
          updatedAt: msgCreated1,
          direction: "INBOUND",
        },
      ];

      const timelineAiRuns = [
        {
          id: "run-1",
          conversationId: "conv-101",
          status: "COMPLETED",
          createdAt: runCreated,
        },
      ];

      const timelineActions = [
        {
          id: "act-1",
          conversationId: "conv-101",
          actionType: "SEND_MESSAGE",
          status: "DELIVERED",
          createdAt: actionCreated,
        },
      ];

      const timelineEvents = [
        {
          id: "ev-1",
          conversationId: "conv-101",
          eventType: "INBOUND_RECEIVED",
          createdAt: eventCreated,
        },
      ];

      const app = await setupInboxApp({
        timelineConvData,
        timelineMessages,
        timelineAiRuns,
        timelineActions,
        timelineEvents,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox/conv-101",
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);

      // Verify conversation metadata
      expect(json.conversation.createdAt).toBe("2026-09-07T10:00:00.000Z");
      expect(json.conversation.updatedAt).toBe("2026-09-07T12:26:00.000Z");
      expect(json.conversation.externalThreadId).toBeUndefined();
      expect(json.customer.externalCustomerId).toBeUndefined();

      // Verify messages
      expect(json.messages).toHaveLength(2);

      // Message 1: valid real Date -> valid ISO string, NOT {}
      const msg1 = json.messages.find((m: { id: string }) => m.id === "msg-1");
      expect(msg1).toBeDefined();
      expect(msg1.timestamp).toBe("2026-09-07T12:26:00.000Z");
      expect(msg1.createdAt).toBe("2026-09-07T12:26:01.000Z");
      expect(Number.isFinite(new Date(msg1.timestamp).getTime())).toBe(true);

      // Sensitive sender IDs stripped from message
      expect(msg1.senderExternalId).toBeUndefined();
      expect(msg1.senderParticipantId).toBeUndefined();
      expect(msg1.participantId).toBeUndefined();

      // Message 2: invalid Date (NaN) -> wire null per JSON wire semantics, NOT {}
      const msg2 = json.messages.find((m: { id: string }) => m.id === "msg-2");
      expect(msg2).toBeDefined();
      expect(msg2.timestamp).toBeNull();
      expect(msg2.senderExternalId).toBeUndefined();

      // Verify AI runs, actions, events contain valid timestamps
      expect(json.aiRuns[0].createdAt).toBe("2026-09-07T12:26:02.000Z");
      expect(json.outboundActions[0].createdAt).toBe("2026-09-07T12:26:03.000Z");
      expect(json.events[0].createdAt).toBe("2026-09-07T12:26:05.000Z");
    });
  });
});
