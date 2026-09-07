import { describe, it, expect, vi } from "vitest";
import { ConversationRepository } from "../packages/db/src/repository/conversation-repo.js";
import { ReplyPolicyService } from "../packages/db/src/service/reply-policy-service.js";
import { buildLeanConversationContext } from "../packages/ai/src/context-builder.js";
import type { InboundMessagePayload, MediaRef, SystemSettings } from "@messenger/contracts";
import type { Database } from "@messenger/db";

describe("PR-03: Message Pipeline Persistence v2 & Updates", () => {
  function setupTestDb() {
    const dbState = {
      conversations: [
        {
          id: "conv-1",
          channelAccountId: "acc-fb-1",
          externalThreadId: "thread-100",
          inboundVersion: 1,
          status: "WAITING_CUSTOMER",
          manualMode: false,
          isBlocked: false,
          replyControlMode: "AUTO",
          controlEpoch: 1,
          unreadCount: 0,
        },
      ] as Record<string, unknown>[],
      customers: [] as Record<string, unknown>[],
      messages: [] as Record<string, unknown>[],
      inboundMessages: [] as Record<string, unknown>[],
      messageMedia: [] as Record<string, unknown>[],
      jobs: [] as Record<string, unknown>[],
      channelAccounts: [
        {
          id: "acc-fb-1",
          status: "RUNNING",
          isPaused: false,
          isSuspended: false,
          accountType: "PERSONAL_MESSENGER",
        },
      ],
      settings: [
        {
          channelAccountId: "acc-fb-1",
          settings: {
            replyMode: "EVERYONE_EXCEPT",
            autoReplyEnabled: true,
            pauseIntakeProcessing: false,
            directRepliesEnabled: true,
            groupRepliesEnabled: false,
            pageRepliesEnabled: false,
            nonPersonRepliesEnabled: false,
            requireGroupMention: false,
            selectedParticipantIds: [],
            excludedParticipantIds: [],
            persistenceMode: "ELIGIBLE_ONLY",
            debounceMs: 3000,
            humanInboundResponseWaitMs: 60000,
          },
        },
      ],
      policyMembers: [] as Record<string, unknown>[],
      conversationEvents: [] as Record<string, unknown>[],
      outboxEvents: [] as Record<string, unknown>[],
      conversationQueue: [] as Record<string, unknown>[],
      replyEligibilityDecisions: [] as Record<string, unknown>[],
    };

    function getTableName(table: unknown): string {
      const rec = table as Record<string, unknown> | undefined;
      return (
        (rec?.[Symbol.for("drizzle:Name")] as string | undefined) ||
        ((rec?._ as Record<string, unknown> | undefined)?.name as string | undefined) ||
        (rec?.name as string | undefined) ||
        ""
      );
    }

    function extractSqlValues(clause: unknown, visited = new Set<unknown>()): string[] {
      if (!clause || typeof clause !== "object" || visited.has(clause)) return [];
      visited.add(clause);
      const values: string[] = [];
      const c = clause as Record<string, unknown>;
      if (typeof c.value === "string") {
        values.push(c.value);
      }
      if (Array.isArray(c.queryChunks)) {
        for (const chunk of c.queryChunks) {
          values.push(...extractSqlValues(chunk, visited));
        }
      }
      return values;
    }

    const mockTx = {
      select: vi.fn((_fields?: unknown) => ({
        from: vi.fn((table: unknown) => {
          const tableName = getTableName(table);
          return {
            where: vi.fn((whereClause?: unknown) => {
              const filterRows = () => {
                if (tableName === "channel_accounts") return dbState.channelAccounts;
                if (tableName === "settings") return dbState.settings;
                if (tableName === "conversations") return dbState.conversations;
                if (tableName === "messages") {
                  const sqlVals = extractSqlValues(whereClause);
                  if (sqlVals.length > 0) {
                    const matched = dbState.messages.filter(
                      (m) =>
                        sqlVals.includes(m.externalMessageId as string) ||
                        sqlVals.includes(m.id as string) ||
                        sqlVals.includes(m.conversationId as string)
                    );
                    return matched;
                  }
                  return dbState.messages;
                }
                if (tableName === "inbound_messages") return dbState.inboundMessages;
                if (tableName === "customers") return dbState.customers;
                if (tableName === "reply_policy_members") return dbState.policyMembers;
                return [];
              };

              return {
                limit: vi.fn().mockImplementation((limitCount: number = 20) => {
                  const rows = filterRows();
                  return Promise.resolve(rows.slice(0, limitCount));
                }),
                orderBy: vi.fn(() => ({
                  limit: vi.fn().mockImplementation((limitCount: number = 20) => {
                    const rows = filterRows();
                    return Promise.resolve(rows.slice(0, limitCount));
                  }),
                })),
                execute: vi.fn().mockResolvedValue(filterRows()),
              };
            }),
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockImplementation((limitCount: number = 20) => {
                if (tableName === "messages") return Promise.resolve(dbState.messages.slice(0, limitCount));
                return Promise.resolve([]);
              }),
            })),
            limit: vi.fn().mockImplementation((limitCount: number = 20) => {
              if (tableName === "channel_accounts") return Promise.resolve(dbState.channelAccounts.slice(0, limitCount));
              if (tableName === "settings") return Promise.resolve(dbState.settings.slice(0, limitCount));
              if (tableName === "conversations") return Promise.resolve(dbState.conversations.slice(0, limitCount));
              if (tableName === "messages") return Promise.resolve(dbState.messages.slice(0, limitCount));
              return Promise.resolve([]);
            }),
          };
        }),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((val: Record<string, unknown>) => {
          const tableName = getTableName(table);
          const generatedId = val.id || `gen-${tableName}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          const stored = { ...val, id: generatedId };

          if (tableName === "conversations") dbState.conversations.push(stored);
          if (tableName === "customers") dbState.customers.push(stored);
          if (tableName === "messages") dbState.messages.push(stored);
          if (tableName === "inbound_messages") dbState.inboundMessages.push(stored);
          if (tableName === "message_media") dbState.messageMedia.push(stored);
          if (tableName === "jobs") dbState.jobs.push(stored);
          if (tableName === "conversation_events") dbState.conversationEvents.push(stored);
          if (tableName === "outbox_events") dbState.outboxEvents.push(stored);
          if (tableName === "conversation_queue") dbState.conversationQueue.push(stored);
          if (tableName === "reply_eligibility_decisions") dbState.replyEligibilityDecisions.push(stored);

          return {
            returning: vi.fn().mockResolvedValue([stored]),
            onConflictDoNothing: vi.fn().mockResolvedValue([stored]),
            onConflictDoUpdate: vi.fn().mockResolvedValue([stored]),
          };
        }),
      })),
      update: vi.fn((table: unknown) => {
        const tableName = getTableName(table);
        return {
          set: vi.fn((updateFields: Record<string, unknown>) => ({
            where: vi.fn((whereClause: unknown) => {
              if (tableName === "messages") {
                const sqlVals = extractSqlValues(whereClause);
                for (const m of dbState.messages) {
                  if (
                    sqlVals.length === 0 ||
                    sqlVals.includes(m.externalMessageId as string) ||
                    sqlVals.includes(m.id as string)
                  ) {
                    Object.assign(m, updateFields);
                  }
                }
              }
              if (tableName === "conversations") {
                for (const c of dbState.conversations) {
                  Object.assign(c, updateFields);
                }
              }
              return Promise.resolve([]);
            }),
          })),
        };
      }),
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
      execute: vi.fn().mockResolvedValue([]),
    };

    const mockDb = {
      ...mockTx,
      transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as Database;

    const replyPolicyService = new ReplyPolicyService(mockDb);
    const repo = new ConversationRepository(mockDb, replyPolicyService);

    return { repo, dbState, mockDb };
  }

  const sampleMedia: MediaRef = {
    mediaId: "med-12345",
    role: "ATTACHMENT",
    mimeType: "image/png",
    byteSize: 512000,
    width: 800,
    height: 600,
    status: "READY",
  };

  it("rejects empty meaningless messages without persisting or creating turns", async () => {
    const { repo, dbState } = setupTestDb();

    const emptyPayload: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-empty-1",
      text: "   ",
      timestamp: new Date(),
    };

    const res = await repo.ingestInboundMessage(emptyPayload);
    expect(res.dropped).toBe(true);
    expect(res.reasonCode).toBe("EMPTY_MEANINGLESS_MESSAGE");
    expect(dbState.messages).toHaveLength(0);
    expect(dbState.inboundMessages).toHaveLength(0);
  });

  it("persists media-only message and creates message_media record", async () => {
    const { repo, dbState } = setupTestDb();

    const mediaOnlyPayload: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-media-only-1",
      text: "",
      parts: [
        {
          type: "IMAGE",
          media: sampleMedia,
          altText: "Ảnh sản phẩm áo",
        },
      ],
      timestamp: new Date(),
    };

    const res = await repo.ingestInboundMessage(mediaOnlyPayload);
    expect(res.dropped).toBeFalsy();
    expect(res.isDuplicate).toBe(false);
    expect(dbState.messages).toHaveLength(1);
    expect(dbState.inboundMessages).toHaveLength(1);

    const savedMsg = dbState.messages[0];
    expect(savedMsg.text).toBe("");
    expect(savedMsg.contentSchemaVersion).toBe(2);
    expect(savedMsg.contentStatus).toBe("READY");
    expect(savedMsg.contentRevision).toBe(1);

    // Verify message_media row was tracked
    expect(dbState.messageMedia).toHaveLength(1);
    const mediaRow = dbState.messageMedia[0];
    expect(mediaRow.mediaRefId).toBe("med-12345");
    expect(mediaRow.role).toBe("ATTACHMENT");
    expect(mediaRow.mimeType).toBe("image/png");
    expect(mediaRow.channelAccountId).toBe("acc-fb-1");
  });

  it("does not drop two consecutive messages with identical text if native source message IDs differ", async () => {
    const { repo, dbState } = setupTestDb();

    const msg1: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-native-001",
      text: "ok",
      timestamp: new Date(Date.now() - 1000),
    };

    const res1 = await repo.ingestInboundMessage(msg1);
    expect(res1.isDuplicate).toBe(false);
    expect(dbState.messages).toHaveLength(1);

    const msg2: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-native-002", // Different native ID!
      text: "ok", // Same text!
      timestamp: new Date(),
    };

    const res2 = await repo.ingestInboundMessage(msg2);
    expect(res2.isDuplicate).toBe(false);
    expect(dbState.messages).toHaveLength(2);
    expect(dbState.messages[0].externalMessageId).toBe("mid-native-001");
    expect(dbState.messages[1].externalMessageId).toBe("mid-native-002");
  });

  it("correctly identifies exact duplicate for identical externalMessageId without duplicating rows", async () => {
    const { repo, dbState } = setupTestDb();

    const msg: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-idempotent-1",
      text: "Báo giá em mẫu này",
      timestamp: new Date(),
    };

    const res1 = await repo.ingestInboundMessage(msg);
    expect(res1.isDuplicate).toBe(false);
    expect(dbState.messages).toHaveLength(1);

    // Resend exact same message ID
    const res2 = await repo.ingestInboundMessage(msg);
    expect(res2.isDuplicate).toBe(true);
    expect(dbState.messages).toHaveLength(1);
    expect(dbState.inboundMessages).toHaveLength(1);
  });

  it("handles MESSAGE_EDITED: updates text/parts, increments contentRevision, without incrementing inboundVersion", async () => {
    const { repo, dbState } = setupTestDb();

    // Initial message
    const initialMsg: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-edit-1",
      text: "Lấy cho em size M",
      timestamp: new Date(),
    };

    const res1 = await repo.ingestInboundMessage(initialMsg);
    expect(res1.isDuplicate).toBe(false);
    const initialInboundVersion = res1.inboundVersion;
    expect(dbState.inboundMessages).toHaveLength(1);

    // User edits message
    const editedMsg: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-edit-1",
      text: "Sửa lại: lấy cho em size L nha",
      eventKind: "MESSAGE_EDITED",
      timestamp: new Date(),
    };

    const res2 = await repo.ingestInboundMessage(editedMsg);
    expect(res2.isUpdate).toBe(true);
    expect(res2.eventKind).toBe("MESSAGE_EDITED");
    expect(res2.contentRevision).toBe(2);
    // Crucial: inboundVersion on conversation was NOT bumped!
    expect(res2.inboundVersion).toBe(initialInboundVersion);
    // Crucial: No second inbound_messages row created!
    expect(dbState.inboundMessages).toHaveLength(1);
  });

  it("handles MESSAGE_UNSENT: marks status UNAVAILABLE, increments contentRevision without incrementing inboundVersion", async () => {
    const { repo, dbState } = setupTestDb();

    const msg: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-unsend-1",
      text: "Tin nhắn gửi nhầm",
      timestamp: new Date(),
    };

    const res1 = await repo.ingestInboundMessage(msg);
    expect(res1.isDuplicate).toBe(false);

    // Unsend event
    const unsendPayload: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-unsend-1",
      text: "",
      eventKind: "MESSAGE_UNSENT",
      timestamp: new Date(),
    };

    const res2 = await repo.ingestInboundMessage(unsendPayload);
    expect(res2.isUpdate).toBe(true);
    expect(res2.eventKind).toBe("MESSAGE_UNSENT");
    expect(res2.contentStatus).toBe("UNAVAILABLE");
    expect(res2.contentRevision).toBe(2);
    // Did not create second inbound message
    expect(dbState.inboundMessages).toHaveLength(1);
  });

  it("updates message enrichment via dedicated updateMessageEnrichment method", async () => {
    const { repo } = setupTestDb();

    const initial: InboundMessagePayload = {
      channelAccountId: "acc-fb-1",
      externalThreadId: "thread-100",
      externalThreadRef: "https://facebook.com/messages/t/thread-100",
      externalMessageId: "mid-enrich-1",
      text: "Ảnh sản phẩm",
      parts: [{ type: "IMAGE", media: { ...sampleMedia, status: "PENDING" } }],
      timestamp: new Date(),
    };

    await repo.ingestInboundMessage(initial);

    // Dedicated enrichment update
    const enrichRes = await repo.updateMessageEnrichment({
      channelAccountId: "acc-fb-1",
      externalMessageId: "mid-enrich-1",
      contentStatus: "READY",
      parts: [{ type: "IMAGE", media: { ...sampleMedia, status: "READY" } }],
      eventTimestamp: new Date("2026-09-07T10:05:00.000Z"),
    });

    expect(enrichRes.isUpdated).toBe(true);
    expect(enrichRes.contentStatus).toBe("READY");
    expect(enrichRes.contentRevision).toBe(2);
  });

  describe("Reader Compatibility & Projections", () => {
    it("getRecentMessages automatically resolves parts for legacy rows without content column", async () => {
      const { repo, dbState } = setupTestDb();

      // Simulate a legacy DB row inserted before PR-03
      dbState.messages.push({
        id: "msg-legacy-1",
        channelAccountId: "acc-fb-1",
        conversationId: "conv-1",
        externalMessageId: "mid-legacy-1",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Tin nhắn cũ thời v1",
        timestamp: new Date("2026-09-01T00:00:00.000Z"),
        content: null, // Legacy null content
        contentSchemaVersion: 1,
      });

      const recent = await repo.getRecentMessages("conv-1", 10);
      expect(recent).toHaveLength(1);
      const row = recent[0];
      expect(row.parts).toBeDefined();
      expect(row.parts).toEqual([{ type: "TEXT", text: "Tin nhắn cũ thời v1" }]);
      expect(row.contentStatus).toBe("READY");
      expect(row.contentRevision).toBe(1);
    });
  });

  describe("AI Context Builder with Message Parts", () => {
    it("preserves media-only messages and keeps parts in context result", () => {
      const messages = [
        {
          id: "m1",
          direction: "INBOUND",
          text: "",
          parts: [{ type: "IMAGE" as const, media: sampleMedia }],
          timestamp: new Date("2026-09-07T10:00:00.000Z"),
        },
        {
          id: "m2",
          direction: "OUTBOUND",
          text: "Dạ shop thấy ảnh rồi ạ",
          timestamp: new Date("2026-09-07T10:01:00.000Z"),
        },
      ];

      const settings = {
        aiSystemPersona: "Bạn là CSKH",
        businessProfile: "Cửa hàng thời trang",
        contextHistoryMaxAgeHours: 24,
        contextMaxMessages: 10,
        contextMaxInboundMessages: 5,
        contextMaxMessagesPerSender: 5,
        contextMaxInputTokens: 4096,
      } as SystemSettings;

      const res = buildLeanConversationContext(messages, { settings });
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0].id).toBe("m1");
      expect(res.messages[0].parts).toHaveLength(1);
    });
  });

  describe("Stable Composite Cursor Pagination", () => {
    function parseMessageCursor(cursorStr?: string | null): { timestamp: Date; id?: string } | null {
      if (!cursorStr) return null;
      const trimmed = cursorStr.trim();
      if (!trimmed) return null;

      if (trimmed.includes("__")) {
        const [timePart, idPart] = trimmed.split("__");
        if (timePart && idPart) {
          const d = new Date(timePart);
          if (!isNaN(d.getTime())) {
            return { timestamp: d, id: idPart };
          }
        }
      }

      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) {
        return { timestamp: d };
      }
      return null;
    }

    it("parses composite cursor and legacy ISO timestamp correctly", () => {
      const composite = parseMessageCursor("2026-09-07T12:00:00.000Z__msg-uuid-99");
      expect(composite).not.toBeNull();
      expect(composite?.timestamp.toISOString()).toBe("2026-09-07T12:00:00.000Z");
      expect(composite?.id).toBe("msg-uuid-99");

      const legacy = parseMessageCursor("2026-09-07T12:00:00.000Z");
      expect(legacy).not.toBeNull();
      expect(legacy?.timestamp.toISOString()).toBe("2026-09-07T12:00:00.000Z");
      expect(legacy?.id).toBeUndefined();

      const invalid = parseMessageCursor("not-a-date");
      expect(invalid).toBeNull();
    });

    it("correctly paginates across messages with identical timestamps using composite tie-break cursor", () => {
      const sameTimestamp = new Date("2026-09-07T12:00:00.000Z");
      const sampleMessages = [
        { id: "11111111-1111-4111-8111-111111111111", timestamp: sameTimestamp, text: "Msg 1" },
        { id: "22222222-2222-4222-8222-222222222222", timestamp: sameTimestamp, text: "Msg 2" },
        { id: "33333333-3333-4333-8333-333333333333", timestamp: sameTimestamp, text: "Msg 3" },
        { id: "44444444-4444-4444-8444-444444444444", timestamp: sameTimestamp, text: "Msg 4" },
      ];

      function queryPage(cursorStr?: string | null, limit: number = 2) {
        const cursor = parseMessageCursor(cursorStr);
        const filtered = sampleMessages.filter((m) => {
          if (!cursor) return true;
          const tTime = m.timestamp.getTime();
          const cTime = cursor.timestamp.getTime();
          if (cursor.id) {
            return tTime < cTime || (tTime === cTime && m.id < cursor.id);
          }
          return tTime < cTime;
        });

        // Sorted by timestamp DESC, id DESC
        const sorted = [...filtered].sort((a, b) => {
          const tDiff = b.timestamp.getTime() - a.timestamp.getTime();
          if (tDiff !== 0) return tDiff;
          return b.id.localeCompare(a.id);
        });

        const page = sorted.slice(0, limit);
        const oldest = page[page.length - 1];
        const nextCursor = page.length >= limit && oldest ? `${oldest.timestamp.toISOString()}__${oldest.id}` : null;
        return { page, nextCursor };
      }

      // Page 1: should fetch msg 4 and msg 3
      const page1 = queryPage(null, 2);
      expect(page1.page).toHaveLength(2);
      expect(page1.page[0].id).toBe("44444444-4444-4444-8444-444444444444");
      expect(page1.page[1].id).toBe("33333333-3333-4333-8333-333333333333");
      expect(page1.nextCursor).toBe("2026-09-07T12:00:00.000Z__33333333-3333-4333-8333-333333333333");

      // Page 2 using composite cursor: must fetch msg 2 and msg 1 (none lost, none repeated!)
      const page2 = queryPage(page1.nextCursor, 2);
      expect(page2.page).toHaveLength(2);
      expect(page2.page[0].id).toBe("22222222-2222-4222-8222-222222222222");
      expect(page2.page[1].id).toBe("11111111-1111-4111-8111-111111111111");

      // Total messages retrieved across pages: exactly 4 unique messages
      const allIds = [...page1.page.map((m) => m.id), ...page2.page.map((m) => m.id)];
      expect(new Set(allIds).size).toBe(4);
    });
  });
});
