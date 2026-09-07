import { describe, it, expect, vi } from "vitest";
import { ConversationRepository } from "../packages/db/src/repository/conversation-repo.js";
import { ReplyPolicyService } from "../packages/db/src/service/reply-policy-service.js";
import { InboundMessagePayloadSchema } from "../packages/contracts/src/message.js";
import type { Database } from "@messenger/db";
import { conversations, customers, messages, inboundMessages, jobs, channelAccounts, settings, replyPolicyMembers } from "../packages/db/src/schema/index.js";

describe("Eligibility-First Persistence & Storage Optimization (P1 - P9)", () => {
  function setupTestHarness(customSettings: Record<string, unknown> = {}, existingConvList: Record<string, unknown>[] = []) {
    const dbState = {
      conversations: [...existingConvList],
      customers: [] as Record<string, unknown>[],
      messages: [] as Record<string, unknown>[],
      inboundMessages: [] as Record<string, unknown>[],
      jobs: [] as Record<string, unknown>[],
      channelAccounts: [
        {
          id: "acc-test-1",
          status: "RUNNING",
          isPaused: false,
          isSuspended: false,
          accountType: "PERSONAL_MESSENGER",
        },
      ],
      settings: [
        {
          channelAccountId: "acc-test-1",
          settings: {
            replyMode: "EVERYONE_EXCEPT",
            autoReplyEnabled: true,
            pauseIntakeProcessing: false,
            directRepliesEnabled: true,
            groupRepliesEnabled: false,
            pageRepliesEnabled: false,
            nonPersonRepliesEnabled: false,
            requireGroupMention: true,
            selectedParticipantIds: ["user-vip-1"],
            excludedParticipantIds: ["user-spammer-1"],
            persistenceMode: "ELIGIBLE_ONLY",
            persistExcludedInbound: false,
            persistDropTelemetry: true,
            debounceMs: 5000,
            humanInboundResponseWaitMs: 60000,
            ...customSettings,
          },
        },
      ],
      policyMembers: [] as Record<string, unknown>[],
    };

    const mockTx = {
      select: vi.fn((_fields?: unknown) => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockImplementation(() => {
              const tableName = (table as any)?.[Symbol.for("drizzle:Name")] || (table as any)?._?.name || (table as any)?.name;
              if (tableName === "channel_accounts") return Promise.resolve(dbState.channelAccounts);
              if (tableName === "settings") return Promise.resolve(dbState.settings);
              if (tableName === "reply_policy_members") return Promise.resolve(dbState.policyMembers);
              if (tableName === "conversations") return Promise.resolve(dbState.conversations);
              if (tableName === "messages") return Promise.resolve(dbState.messages);
              if (tableName === "customers") return Promise.resolve(dbState.customers);
              return Promise.resolve([]);
            }),
          })),
        })),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((val: Record<string, unknown>) => {
          const tableName = (table as any)?.[Symbol.for("drizzle:Name")] || (table as any)?._?.name || (table as any)?.name;
          if (tableName === "conversations") dbState.conversations.push(val);
          if (tableName === "customers") dbState.customers.push(val);
          if (tableName === "messages") dbState.messages.push(val);
          if (tableName === "inbound_messages") dbState.inboundMessages.push(val);
          if (tableName === "jobs") dbState.jobs.push(val);
          return {
            returning: vi.fn().mockResolvedValue([{ id: `gen-${tableName}-id` }]),
            onConflictDoUpdate: vi.fn().mockResolvedValue([{ id: `gen-${tableName}-id` }]),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    };

    const mockDb = {
      ...mockTx,
      transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as Database;

    const replyPolicyService = new ReplyPolicyService(mockDb);
    const repo = new ConversationRepository(mockDb, replyPolicyService);

    return { repo, dbState, replyPolicyService };
  }

  // P1: ONLY_SELECTED + not selected -> 0 new customer, 0 new conversation, 0 new messages, 0 new inbound_messages, 0 AI job
  it("P1: in ONLY_SELECTED mode, unselected sender is DROPPED with 0 DB writes", async () => {
    const { repo, dbState } = setupTestHarness({
      replyMode: "ONLY_SELECTED",
      selectedParticipantIds: ["user-vip-1"],
    });

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-stranger",
      externalThreadRef: "https://m.me/thread-stranger",
      externalCustomerId: "user-stranger",
      customerName: "Stranger User",
      externalMessageId: "mid.stranger.001",
      text: "Hello shop!",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "user-stranger",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    expect(res.dropped).toBe(true);
    expect(res.disposition).toBe("DROP");
    expect(res.reasonCode).toBe("PERSON_NOT_SELECTED");
    expect(dbState.conversations.length).toBe(0);
    expect(dbState.customers.length).toBe(0);
    expect(dbState.messages.length).toBe(0);
    expect(dbState.inboundMessages.length).toBe(0);
    expect(dbState.jobs.length).toBe(0);
  });

  // P2: selected sender -> full persist, debounce, AI
  it("P2: in ONLY_SELECTED mode, selected sender is FULL_PROCESS, persisted and debounced", async () => {
    const { repo, dbState } = setupTestHarness({
      replyMode: "ONLY_SELECTED",
      selectedParticipantIds: ["user-vip-1"],
    });

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-vip-1",
      externalThreadRef: "https://m.me/thread-vip-1",
      externalCustomerId: "user-vip-1",
      customerName: "VIP Buyer",
      externalMessageId: "mid.vip.001",
      text: "Tư vấn cho mình áo này",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "user-vip-1",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload, { debounceMs: 5000 });

    expect(res.dropped).toBe(false);
    expect(res.disposition).toBe("FULL_PROCESS");
    expect(res.eligibility?.eligible).toBe(true);
    expect(dbState.conversations.length).toBeGreaterThan(0);
    expect(dbState.messages.length).toBeGreaterThan(0);
    expect(dbState.inboundMessages.length).toBeGreaterThan(0);
    expect(dbState.jobs.some((j) => j.jobType === "debounce")).toBe(true);
  });

  // P3: excluded sender -> DROP
  it("P3: excluded participant in EVERYONE_EXCEPT is DROPPED before persistence", async () => {
    const { repo, dbState } = setupTestHarness({
      replyMode: "EVERYONE_EXCEPT",
      excludedParticipantIds: ["user-spammer-1"],
    });

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-spammer-1",
      externalThreadRef: "https://m.me/thread-spammer-1",
      externalCustomerId: "user-spammer-1",
      customerName: "Spammer Account",
      externalMessageId: "mid.spam.001",
      text: "Mua like sub gia re",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "user-spammer-1",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    expect(res.dropped).toBe(true);
    expect(res.disposition).toBe("DROP");
    expect(res.reasonCode).toBe("PERSON_EXCLUDED");
    expect(dbState.conversations.length).toBe(0);
    expect(dbState.messages.length).toBe(0);
  });

  // P4: group disabled -> no conversation/message persist
  it("P4: when groupRepliesEnabled is false, group thread inbounds are DROPPED", async () => {
    const { repo, dbState } = setupTestHarness({
      groupRepliesEnabled: false,
    });

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "group-12345",
      externalThreadRef: "https://m.me/group-12345",
      externalCustomerId: "user-member-1",
      customerName: "Group Chat X",
      externalMessageId: "mid.group.001",
      text: "Nhóm ơi đi chơi không",
      timestamp: new Date(),
      threadKind: "GROUP",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "user-member-1",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    expect(res.dropped).toBe(true);
    expect(res.disposition).toBe("DROP");
    expect(res.reasonCode).toBe("GROUP_REPLIES_DISABLED");
    expect(dbState.conversations.length).toBe(0);
  });

  // P5: page disabled -> DROP
  it("P5: when pageRepliesEnabled is false, PAGE sender inbounds are DROPPED", async () => {
    const { repo, dbState } = setupTestHarness({
      pageRepliesEnabled: false,
    });

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-page-sender",
      externalThreadRef: "https://m.me/thread-page-sender",
      externalCustomerId: "page-abc",
      customerName: "Another Fanpage",
      externalMessageId: "mid.page.001",
      text: "Chào shop từ page",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PAGE",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "page-abc",
        senderKind: "PAGE",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    expect(res.dropped).toBe(true);
    expect(res.disposition).toBe("DROP");
    expect(res.reasonCode).toBe("PAGE_REPLIES_DISABLED");
    expect(dbState.conversations.length).toBe(0);
  });

  // P6: self/bot echo -> never inserted as inbound customer message
  it("P6: self echo / bot outbound message is DROPPED by pre-persist gate", async () => {
    const { repo, dbState } = setupTestHarness({
      replyMode: "EVERYONE_EXCEPT",
    });

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-normal-1",
      externalThreadRef: "https://m.me/thread-normal-1",
      externalCustomerId: "acc-test-1", // equals bot participant ID!
      customerName: "Bot Self",
      externalMessageId: "mid.self.001",
      text: "Dạ shop chào bạn",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "acc-test-1",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    expect(res.dropped).toBe(true);
    expect(res.disposition).toBe("DROP");
    expect(res.reasonCode).toBe("SELF_MESSAGE");
    expect(dbState.conversations.length).toBe(0);
    expect(dbState.messages.length).toBe(0);
  });

  // P7: existing valid customer + HUMAN_SESSION -> message persisted, AI deferred
  it("P7: existing in-scope customer in HUMAN_SESSION is persisted, and fallback job is scheduled", async () => {
    const futureHold = new Date(Date.now() + 60000);
    const existingConv = {
      id: "conv-existing-human",
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-cust-active",
      replyControlMode: "HUMAN_SESSION",
      manualMode: true,
      humanHoldUntil: futureHold,
      isBlocked: false,
      threadKind: "DIRECT",
      reliability: "VERIFIED",
      inboundVersion: 2,
      controlEpoch: 3,
    };

    const { repo, dbState } = setupTestHarness({}, [existingConv]);

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-cust-active",
      externalThreadRef: "https://m.me/thread-cust-active",
      externalCustomerId: "user-cust-active",
      customerName: "Active Customer",
      externalMessageId: "mid.cust.new",
      text: "Shop ơi áo này còn màu đen không?",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "user-cust-active",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    // NOT dropped: customer message is safely stored!
    expect(res.dropped).toBe(false);
    expect(res.disposition).toBe("FULL_PROCESS");
    expect(dbState.messages.length).toBeGreaterThan(0);
    // AI is deferred: human-fallback job is scheduled, NOT debounce
    expect(dbState.jobs.some((j) => j.jobType === "human-fallback")).toBe(true);
    expect(dbState.jobs.some((j) => j.jobType === "debounce")).toBe(false);
  });

  // P8: existing valid customer + HUMAN_PINNED -> message persisted, AI not scheduled
  it("P8: existing in-scope customer in HUMAN_PINNED is persisted, but NO AI job is scheduled", async () => {
    const existingConv = {
      id: "conv-pinned-1",
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-pinned-user",
      replyControlMode: "HUMAN_PINNED",
      manualMode: true,
      isBlocked: false,
      threadKind: "DIRECT",
      reliability: "VERIFIED",
      inboundVersion: 5,
      controlEpoch: 7,
    };

    const { repo, dbState } = setupTestHarness({}, [existingConv]);

    const payload = InboundMessagePayloadSchema.parse({
      channelAccountId: "acc-test-1",
      externalThreadId: "thread-pinned-user",
      externalThreadRef: "https://m.me/thread-pinned-user",
      externalCustomerId: "user-pinned",
      customerName: "Pinned Chat User",
      externalMessageId: "mid.pinned.msg",
      text: "Nhân viên ơi kiểm tra đơn giúp mình",
      timestamp: new Date(),
      threadKind: "DIRECT",
      threadReliability: "VERIFIED",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      participantIdentity: {
        channelAccountId: "acc-test-1",
        participantId: "user-pinned",
        senderKind: "PERSON",
        isVerified: true,
      },
    });

    const res = await repo.ingestInboundMessage(payload);

    expect(res.dropped).toBe(false);
    expect(res.disposition).toBe("FULL_PROCESS");
    expect(dbState.messages.length).toBeGreaterThan(0);
    // No AI job of any kind
    expect(dbState.jobs.some((j) => j.jobType === "debounce")).toBe(false);
    expect(dbState.jobs.some((j) => j.jobType === "human-fallback")).toBe(false);
  });

  // P9: 10,000 irrelevant messages -> table growth = 0
  it("P9: simulated volume of 1,000 irrelevant messages produces 0 DB table rows", async () => {
    const { repo, dbState } = setupTestHarness({
      replyMode: "ONLY_SELECTED",
      selectedParticipantIds: ["user-vip-1"],
    });

    for (let i = 0; i < 1000; i++) {
      const payload = InboundMessagePayloadSchema.parse({
        channelAccountId: "acc-test-1",
        externalThreadId: `thread-noise-${i}`,
        externalThreadRef: `https://m.me/thread-noise-${i}`,
        externalCustomerId: `user-noise-${i}`,
        customerName: `Noise User ${i}`,
        externalMessageId: `mid.noise.${i}`,
        text: `Noise text ${i}`,
        timestamp: new Date(),
        threadKind: "DIRECT",
        threadReliability: "VERIFIED",
        senderKind: "PERSON",
        senderReliability: "VERIFIED",
        participantIdentity: {
          channelAccountId: "acc-test-1",
          participantId: `user-noise-${i}`,
          senderKind: "PERSON",
          isVerified: true,
        },
      });

      const res = await repo.ingestInboundMessage(payload);
      expect(res.dropped).toBe(true);
    }

    expect(dbState.conversations.length).toBe(0);
    expect(dbState.customers.length).toBe(0);
    expect(dbState.messages.length).toBe(0);
    expect(dbState.inboundMessages.length).toBe(0);
    expect(dbState.jobs.length).toBe(0);
  });
});
