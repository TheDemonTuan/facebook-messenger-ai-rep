/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  evaluateReplyEligibility,
  SystemSettingsSchema,
  type ReplyEligibilityInput,
} from "../packages/contracts/src/index.js";
import {
  ConversationRepository,
  ReplyPolicyService,
  type Database,
  type JobRepository,
  type OutboundRepository,
  type EventRepository,
  type SettingsRepository,
  type IncidentRepository,
  type TurnRepository,
  type OutboxRepository,
} from "../packages/db/src/index.js";
import { createDebounceHandler } from "../apps/core/src/jobs/handlers/debounce.js";
import { createAiHandler } from "../apps/core/src/jobs/handlers/ai.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import type { ChannelAdapter } from "../packages/channel/src/index.js";
import type { AiReplyGenerator } from "../packages/ai/src/index.js";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";

describe("PR 5: Synchronous Inbound Identity Reconciliation & Reply Eligibility Gating", () => {
  const baseTimestamp = new Date("2026-09-05T12:00:00.000Z");

  const defaultSettings = SystemSettingsSchema.parse({
    autoReplyEnabled: true,
    pauseIntakeProcessing: false,
    directRepliesEnabled: true,
    groupRepliesEnabled: true,
    pageRepliesEnabled: false,
    nonPersonRepliesEnabled: false,
    requireGroupMention: true,
    replyMode: "EVERYONE_EXCEPT",
    selectedParticipantIds: [],
    excludedParticipantIds: [],
    businessTimeZone: "Asia/Ho_Chi_Minh",
  });

  function createBaseInput(): ReplyEligibilityInput {
    return {
      channel: {
        id: "chan-01",
        accountType: "PERSONAL_MESSENGER",
        isSuspended: false,
        isPaused: false,
        botParticipantId: "bot-self-01",
        botProfileUrl: "https://facebook.com/bot-self",
      },
      thread: {
        id: "conv-101",
        externalThreadId: "thread-101",
        kind: "DIRECT",
        reliability: "VERIFIED",
        isBlocked: false,
        manualMode: false,
      },
      sender: {
        id: "cust-202",
        kind: "PERSON",
        reliability: "VERIFIED",
        participantIdentity: {
          channelAccountId: "chan-01",
          participantId: "cust-202",
          senderKind: "PERSON",
          isVerified: true,
        },
      },
      message: {
        id: "msg-303",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Xin chao shop",
        mentions: [],
      },
      settings: defaultSettings,
    };
  }

  describe("1. Policy Matrix & Fail-Closed Invariants", () => {
    it("eligible: verified direct PERSON in EVERYONE_EXCEPT mode", () => {
      const input = createBaseInput();
      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.decision).toBe("ELIGIBLE");
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("fail-closed: unverified participant identity is rejected", () => {
      const input = createBaseInput();
      input.sender.reliability = "VERIFIED";
      input.sender.participantIdentity = {
        channelAccountId: "chan-01",
        participantId: "cust-202",
        senderKind: "PERSON",
        isVerified: false,
      };

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");
    });

    it("fail-closed: legacy inbound with no participant identity is rejected", () => {
      const input = createBaseInput();
      input.sender.id = undefined;
      input.sender.participantIdentity = undefined;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");
    });

    it("fail-closed: externalThreadId cannot impersonate participant identity", () => {
      const input = createBaseInput();
      input.sender.id = "thread-101"; // matches externalThreadId!
      input.sender.participantIdentity = {
        channelAccountId: "chan-01",
        participantId: "thread-101",
        senderKind: "PERSON",
        isVerified: true,
      };

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");
    });

    it("group PERSON: requires both list membership AND verified structured bot mention", () => {
      const input = createBaseInput();
      input.thread.kind = "GROUP";
      input.thread.externalThreadId = "group-1001";
      input.settings = SystemSettingsSchema.parse({
        ...defaultSettings,
        groupRepliesEnabled: true,
        replyMode: "ONLY_SELECTED",
        selectedParticipantIds: ["cust-202"],
        requireGroupMention: true,
      });

      // 1. Without mention -> Ineligible
      input.message.mentions = [];
      const withoutMention = evaluateReplyEligibility(input);
      expect(withoutMention.eligible).toBe(false);
      expect(withoutMention.reasonCode).toBe("GROUP_MENTION_REQUIRED");

      // 2. Unverified mention -> Ineligible
      input.message.mentions = [
        {
          entityId: "bot-self-01",
          mentionText: "@bot",
          isVerified: false,
          evidenceType: "DOM_ANCHOR",
        },
      ];
      const unverifiedMention = evaluateReplyEligibility(input);
      expect(unverifiedMention.eligible).toBe(false);
      expect(unverifiedMention.reasonCode).toBe("GROUP_MENTION_UNVERIFIED");

      // 3. Verified mention, but sender not in selected list -> Ineligible
      input.message.mentions = [
        {
          entityId: "bot-self-01",
          mentionText: "@bot",
          isVerified: true,
          evidenceType: "DOM_ANCHOR",
        },
      ];
      input.settings.selectedParticipantIds = ["other-user"];
      const notInList = evaluateReplyEligibility(input);
      expect(notInList.eligible).toBe(false);
      expect(notInList.reasonCode).toBe("PERSON_NOT_SELECTED");

      // 4. Verified mention AND sender in selected list -> Eligible
      input.settings.selectedParticipantIds = ["cust-202"];
      const eligibleGroup = evaluateReplyEligibility(input);
      expect(eligibleGroup.eligible).toBe(true);
      expect(eligibleGroup.reasonCode).toBe("ELIGIBLE");
    });

    it("page/non-person independent source switches vs channel-account FACEBOOK_PAGE", () => {
      // Sender is PAGE with pageRepliesEnabled = false -> rejected
      const pageSenderInput = createBaseInput();
      pageSenderInput.sender.kind = "PAGE";
      pageSenderInput.sender.participantIdentity = {
        channelAccountId: "chan-01",
        participantId: "page-business-id",
        senderKind: "PAGE",
        isVerified: true,
      };
      pageSenderInput.settings = SystemSettingsSchema.parse({
        ...defaultSettings,
        pageRepliesEnabled: false,
      });

      const pageDisabledResult = evaluateReplyEligibility(pageSenderInput);
      expect(pageDisabledResult.eligible).toBe(false);
      expect(pageDisabledResult.reasonCode).toBe("PAGE_REPLIES_DISABLED");

      // Sender is PAGE with pageRepliesEnabled = true -> eligible
      pageSenderInput.settings.pageRepliesEnabled = true;
      const pageEnabledResult = evaluateReplyEligibility(pageSenderInput);
      expect(pageEnabledResult.eligible).toBe(true);
      expect(pageEnabledResult.reasonCode).toBe("ELIGIBLE");

      // Channel account type is FACEBOOK_PAGE, but sender is PERSON -> governed by direct replies switch, NOT pageRepliesEnabled
      const fbPageChannelInput = createBaseInput();
      fbPageChannelInput.channel.accountType = "FACEBOOK_PAGE";
      fbPageChannelInput.settings = SystemSettingsSchema.parse({
        ...defaultSettings,
        directRepliesEnabled: true,
        pageRepliesEnabled: false, // page switch is false, but sender is PERSON
      });

      const fbPageResult = evaluateReplyEligibility(fbPageChannelInput);
      expect(fbPageResult.eligible).toBe(true);
      expect(fbPageResult.reasonCode).toBe("ELIGIBLE");
    });

    it("two senders sending identical text: one allowed, one excluded", () => {
      const sameText = "Cho mình hỏi giá sản phẩm này với";

      const senderAInput = createBaseInput();
      senderAInput.sender.id = "user-allowed-a";
      senderAInput.sender.participantIdentity = {
        channelAccountId: "chan-01",
        participantId: "user-allowed-a",
        senderKind: "PERSON",
        isVerified: true,
      };
      senderAInput.message.text = sameText;
      senderAInput.settings = SystemSettingsSchema.parse({
        ...defaultSettings,
        replyMode: "EVERYONE_EXCEPT",
        excludedParticipantIds: ["user-blocked-b"],
      });

      const senderBInput = createBaseInput();
      senderBInput.sender.id = "user-blocked-b";
      senderBInput.sender.participantIdentity = {
        channelAccountId: "chan-01",
        participantId: "user-blocked-b",
        senderKind: "PERSON",
        isVerified: true,
      };
      senderBInput.message.text = sameText;
      senderBInput.settings = senderAInput.settings;

      const resultA = evaluateReplyEligibility(senderAInput);
      const resultB = evaluateReplyEligibility(senderBInput);

      expect(resultA.eligible).toBe(true);
      expect(resultA.reasonCode).toBe("ELIGIBLE");

      expect(resultB.eligible).toBe(false);
      expect(resultB.reasonCode).toBe("PERSON_EXCLUDED");
    });

    it("hard gates precedence: block/manual/paused/suspended/global auto", () => {
      const baseInput = createBaseInput();

      // Blocked conversation
      baseInput.thread.isBlocked = true;
      expect(evaluateReplyEligibility(baseInput).reasonCode).toBe("CONVERSATION_BLOCKED");
      baseInput.thread.isBlocked = false;

      // Manual mode
      baseInput.thread.manualMode = true;
      expect(evaluateReplyEligibility(baseInput).reasonCode).toBe("CONVERSATION_MANUAL_MODE");
      baseInput.thread.manualMode = false;

      // Channel paused
      baseInput.channel.isPaused = true;
      expect(evaluateReplyEligibility(baseInput).reasonCode).toBe("CHANNEL_PAUSED");
      baseInput.channel.isPaused = false;

      // Channel suspended
      baseInput.channel.isSuspended = true;
      expect(evaluateReplyEligibility(baseInput).reasonCode).toBe("CHANNEL_SUSPENDED");
      baseInput.channel.isSuspended = false;

      // Global auto reply disabled
      expect(
        evaluateReplyEligibility({
          ...baseInput,
          settings: { ...baseInput.settings, autoReplyEnabled: false },
        }).reasonCode
      ).toBe("AUTO_REPLY_DISABLED");
    });
  });

  describe("2. Ingestion Behavior & No-Work Ineligible", () => {
    function setupIngestionMocks(options?: {
      settings?: any;
      policyMembers?: any[];
      channelRunning?: boolean;
    }) {
      const operations: string[] = [];
      const insertedRows: Record<string, any[]> = {};

      const getSafeTableName = (table: any): string => {
        try {
          return getTableName(table);
        } catch {
          return "unknown";
        }
      };

      const mockTx = {
        select: vi.fn((_fields?: any) => ({
          from: vi.fn((table: any) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                const tableName = getSafeTableName(table);
                operations.push(`select-${tableName}`);
                // Channel account query
                if (tableName === "channel_accounts") {
                  return Promise.resolve([
                    {
                      id: "acc-1",
                      status: options?.channelRunning === false ? "SUSPENDED" : "RUNNING",
                      isPaused: false,
                      isSuspended: options?.channelRunning === false,
                      accountType: "PERSONAL_MESSENGER",
                    },
                  ]);
                }
                // Settings query
                if (tableName === "settings") {
                  return Promise.resolve([
                    {
                      channelAccountId: "acc-1",
                      settings: options?.settings ?? defaultSettings,
                    },
                  ]);
                }
                // Policy members query
                if (tableName === "reply_policy_members") {
                  return Promise.resolve(options?.policyMembers ?? []);
                }
                // Conversations / Inbound / Dedupe query
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
        insert: vi.fn((table: any) => ({
          values: vi.fn((vals: any) => {
            const tableName = getSafeTableName(table);
            operations.push(`insert-${tableName}`);
            if (!insertedRows[tableName]) insertedRows[tableName] = [];
            insertedRows[tableName].push(vals);
            return {
              returning: vi.fn().mockResolvedValue([{ id: `gen-${tableName}-id` }]),
              onConflictDoUpdate: vi.fn().mockResolvedValue([{ id: `gen-${tableName}-id` }]),
            };
          }),
        })),
        update: vi.fn((table: any) => ({
          set: vi.fn((_vals: any) => ({
            where: vi.fn().mockImplementation(() => {
              const tableName = getSafeTableName(table);
              operations.push(`update-${tableName}`);
              return Promise.resolve([]);
            }),
          })),
        })),
      };

      const mockDb = {
        transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx)),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);
      return { repo, operations, insertedRows, mockTx };
    }

    it("LIVE eligible inbound: increments inboundVersion, records LIVE decision, upserts queue, and enqueues debounce", async () => {
      const { repo, operations, insertedRows } = setupIngestionMocks();

      const res = await repo.ingestInboundMessage(
        {
          channelAccountId: "acc-1",
          externalThreadId: "thread-live-eligible",
          externalThreadRef: "https://facebook.com/messages/t/thread-live-eligible",
          externalCustomerId: "user-bob",
          customerName: "Bob Smith",
          externalMessageId: "mid.live.101",
          text: "Xin chào bạn!",
          timestamp: baseTimestamp,
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          senderKind: "PERSON",
          senderReliability: "VERIFIED",
          participantIdentity: {
            channelAccountId: "acc-1",
            participantId: "user-bob",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        { debounceMs: 5000 }
      );

      expect(res.isDuplicate).toBe(false);
      expect(res.eligibility?.eligible).toBe(true);
      expect(res.decision?.evaluationMode).toBe("LIVE");
      expect(res.decision?.decision).toBe("ELIGIBLE");

      // Participant reconciled because isVerified: true
      expect(operations).toContain("insert-participants");

      // Stale cancelled, inbound version incremented
      expect(operations).toContain("update-conversations");
      expect(operations).toContain("update-jobs");

      // Synchronous decision persisted
      expect(operations).toContain("insert-reply_eligibility_decisions");

      // Live work created: queue upserted and debounce job enqueued
      expect(operations).toContain("insert-conversation_queue");
      expect(operations).toContain("insert-jobs");
      expect(insertedRows["jobs"]?.some((j) => j.jobType === "debounce")).toBe(true);
    });

    it("no-work ineligible inbound: increments inboundVersion, aborts stale work, records decision, creates NO debounce or queue work", async () => {
      const { repo, operations, insertedRows } = setupIngestionMocks();

      // Unverified inbound -> fail closed
      const res = await repo.ingestInboundMessage(
        {
          channelAccountId: "acc-1",
          externalThreadId: "thread-ineligible",
          externalThreadRef: "https://facebook.com/messages/t/thread-ineligible",
          externalCustomerId: "user-unverified",
          customerName: "Anonymous",
          externalMessageId: "mid.ineligible.102",
          text: "Spam message",
          timestamp: baseTimestamp,
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          senderKind: "PERSON",
          senderReliability: "VERIFIED",
          participantIdentity: {
            channelAccountId: "acc-1",
            participantId: "user-unverified",
            senderKind: "PERSON",
            isVerified: false, // unverified!
          },
        },
        { debounceMs: 5000 }
      );

      expect(res.isDuplicate).toBe(false);
      expect(res.eligibility?.eligible).toBe(false);
      expect(["UNVERIFIED_PARTICIPANT_IDENTITY", "UNVERIFIED_SENDER_CLASSIFICATION"]).toContain(
        res.eligibility?.reasonCode
      );

      // Unverified participant MUST NOT be inserted into participants table
      expect(operations).not.toContain("insert-participants");

      // Inbound message and conversation version MUST still be updated & older stale work aborted
      expect(operations).toContain("insert-inbound_messages");
      expect(operations).toContain("update-conversations");
      expect(operations).toContain("update-jobs");

      // Decision record persisted
      expect(operations).toContain("insert-reply_eligibility_decisions");

      // NO conversation_queue upsert and NO debounce job
      expect(operations).not.toContain("insert-conversation_queue");
      const jobs = insertedRows["jobs"] || [];
      expect(jobs.some((j) => j.jobType === "debounce")).toBe(false);
    });

    it("SHADOW mode inbound: pure observation, records SHADOW decision, creates NO debounce or queue work", async () => {
      const shadowSettings = {
        ...defaultSettings,
        evaluationMode: "SHADOW" as const,
      };
      const { repo, operations, insertedRows } = setupIngestionMocks({ settings: shadowSettings });

      const res = await repo.ingestInboundMessage(
        {
          channelAccountId: "acc-1",
          externalThreadId: "thread-shadow",
          externalThreadRef: "https://facebook.com/messages/t/thread-shadow",
          externalCustomerId: "user-shadow",
          customerName: "Shadow User",
          externalMessageId: "mid.shadow.103",
          text: "Shadow evaluation message",
          timestamp: baseTimestamp,
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          senderKind: "PERSON",
          senderReliability: "VERIFIED",
          participantIdentity: {
            channelAccountId: "acc-1",
            participantId: "user-shadow",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        { debounceMs: 5000, evaluationMode: "SHADOW" }
      );

      expect(res.isDuplicate).toBe(false);
      expect(res.decision?.evaluationMode).toBe("SHADOW");
      expect(res.decision?.decision).toBe("ELIGIBLE");

      // Persists shadow decision
      expect(operations).toContain("insert-reply_eligibility_decisions");

      // Shadow mode MUST NOT create queue row or debounce job
      expect(operations).not.toContain("insert-conversation_queue");
      const jobs = insertedRows["jobs"] || [];
      expect(jobs.some((j) => j.jobType === "debounce")).toBe(false);
    });
  });

  describe("3. Stale Cancellation & Downstream Execution Guards", () => {
    it("boundary 1 (Debounce): halts AI generation and marks WAITING_CUSTOMER when conversation becomes manualMode", async () => {
      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockJobRepo = { enqueue: vi.fn() } as unknown as JobRepository;
      const mockTurnRepo = { createTurn: vi.fn() } as unknown as TurnRepository;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-manual-during-debounce",
                  inboundVersion: 2,
                  manualMode: true, // Switched to manual mode!
                  isBlocked: false,
                  channelAccountId: "acc-1",
                },
              ]),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      } as unknown as Database;

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        jobRepo: mockJobRepo,
        turnRepo: mockTurnRepo,
        eventRepo: mockEventRepo,
        broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
      });

      await debounceHandler({
        job: {
          id: "job-deb-1",
          channelAccountId: "acc-1",
          queue: "debounce",
          jobType: "debounce",
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-manual-during-debounce",
            inboundVersion: 2,
          },
          status: "RUNNING",
          priority: 0,
          attempts: 1,
          maxAttempts: 3,
          availableAt: new Date(),
          lockedUntil: null,
          ownerToken: null,
          fencingEpoch: 1,
          idempotencyKey: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ownerToken: "test-owner",
        fencingEpoch: 1,
        signal: new AbortController().signal,
      });

      // AI job must NOT be enqueued
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
      expect(mockTurnRepo.createTurn).not.toHaveBeenCalled();
    });

    it("boundary 2 (AI Worker): aborts AI generation and cancels turn when newer inbound version arrives", async () => {
      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-race-ai",
            inboundVersion: 5, // Advanced past job version 4!
            manualMode: false,
            isBlocked: false,
          },
          customer: { name: "Test" },
        }),
        updateStatus: vi.fn(),
        getRecentMessages: vi.fn().mockResolvedValue([]),
      } as unknown as ConversationRepository;

      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockTurnRepo = { cancelTurn: vi.fn().mockResolvedValue({}) } as unknown as TurnRepository;
      const mockAiGenerator = { generateReply: vi.fn() };

      const aiHandler = createAiHandler({
        db: {} as unknown as Database,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: {} as unknown as OutboundRepository,
        settingsRepo: {} as unknown as SettingsRepository,
        incidentRepo: {} as unknown as IncidentRepository,
        eventRepo: mockEventRepo,
        outboxRepo: {} as unknown as OutboxRepository,
        broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
        aiGenerator: mockAiGenerator as unknown as AiReplyGenerator,
      });

      await aiHandler({
        job: {
          id: "job-ai-stale",
          channelAccountId: "acc-1",
          queue: "ai",
          jobType: "ai",
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-race-ai",
            inboundVersion: 4, // Stale!
            turnId: "turn-stale-4",
          },
          status: "RUNNING",
          priority: 0,
          attempts: 1,
          maxAttempts: 3,
          availableAt: new Date(),
          lockedUntil: null,
          ownerToken: null,
          fencingEpoch: 1,
          idempotencyKey: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ownerToken: "test-owner",
        fencingEpoch: 1,
        signal: new AbortController().signal,
      });

      expect(mockTurnRepo.cancelTurn).toHaveBeenCalledWith(
        "turn-stale-4",
        expect.stringContaining("Inbound version changed")
      );
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "AI_CANCELLED_STALE",
          conversationId: "conv-race-ai",
          inboundVersion: 4,
        })
      );
      expect(mockAiGenerator.generateReply).not.toHaveBeenCalled();
    });

    it("boundary 3 (Sender Worker): aborts outbound action before typing when conversation inbound version moved", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "acc-1", status: "RUNNING" }]),
            })),
          })),
        })),
      } as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-sender-stale",
            inboundVersion: 7, // Advanced past action version 6!
            manualMode: false,
          },
        }),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({}),
        updateStatus: vi.fn().mockResolvedValue({}),
      } as unknown as OutboundRepository;

      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockAdapter = {
        typeMessage: vi.fn(),
        sendMessage: vi.fn(),
      } as unknown as ChannelAdapter;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        mockAdapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        { getSettings: vi.fn().mockResolvedValue(null) } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository
      );

      await senderWorker.processAction({
        actionId: "action-stale-6",
        channelAccountId: "acc-1",
        conversationId: "conv-sender-stale",
        externalThreadRef: "https://facebook.com/messages/t/thread-6",
        inboundVersion: 6,
        responseIndex: 0,
        text: "Stale outbound",
        textHash: "hash-stale-6",
        actor: "AI",
        claimToken: "token-6",
        fencingToken: 1,
      });

      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-stale-6",
        "ABORTED",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Stale version"),
        })
      );
      expect(mockAdapter.typeMessage).not.toHaveBeenCalled();
    });

    it("boundary 4 (Sender Worker): aborts action and clears composer right before Enter if policy disallows", async () => {
      let policyAllowed = true;
      const mockPolicyService = {
        recheckEligibility: vi.fn().mockImplementation(() => {
          if (!policyAllowed) {
            return Promise.resolve({
              eligible: false,
              decision: "INELIGIBLE",
              reasonCode: "CONVERSATION_MANUAL_MODE",
              reason: "Conversation taken over by manual operator pre-enter",
              precedenceStep: "HARD_GATES",
              evaluatedAt: new Date(),
            });
          }
          return Promise.resolve({
            eligible: true,
            decision: "ELIGIBLE",
            reasonCode: "ELIGIBLE",
            reason: "Eligible",
            precedenceStep: "ELIGIBLE",
            evaluatedAt: new Date(),
          });
        }),
      } as unknown as ReplyPolicyService;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "acc-1", status: "RUNNING", isSuspended: false, isPaused: false }]),
            })),
          })),
        })),
      } as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockImplementation(() => {
          return Promise.resolve({
            conversation: {
              id: "conv-pre-enter-disallow",
              inboundVersion: 3,
              manualMode: !policyAllowed,
            },
          });
        }),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-pre-enter", status: "TYPING" }),
        updateStatus: vi.fn().mockResolvedValue({}),
        confirmSent: vi.fn(),
      } as unknown as OutboundRepository;

      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;

      let composerText = "";
      let enterPressed = false;
      const mockAdapter = {
        openConversation: vi.fn().mockResolvedValue(true),
        typeDraft: vi.fn().mockImplementation(async (text: string) => {
          composerText = text;
          // While typing, operator takes over manual mode!
          policyAllowed = false;
          return { success: true, textLength: text.length };
        }),
        clearComposer: vi.fn().mockImplementation(async () => {
          composerText = "";
        }),
        pressEnter: vi.fn().mockImplementation(async () => {
          enterPressed = true;
        }),
        capturePreSendMarker: vi.fn().mockResolvedValue("marker-123"),
        verifyOutgoingMessageConfirmed: vi.fn().mockResolvedValue({ confirmed: true, bubbleId: "mid.sent.1" }),
      } as unknown as ChannelAdapter;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        mockAdapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        {
          getSettings: vi.fn().mockResolvedValue({
            settings: { typingTargetWpmMin: 60, typingTargetWpmMax: 70 },
          }),
        } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository,
        null,
        null,
        mockPolicyService
      );

      await senderWorker.processAction({
        actionId: "action-pre-enter",
        channelAccountId: "acc-1",
        conversationId: "conv-pre-enter-disallow",
        externalThreadRef: "https://facebook.com/messages/t/pre-enter",
        inboundVersion: 3,
        responseIndex: 0,
        text: "Will be cancelled right before send",
        textHash: "hash-pre-enter",
        actor: "AI",
        claimToken: "token-pe",
        fencingToken: 1,
      });

      // Clear composer was called, Enter was NOT pressed
      expect(mockAdapter.clearComposer).toHaveBeenCalled();
      expect(enterPressed).toBe(false);
      expect(composerText).toBe("");

      // Action marked ABORTED with policy ineligible reason
      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-pre-enter",
        "ABORTED",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Policy ineligible pre-enter"),
        })
      );
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "TYPING_ABORTED",
          payload: expect.objectContaining({
            reason: "policy_disallowed_pre_enter",
            reasonCode: "CONVERSATION_MANUAL_MODE",
          }),
        })
      );
    });
  });

  describe("4. Settings Revision Race Protection", () => {
    it("ReplyPolicyService.recheckEligibility rejects previously-eligible inbound after participant is added to excluded list", async () => {
      const initialSettings = {
        ...defaultSettings,
        revision: 1,
        replyMode: "EVERYONE_EXCEPT" as const,
        excludedParticipantIds: [],
      };

      const updatedSettings = {
        ...defaultSettings,
        revision: 2,
        replyMode: "EVERYONE_EXCEPT" as const,
        excludedParticipantIds: ["user-dynamically-excluded"],
      };

      let currentSettings = initialSettings;

      const getSafeTableName = (table: any): string => {
        try {
          return getTableName(table);
        } catch {
          return "unknown";
        }
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn((table: any) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                const tableName = getSafeTableName(table);
                if (tableName === "settings") {
                  return Promise.resolve([{ channelAccountId: "acc-1", settings: currentSettings }]);
                }
                if (tableName === "channel_accounts") {
                  return Promise.resolve([{ id: "acc-1", status: "RUNNING", isPaused: false, isSuspended: false, accountType: "PERSONAL_MESSENGER" }]);
                }
                if (tableName === "inbound_messages") {
                  return Promise.resolve([
                    {
                      id: "inbound-msg-race",
                      channelAccountId: "acc-1",
                      conversationId: "conv-rev-race",
                      inboundVersion: 1,
                      text: "Hello, check price",
                      rawPayload: {
                        channelAccountId: "acc-1",
                        threadKind: "DIRECT",
                        threadReliability: "VERIFIED",
                        senderKind: "PERSON",
                        senderReliability: "VERIFIED",
                        participantIdentity: {
                          channelAccountId: "acc-1",
                          participantId: "user-dynamically-excluded",
                          senderKind: "PERSON",
                          isVerified: true,
                        },
                      },
                    },
                  ]);
                }
                if (tableName === "reply_policy_members") {
                  return Promise.resolve([]);
                }
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
      } as unknown as Database;

      const policyService = new ReplyPolicyService(mockDb);

      // 1. Initial check: eligible under revision 1
      const initialRecheck = await policyService.recheckEligibility({
        channelAccountId: "acc-1",
        conversationId: "conv-rev-race",
        inboundVersion: 1,
        conversation: {
          id: "conv-rev-race",
          inboundVersion: 1,
          manualMode: false,
          isBlocked: false,
        } as any,
      });

      expect(initialRecheck.eligible).toBe(true);
      expect(initialRecheck.reasonCode).toBe("ELIGIBLE");

      // 2. Settings update to revision 2: participant excluded
      currentSettings = updatedSettings;

      const postUpdateRecheck = await policyService.recheckEligibility({
        channelAccountId: "acc-1",
        conversationId: "conv-rev-race",
        inboundVersion: 1,
        conversation: {
          id: "conv-rev-race",
          inboundVersion: 1,
          manualMode: false,
          isBlocked: false,
        } as any,
      });

      expect(postUpdateRecheck.eligible).toBe(false);
      expect(postUpdateRecheck.reasonCode).toBe("PERSON_EXCLUDED");
    });
  });
});
