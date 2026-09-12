import { describe, it, expect, vi } from "vitest";
import { SystemSettingsDefaults } from "../packages/contracts/src/settings.js";
import { evaluateContentDisposition } from "../packages/contracts/src/policy.js";
import { buildChatMessages } from "../packages/ai/src/persona.js";
import { validateAiOutput } from "../packages/ai/src/guards.js";
import { createAiHandler } from "../apps/core/src/jobs/handlers/ai.js";
import { createDebounceHandler } from "../apps/core/src/jobs/handlers/debounce.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import { OutboundRepository } from "../packages/db/src/repository/outbound-repo.js";
import type {
  Database,
  ConversationRepository,
  OutboundRepository as OutboundRepoType,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
  TurnRepository,
  OutboxRepository,
  JobRepository,
  JobExecutionContext,
  AiConfigRepository,
  ReplyPolicyService,
} from "../packages/db/src/index.js";
import type { ChannelAdapter } from "@messenger/channel";
import type { AiReplyGenerator } from "@messenger/ai";
import type { OutboundJobPayload } from "@messenger/contracts";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";

describe("Human Priority & Anti-Bot Collision (Uu Tien Nguoi That)", () => {
  describe("Phase 1: Defaults & Persona Consolidation", () => {
    it("enforces default aiMaxResponseCount=1 and debounceMs=8000", () => {
      expect(SystemSettingsDefaults.aiMaxResponseCount).toBe(1);
      expect(SystemSettingsDefaults.debounceMs).toBe(8000);
    });

    it("persona prompts single consolidated message and forbids splitting", () => {
      const messages = buildChatMessages({
        settings: {
          ...SystemSettingsDefaults,
          aiSystemPersona: "Test CSKH",
          businessProfile: "Test Shop",
        },
        recentMessages: [
          {
            role: "user",
            text: "Shop có áo sơ mi trắng size L không?",
            timestamp: new Date(),
          },
        ],
      });

      const systemPrompt = messages[0]?.content || "";
      expect(systemPrompt).toContain("GỘP TOÀN BỘ nội dung trả lời chính");
      expect(systemPrompt).toContain("DUY NHẤT 1 TIN NHẮN");
      expect(systemPrompt).not.toContain("Tin nhắn 2 (tách riêng)");
    });
  });

  describe("Phase 1: Post-AI Gate (Discard AI output if human intervened during generation)", () => {
    it("discards AI output and does NOT create action if manualMode became true during AI call", async () => {
      let callCount = 0;
      const mockConvRepo = {
        getConversationById: vi.fn().mockImplementation(async () => {
          callCount++;
          // First call: initial check before AI generation (AUTO mode)
          if (callCount === 1) {
            return {
              conversation: {
                id: "conv-1",
                inboundVersion: 1,
                manualMode: false,
                isBlocked: false,
                status: "WAITING_CUSTOMER",
                externalThreadRef: "https://m.me/test",
              },
              customer: { name: "Khách test" },
            };
          }
          // Second call (post-generation gate): Human intervened while AI was thinking!
          return {
            conversation: {
              id: "conv-1",
              inboundVersion: 1,
              manualMode: true,
              isBlocked: false,
              status: "MANUAL",
              externalThreadRef: "https://m.me/test",
            },
            customer: { name: "Khách test" },
          };
        }),
        updateStatus: vi.fn(),
        getRecentMessages: vi.fn().mockResolvedValue([]),
      } as unknown as ConversationRepository;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockTurnRepo = {
        claimTurn: vi.fn().mockResolvedValue({ id: "turn-1", fencingEpoch: 1 }),
        cancelTurn: vi.fn().mockResolvedValue({}),
      } as unknown as TurnRepository;

      const mockOutboundRepo = {
        createAction: vi.fn(),
      } as unknown as OutboundRepoType;

      const mockJobRepo = {
        enqueue: vi.fn(),
      } as unknown as JobRepository;

      const mockAiGenerator = {
        generateReply: vi.fn().mockResolvedValue({
          success: true,
          data: {
            messages: ["Dạ shop còn size L bạn nhé!"],
            needsClarification: false,
          },
        }),
      } as unknown as AiReplyGenerator;

      const aiHandler = createAiHandler({
        db: {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "run-1" }]),
            })),
          })),
        } as unknown as Database,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: mockOutboundRepo,
        settingsRepo: {
          getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }),
        } as unknown as SettingsRepository,
        incidentRepo: {} as unknown as IncidentRepository,
        eventRepo: mockEventRepo,
        outboxRepo: { enqueue: vi.fn().mockResolvedValue({}) } as unknown as OutboxRepository,
        broadcaster: { broadcast: vi.fn().mockResolvedValue({}) } as unknown as OutboxBroadcaster,
        aiGenerator: mockAiGenerator,
        aiConfigRepo: {
          getConfig: vi.fn().mockResolvedValue({ apiKey: "test" }),
          getResolvedConfig: vi.fn().mockResolvedValue({ apiKey: "test" }),
        } as unknown as AiConfigRepository,
        jobRepo: mockJobRepo,
        replyPolicyService: { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService,
      });

      await aiHandler({
        job: {
          id: "job-1",
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-1",
            inboundVersion: 1,
            turnId: "turn-1",
          },
        },
        ownerToken: "worker-1",
        signal: new AbortController().signal,
      } as unknown as JobExecutionContext);

      // Verify turn cancelled, event recorded, but NO outbound action created or enqueued!
      expect(mockTurnRepo.cancelTurn).toHaveBeenCalledWith(
        "turn-1",
        "Cancelled due to human takeover or stale version"
      );
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "AI_CANCELLED_STALE",
          payload: expect.objectContaining({ reason: "HUMAN_TAKEOVER" }),
        })
      );
      expect(mockOutboundRepo.createAction).not.toHaveBeenCalled();
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("Phase 1 & 2: Pre-Send Gate & External Outbound Abort in Sender Worker", () => {
    it("aborts typing, clears composer, and cancels action if manualMode entered before send", async () => {
      let currentManualMode = false;

      const mockConvRepo = {
        getConversationById: vi.fn().mockImplementation(async () => {
          return {
            conversation: {
              id: "conv-send-1",
              inboundVersion: 2,
              manualMode: currentManualMode,
              status: currentManualMode ? "MANUAL" : "WAITING_CUSTOMER",
              externalThreadRef: "thread-123",
            },
          };
        }),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-1" }),
        updateStatus: vi.fn().mockResolvedValue({}),
      } as unknown as OutboundRepoType;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockAdapter = {
        openConversation: vi.fn().mockResolvedValue(true),
        typeDraft: vi.fn().mockImplementation(async () => {
          // While typing is occurring, the operator activates manual mode!
          currentManualMode = true;
          return { completed: true };
        }),
        clearComposer: vi.fn().mockResolvedValue(undefined),
        sendDraft: vi.fn().mockResolvedValue({ sent: true }),
        verifySent: vi.fn().mockResolvedValue({ verified: true }),
        capturePreSendMarker: vi.fn().mockResolvedValue("marker-1"),
      } as unknown as ChannelAdapter;

      const mockReplyPolicy = {
        recheckEligibility: vi.fn().mockImplementation(async ({ conversation }) => {
          if (conversation?.manualMode) {
            return {
              eligible: false,
              decision: "INELIGIBLE",
              reasonCode: "CONVERSATION_MANUAL_MODE",
              reason: "Conversation is in manual operator mode.",
            };
          }
          return { eligible: true };
        }),
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                { id: "acc-1", status: "RUNNING", isSuspended: false, isPaused: false },
              ]),
            })),
          })),
        })),
      } as unknown as Database;

      const senderService = new SenderWorkerService(
        mockDb,
        null,
        mockAdapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        {
          getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }),
        } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository,
        {} as unknown as JobRepository,
        undefined,
        mockReplyPolicy as unknown as ReplyPolicyService
      );

      const payload: OutboundJobPayload = {
        actionId: "action-send-1",
        channelAccountId: "acc-1",
        conversationId: "conv-send-1",
        externalThreadRef: "thread-123",
        inboundVersion: 2,
        responseIndex: 0,
        text: "Tin nhắn tự động của bot",
        textHash: "hash123",
        actor: "AI",
      };

      await senderService.processAction(payload);

      // Verify composer was cleared and sendDraft was NEVER called!
      expect(mockAdapter.clearComposer).toHaveBeenCalled();
      expect(mockAdapter.sendDraft).not.toHaveBeenCalled();
      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-send-1",
        "ABORTED",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Policy ineligible pre-enter"),
        })
      );
    });

    it("aborts typing and sets human hold if external human message appeared in active thread right before Enter", async () => {
      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-ext-1",
            inboundVersion: 3,
            manualMode: false,
            status: "WAITING_CUSTOMER",
            externalThreadRef: "thread-ext",
          },
        }),
        setHumanHold: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-ext-1" }),
        updateStatus: vi.fn().mockResolvedValue({}),
      } as unknown as OutboundRepoType;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockAdapter = {
        openConversation: vi.fn().mockResolvedValue(true),
        typeDraft: vi.fn().mockResolvedValue({ completed: true }),
        clearComposer: vi.fn().mockResolvedValue(undefined),
        sendDraft: vi.fn().mockResolvedValue({ sent: true }),
        verifySent: vi.fn().mockResolvedValue({ verified: true }),
        capturePreSendMarker: vi.fn().mockResolvedValue("marker-ext"),
        checkLastBubbleIsExternalOutbound: vi.fn().mockResolvedValue(true), // Human sent message right before Enter!
      } as unknown as ChannelAdapter;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                { id: "acc-1", status: "RUNNING", isSuspended: false, isPaused: false },
              ]),
            })),
          })),
        })),
      } as unknown as Database;

      const senderService = new SenderWorkerService(
        mockDb,
        null,
        mockAdapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        {
          getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }),
        } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository,
        {} as unknown as JobRepository,
        undefined,
        { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService
      );

      const payload: OutboundJobPayload = {
        actionId: "action-ext-1",
        channelAccountId: "acc-1",
        conversationId: "conv-ext-1",
        externalThreadRef: "thread-ext",
        inboundVersion: 3,
        responseIndex: 0,
        text: "Bot reply",
        textHash: "hash-ext",
        actor: "AI",
      };

      await senderService.processAction(payload);

      expect(mockAdapter.clearComposer).toHaveBeenCalled();
      expect(mockAdapter.sendDraft).not.toHaveBeenCalled();
      expect(mockConvRepo.setHumanHold).toHaveBeenCalledWith("conv-ext-1", 30 * 60 * 1000);
      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-ext-1",
        "ABORTED",
        expect.objectContaining({
          errorMessage: expect.stringContaining("External human message appeared"),
        })
      );
    });
  });

  describe("Phase 1: Action ID Uniqueness & Manual Send Idempotency", () => {
    it("generates distinct actionIds for manual sends vs AI sends even with identical parameters", () => {
      const aiId = OutboundRepository.computeActionId("acc-1", "conv-1", 5, 0);
      const manualId1 = OutboundRepository.computeActionId("acc-1", "conv-1", 5, 0, "MANUAL_OWNER:intent-1");
      const manualId2 = OutboundRepository.computeActionId("acc-1", "conv-1", 5, 0, "MANUAL_OWNER:intent-2");

      expect(manualId1).not.toBe(aiId);
      expect(manualId2).not.toBe(aiId);
      expect(manualId1).not.toBe(manualId2);
    });
  });

  describe("Phase 3: Debounce & Human Hold Expiry (No Replay)", () => {
    it("skips debounce when conversation is within active human hold", async () => {
      const activeHoldUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 mins left
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-hold-1",
                  inboundVersion: 4,
                  manualMode: true,
                  isBlocked: false,
                  humanHoldUntil: activeHoldUntil,
                  suppressedThroughInboundVersion: 4,
                },
              ]),
            })),
          })),
        })),
        update: vi.fn(),
      } as unknown as Database;

      const mockJobRepo = { enqueue: vi.fn() } as unknown as JobRepository;
      const mockTurnRepo = { createOrGetTurn: vi.fn() } as unknown as TurnRepository;

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: {} as unknown as OutboxRepository,
        eventRepo: {} as unknown as EventRepository,
        broadcaster: {} as unknown as OutboxBroadcaster,
      });

      await debounceHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-hold-1",
            inboundVersion: 4,
          },
        },
      } as unknown as JobExecutionContext);

      // Verify no turn created and no AI job enqueued
      expect(mockTurnRepo.createOrGetTurn).not.toHaveBeenCalled();
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
    });

    it("suppresses replay of old inbound when human hold expired but inbound <= watermark", async () => {
      const expiredHoldUntil = new Date(Date.now() - 5 * 60 * 1000); // expired 5 mins ago
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-hold-2",
                  inboundVersion: 4,
                  manualMode: true,
                  isBlocked: false,
                  humanHoldUntil: expiredHoldUntil,
                  suppressedThroughInboundVersion: 4, // Watermark is 4, inbound is 4
                },
              ]),
            })),
          })),
        })),
        update: vi.fn(),
      } as unknown as Database;

      const mockJobRepo = { enqueue: vi.fn() } as unknown as JobRepository;
      const mockTurnRepo = { createOrGetTurn: vi.fn() } as unknown as TurnRepository;

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: {} as unknown as OutboxRepository,
        eventRepo: {} as unknown as EventRepository,
        broadcaster: {} as unknown as OutboxBroadcaster,
      });

      await debounceHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-hold-2",
            inboundVersion: 4,
          },
        },
      } as unknown as JobExecutionContext);

      expect(mockTurnRepo.createOrGetTurn).not.toHaveBeenCalled();
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
    });

    it("resumes AI reply when human hold expired and customer sent a new inbound (inbound > watermark)", async () => {
      const expiredHoldUntil = new Date(Date.now() - 5 * 60 * 1000); // expired 5 mins ago
      let updatedConversation = false;

      const mockDb = {
        select: vi.fn((_selector) => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(async () => {
                // First call: fetch conv
                // Second call: channelAccounts
                return [
                  {
                    id: "conv-hold-3",
                    inboundVersion: 5, // Strictly newer than suppressed watermark 4!
                    manualMode: true,
                    isBlocked: false,
                    humanHoldUntil: expiredHoldUntil,
                    suppressedThroughInboundVersion: 4,
                    status: "RUNNING",
                    isPaused: false,
                    isSuspended: false,
                  },
                ];
              }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => {
              updatedConversation = true;
              return {
                returning: vi.fn().mockResolvedValue([
                  {
                    id: "conv-hold-3",
                    inboundVersion: 5,
                    status: "THINKING",
                  },
                ]),
              };
            }),
          })),
        })),
      } as unknown as Database;

      const mockJobRepo = { enqueue: vi.fn().mockResolvedValue({}) } as unknown as JobRepository;
      const mockTurnRepo = {
        createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-resumed" }),
      } as unknown as TurnRepository;
      const mockOutboxRepo = { enqueue: vi.fn().mockResolvedValue({}) } as unknown as OutboxRepository;
      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockBroadcaster = { broadcast: vi.fn().mockResolvedValue({}) } as unknown as OutboxBroadcaster;

      const mockReplyPolicy = {
        recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }),
      };

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: mockOutboxRepo,
        eventRepo: mockEventRepo,
        broadcaster: mockBroadcaster,
        replyPolicyService: mockReplyPolicy as unknown as ReplyPolicyService,
      });

      await debounceHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-hold-3",
            inboundVersion: 5,
          },
        },
      } as unknown as JobExecutionContext);

      // Verify that hold was cleared, turn was created, and AI job was scheduled!
      expect(updatedConversation).toBe(true);
      expect(mockTurnRepo.createOrGetTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-hold-3",
          inboundVersion: 5,
        })
      );
      expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: "ai",
          jobType: "ai",
          payload: expect.objectContaining({
            conversationId: "conv-hold-3",
            inboundVersion: 5,
          }),
        })
      );
    });
  });

  describe("PR-05: Content Disposition under Hard Gates", () => {
    it("respects hard gates (isBlocked, controlMode, direction) before evaluating content", () => {
      // 1. Blocked
      expect(
        evaluateContentDisposition({
          isBlocked: true,
          text: "Shop có áo sơ mi trắng không?",
        })
      ).toEqual({ action: "SKIP", reasonCode: "CONVERSATION_BLOCKED" });

      // 2. Manual mode
      expect(
        evaluateContentDisposition({
          controlMode: "MANUAL",
          text: "Shop có áo sơ mi trắng không?",
        })
      ).toEqual({ action: "SKIP", reasonCode: "CONVERSATION_MANUAL_MODE" });

      // 3. Outbound direction
      expect(
        evaluateContentDisposition({
          direction: "OUTBOUND",
          text: "Chào bạn",
        })
      ).toEqual({ action: "SKIP", reasonCode: "DIRECTION_NOT_INBOUND" });
    });

    it("skips non-message events (reaction, delivery, presence, thread update, system notice)", () => {
      expect(evaluateContentDisposition({ eventKind: "REACTION_CHANGED" })).toEqual({
        action: "SKIP",
        reasonCode: "REACTION_ONLY",
      });

      for (const eventKind of ["DELIVERY_UPDATED", "PRESENCE_CHANGED", "THREAD_UPDATED", "SYSTEM_NOTICE"]) {
        expect(evaluateContentDisposition({ eventKind })).toEqual({
          action: "SKIP",
          reasonCode: "NON_MESSAGE_EVENT",
        });
      }

      expect(evaluateContentDisposition({ eventKind: "MESSAGE_UNSENT" })).toEqual({
        action: "SKIP",
        reasonCode: "CONTENT_UNAVAILABLE",
      });
    });

    it("evaluates content readiness and status transitions (pending, unsupported, quarantined, unavailable)", () => {
      const now = new Date("2026-09-07T12:00:00.000Z");

      // Pending media: DEFER with bounded deadline
      const deferRes = evaluateContentDisposition({
        contentStatus: "PENDING",
        hasMedia: true,
        now,
        deadlineMs: 3000,
      });
      expect(deferRes.action).toBe("DEFER");
      expect(deferRes.reasonCode).toBe("CONTENT_NOT_READY");
      if (deferRes.action === "DEFER") {
        expect(deferRes.deadlineAt).toBe(new Date("2026-09-07T12:00:03.000Z").toISOString());
      }

      // Unsupported format -> HANDOFF
      expect(evaluateContentDisposition({ contentStatus: "UNSUPPORTED" })).toEqual({
        action: "HANDOFF",
        reasonCode: "CONTENT_UNSUPPORTED",
      });

      // Quarantined -> HANDOFF with PARSE_UNCERTAIN
      expect(evaluateContentDisposition({ contentStatus: "QUARANTINED" })).toEqual({
        action: "HANDOFF",
        reasonCode: "PARSE_UNCERTAIN",
      });

      // Unavailable -> SKIP
      expect(evaluateContentDisposition({ contentStatus: "UNAVAILABLE" })).toEqual({
        action: "SKIP",
        reasonCode: "CONTENT_UNAVAILABLE",
      });
    });

    it("filters trivial acknowledgments without media (ok, cảm ơn, vâng) as NO_RESPONSE_NEEDED", () => {
      const acks = ["ok", "oki", "dạ ok", "cảm ơn ạ", "thanks", "vâng ạ", "dạ!"];
      for (const text of acks) {
        expect(evaluateContentDisposition({ text, hasMedia: false })).toEqual({
          action: "SKIP",
          reasonCode: "NO_RESPONSE_NEEDED",
        });
      }

      // If media is present with "ok", it should NOT be skipped as trivial
      expect(evaluateContentDisposition({ text: "ok", hasMedia: true })).toEqual({
        action: "GENERATE",
        reasonCode: "MEDIA_READY",
      });
    });

    it("clarification idempotency: media-only triggers CLARIFY once, then SKIPs subsequent calls", () => {
      const first = evaluateContentDisposition({
        hasMedia: true,
        text: "",
        clarificationSent: false,
      });
      expect(first.action).toBe("CLARIFY");
      expect(first.reasonCode).toBe("CONTENT_NOT_READY");

      const second = evaluateContentDisposition({
        hasMedia: true,
        text: "",
        clarificationSent: true,
      });
      expect(second.action).toBe("SKIP");
      expect(second.reasonCode).toBe("CLARIFICATION_ALREADY_SENT");
    });
  });

  describe("PR-05: AI Decision Union & Anti-Hang Behavior", () => {
    it("normalizes action-based decisions (SKIP, NO_REPLY, HANDOFF, CLARIFY) in validateAiOutput", () => {
      // 1. SKIP / NO_REPLY
      const skipRes = validateAiOutput(JSON.stringify({ action: "SKIP", reasonCode: "NO_RESPONSE_NEEDED" }));
      expect(skipRes.valid).toBe(true);
      expect(skipRes.data?.action).toBe("SKIP");
      expect(skipRes.data?.messages).toEqual([]);

      // 2. Case insensitive action normalization (e.g. "handoff")
      const handoffRes = validateAiOutput(JSON.stringify({ action: "handoff", reasonCode: "COMPLEX_QUERY" }));
      expect(handoffRes.valid).toBe(true);
      expect(handoffRes.data?.action).toBe("HANDOFF");
      expect(handoffRes.data?.messages).toEqual([]);

      // 3. CLARIFY with promptText
      const clarifyRes = validateAiOutput(
        JSON.stringify({
          action: "CLARIFY",
          promptText: "Bạn cần hỗ trợ sản phẩm nào ạ?",
        })
      );
      expect(clarifyRes.valid).toBe(true);
      expect(clarifyRes.data?.action).toBe("CLARIFY");
      expect(clarifyRes.data?.messages).toEqual(["Bạn cần hỗ trợ sản phẩm nào ạ?"]);
    });

    it("AI Handler handles SKIP decision without hanging: completes turn CAS and transitions to WAITING_CUSTOMER", async () => {
      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-ai-skip",
            inboundVersion: 2,
            manualMode: false,
            isBlocked: false,
          },
          customer: { id: "cust-1", name: "Khách test" },
        }),
        getRecentMessages: vi.fn().mockResolvedValue([]),
        updateStatus: vi.fn().mockResolvedValue({}),
      } as unknown as ConversationRepository;

      const mockTurnRepo = {
        claimTurn: vi.fn().mockResolvedValue({ id: "turn-ai-skip", fencingEpoch: 2 }),
        completeTurn: vi.fn().mockResolvedValue({ id: "turn-ai-skip" }),
        transitionStatus: vi.fn().mockResolvedValue({ id: "turn-ai-skip" }),
      } as unknown as TurnRepository;

      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockOutboxRepo = { enqueue: vi.fn().mockResolvedValue({}) } as unknown as OutboxRepository;
      const mockBroadcaster = { broadcast: vi.fn().mockResolvedValue({}) } as unknown as OutboxBroadcaster;

      const mockGenerator: Partial<AiReplyGenerator> = {
        generateReply: vi.fn().mockResolvedValue({
          success: true,
          data: { action: "SKIP", reasonCode: "NO_RESPONSE_NEEDED", messages: [] },
          model: "mock-model",
        }),
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "run-uuid-1" }]),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "acc-1", status: "RUNNING" }]),
            })),
          })),
        })),
      } as unknown as Database;

      const aiHandler = createAiHandler({
        db: mockDb,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: {} as unknown as OutboundRepoType,
        settingsRepo: { getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }) } as unknown as SettingsRepository,
        aiConfigRepo: { getConfig: vi.fn().mockResolvedValue(null) } as unknown as AiConfigRepository,
        incidentRepo: {} as unknown as IncidentRepository,
        eventRepo: mockEventRepo,
        outboxRepo: mockOutboxRepo,
        jobRepo: {} as unknown as JobRepository,
        aiGenerator: mockGenerator as AiReplyGenerator,
        broadcaster: mockBroadcaster,
        replyPolicyService: { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService,
      });

      await aiHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-ai-skip",
            inboundVersion: 2,
            turnId: "turn-ai-skip",
          },
        },
        ownerToken: "token-ai",
        fencingEpoch: 1,
        signal: new AbortController().signal,
      } as unknown as JobExecutionContext);

      expect(mockTurnRepo.completeTurn).toHaveBeenCalledWith("turn-ai-skip");
      expect(mockConvRepo.updateStatus).toHaveBeenCalledWith("conv-ai-skip", "WAITING_CUSTOMER");
      expect(mockBroadcaster.broadcast).toHaveBeenCalledWith("conversation:status", expect.objectContaining({
        conversationId: "conv-ai-skip",
        status: "WAITING_CUSTOMER",
      }));
    });

    it("AI Handler handles zero-message output without hanging in DRAFT_READY", async () => {
      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-ai-empty",
            inboundVersion: 2,
            manualMode: false,
            isBlocked: false,
          },
          customer: { id: "cust-1", name: "Khách test" },
        }),
        getRecentMessages: vi.fn().mockResolvedValue([]),
        updateStatus: vi.fn().mockResolvedValue({}),
      } as unknown as ConversationRepository;

      const mockTurnRepo = {
        claimTurn: vi.fn().mockResolvedValue({ id: "turn-ai-empty", fencingEpoch: 2 }),
        completeTurn: vi.fn().mockResolvedValue({ id: "turn-ai-empty" }),
      } as unknown as TurnRepository;

      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockOutboxRepo = { enqueue: vi.fn().mockResolvedValue({}) } as unknown as OutboxRepository;
      const mockBroadcaster = { broadcast: vi.fn().mockResolvedValue({}) } as unknown as OutboxBroadcaster;

      const mockGenerator: Partial<AiReplyGenerator> = {
        generateReply: vi.fn().mockResolvedValue({
          success: true,
          data: { action: "REPLY", messages: [] },
          model: "mock-model",
        }),
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "run-uuid-1" }]),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "acc-1", status: "RUNNING" }]),
            })),
          })),
        })),
      } as unknown as Database;

      const aiHandler = createAiHandler({
        db: mockDb,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: {} as unknown as OutboundRepoType,
        settingsRepo: { getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }) } as unknown as SettingsRepository,
        aiConfigRepo: { getConfig: vi.fn().mockResolvedValue(null) } as unknown as AiConfigRepository,
        incidentRepo: {} as unknown as IncidentRepository,
        eventRepo: mockEventRepo,
        outboxRepo: mockOutboxRepo,
        jobRepo: {} as unknown as JobRepository,
        aiGenerator: mockGenerator as AiReplyGenerator,
        broadcaster: mockBroadcaster,
        replyPolicyService: { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService,
      });

      await aiHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-ai-empty",
            inboundVersion: 2,
            turnId: "turn-ai-empty",
          },
        },
        ownerToken: "token-ai",
        fencingEpoch: 1,
        signal: new AbortController().signal,
      } as unknown as JobExecutionContext);

      expect(mockTurnRepo.completeTurn).toHaveBeenCalledWith("turn-ai-empty");
      expect(mockConvRepo.updateStatus).toHaveBeenCalledWith("conv-ai-empty", "WAITING_CUSTOMER");
    });
  });

  describe("PR-05: Durable Outbound Identity & Baseline Takeover", () => {
    it("isBotOutbound returns true when externalMessageRef matches bot outbound action", async () => {
      const mockDb = {
        select: vi.fn((_sel) => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: "action-123" }]),
            })),
          })),
        })),
      } as unknown as Database;

      const outboundRepo = new OutboundRepository(mockDb);
      const isBot = await outboundRepo.isBotOutbound({
        channelAccountId: "acc-1",
        externalMessageRef: "mid.bot.123",
      });
      expect(isBot).toBe(true);
    });

    it("isBotOutbound returns false when externalMessageRef does not match and no matching text exists", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: "action-recent-ai" }]) })),
            })),
          })),
        })),
      } as unknown as Database;

      const outboundRepo = new OutboundRepository(mockDb);
      const isBot = await outboundRepo.isBotOutbound({
        channelAccountId: "acc-1",
        externalMessageRef: "mid.dom.stable-id",
        externalThreadId: "thread-1",
      });
      // Crucial P0 invariant: same-thread alone without matching ref or text must NEVER suppress customer messages
      expect(isBot).toBe(false);
    });

    it("isBotOutbound recognizes a recent AI action on the exact Messenger thread when normalized text matches", async () => {
      let query = 0;
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => {
            query++;
            if (query <= 2) {
              return {
                where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
              };
            }
            return {
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([{ id: "action-recent-ai", text: "Dạ shop còn hàng bạn nhé!" }]),
                })),
              })),
            };
          }),
        })),
      } as unknown as Database;

      const outboundRepo = new OutboundRepository(mockDb);
      const isBot = await outboundRepo.isBotOutbound({
        channelAccountId: "acc-1",
        externalMessageRef: "mid.dom.stable-id",
        externalThreadId: "thread-1",
        text: "Dạ shop còn hàng bạn nhé! 🥰",
      });
      expect(isBot).toBe(true);
    });

    it("isBotOutbound returns false when no match exists (confirms external human response)", async () => {
      const mockDb = {
        select: vi.fn((_sel) => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      } as unknown as Database;

      const outboundRepo = new OutboundRepository(mockDb);
      const isBot = await outboundRepo.isBotOutbound({
        channelAccountId: "acc-1",
        externalMessageRef: "mid.human.999",
        text: "Nhân viên đang trả lời nè",
      });
      expect(isBot).toBe(false);
    });
  });

  describe("PR-05: Debounce Clarification Idempotency", () => {
    it("sends clarification once for media-only inbound, sets clarificationSent: true", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-clarify-1",
                  inboundVersion: 3,
                  status: "RUNNING",
                  isPaused: false,
                  isSuspended: false,
                  isBlocked: false,
                  replyControlMode: "AUTO",
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

      const mockTurnRepo = {
        getTurnByVersion: vi.fn().mockResolvedValue(null),
        createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-clarify-1" }),
      } as unknown as TurnRepository;

      const mockOutboundRepo = {
        createAction: vi.fn().mockResolvedValue({ actionId: "action-clarify-1", textHash: "h1" }),
      } as unknown as OutboundRepoType;

      const mockJobRepo = { enqueue: vi.fn().mockResolvedValue({}) } as unknown as JobRepository;
      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
      const mockBroadcaster = { broadcast: vi.fn().mockResolvedValue({}) } as unknown as OutboxBroadcaster;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-clarify-1",
            inboundVersion: 3,
            manualMode: false,
            isBlocked: false,
            externalThreadRef: "thread-c1",
          },
        }),
        getRecentMessages: vi.fn().mockResolvedValue([
          {
            inboundVersion: 3,
            text: "",
            parts: [{ type: "IMAGE", media: { mediaId: "img-1" } }],
            contentStatus: "READY",
            contentRevision: 1,
          },
        ]),
      } as unknown as ConversationRepository;

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: {} as unknown as OutboxRepository,
        eventRepo: mockEventRepo,
        broadcaster: mockBroadcaster,
        replyPolicyService: { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService,
        convRepo: mockConvRepo,
        outboundRepo: mockOutboundRepo,
      });

      await debounceHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-clarify-1",
            inboundVersion: 3,
          },
        },
      } as unknown as JobExecutionContext);

      expect(mockTurnRepo.createOrGetTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ clarificationSent: true }),
        })
      );
      expect(mockOutboundRepo.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "AI",
          turnId: "turn-clarify-1",
        })
      );
      expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "BROWSER_SEND",
        })
      );
    });

    it("skips duplicate clarification if clarification was already sent for the turn", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-clarify-2",
                  inboundVersion: 3,
                  status: "RUNNING",
                  isPaused: false,
                  isSuspended: false,
                  isBlocked: false,
                  replyControlMode: "AUTO",
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

      const mockTurnRepo = {
        getTurnByVersion: vi.fn().mockResolvedValue({
          id: "turn-clarify-2",
          metadata: { clarificationSent: true },
        }),
        createOrGetTurn: vi.fn(),
      } as unknown as TurnRepository;

      const mockOutboundRepo = {
        createAction: vi.fn(),
      } as unknown as OutboundRepoType;

      const mockJobRepo = { enqueue: vi.fn() } as unknown as JobRepository;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-clarify-2",
            inboundVersion: 3,
            manualMode: false,
            isBlocked: false,
          },
        }),
        getRecentMessages: vi.fn().mockResolvedValue([
          {
            inboundVersion: 3,
            text: "",
            parts: [{ type: "IMAGE" }],
            contentStatus: "READY",
          },
        ]),
      } as unknown as ConversationRepository;

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: {} as unknown as OutboxRepository,
        eventRepo: { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository,
        broadcaster: {} as unknown as OutboxBroadcaster,
        replyPolicyService: { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService,
        convRepo: mockConvRepo,
        outboundRepo: mockOutboundRepo,
      });

      await debounceHandler({
        job: {
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-clarify-2",
            inboundVersion: 3,
          },
        },
      } as unknown as JobExecutionContext);

      expect(mockTurnRepo.createOrGetTurn).not.toHaveBeenCalled();
      expect(mockOutboundRepo.createAction).not.toHaveBeenCalled();
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("PR-05: Fencing Xuyên Chuỗi — Control Epoch Pre-Enter Verification", () => {
    it("aborts send action and cancels turn if controlEpoch moved or mode became non-AUTO right before Enter", async () => {
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
        getConversationById: vi.fn()
          // Initial check before typing: AUTO, epoch 1
          .mockResolvedValueOnce({
            conversation: {
              id: "conv-fencing-1",
              inboundVersion: 2,
              manualMode: false,
              controlEpoch: 1,
              replyControlMode: "AUTO",
              externalThreadRef: "thread-fence",
            },
          })
          // Pre-send check right before Enter: human took over -> epoch moved to 2, mode to HUMAN_SESSION
          .mockResolvedValueOnce({
            conversation: {
              id: "conv-fencing-1",
              inboundVersion: 2,
              manualMode: false,
              controlEpoch: 2,
              replyControlMode: "HUMAN_SESSION",
              externalThreadRef: "thread-fence",
            },
          }),
      } as unknown as ConversationRepository;

      const mockTurnRepo = {
        cancelTurn: vi.fn().mockResolvedValue(undefined),
      } as unknown as TurnRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-fence-1", status: "TYPING" }),
        updateStatus: vi.fn().mockResolvedValue({}),
      } as unknown as OutboundRepoType;

      const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;

      const mockAdapter = {
        openConversation: vi.fn().mockResolvedValue(true),
        typeDraft: vi.fn().mockResolvedValue({ completed: true }),
        clearComposer: vi.fn().mockResolvedValue(undefined),
        sendDraft: vi.fn(),
        capturePreSendMarker: vi.fn().mockResolvedValue("m1"),
        checkLastBubbleIsExternalOutbound: vi.fn().mockResolvedValue(false),
      } as unknown as ChannelAdapter;

      const senderService = new SenderWorkerService(
        mockDb,
        null,
        mockAdapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        { getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }) } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository,
        {} as unknown as JobRepository,
        undefined,
        { recheckEligibility: vi.fn().mockResolvedValue({ eligible: true }) } as unknown as ReplyPolicyService,
        mockTurnRepo
      );

      await senderService.processAction({
        actionId: "action-fence-1",
        channelAccountId: "acc-1",
        conversationId: "conv-fencing-1",
        externalThreadRef: "thread-fence",
        inboundVersion: 2,
        responseIndex: 0,
        text: "AI reply should be aborted",
        textHash: "h-fence",
        actor: "AI",
        claimToken: "tok-1",
        ownerToken: "tok-1",
        fencingToken: 1,
        controlEpoch: 1,
        turnId: "turn-fence-1",
      });

      expect(mockAdapter.clearComposer).toHaveBeenCalled();
      expect(mockAdapter.sendDraft).not.toHaveBeenCalled();
      expect(mockTurnRepo.cancelTurn).toHaveBeenCalledWith(
        "turn-fence-1",
        expect.stringContaining("Control epoch moved or human takeover pre-enter")
      );
      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-fence-1",
        "ABORTED",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Control epoch moved or human takeover pre-enter"),
        })
      );
    });
  });
});
