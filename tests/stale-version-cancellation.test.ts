import { describe, it, expect, vi } from "vitest";
import { createAiHandler } from "../apps/core/src/jobs/handlers/ai.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import type {
  Database,
  ConversationRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
  TurnRepository,
  OutboxRepository,
  JobRepository,
} from "../packages/db/src/index.js";
import type { ChannelAdapter } from "@messenger/channel";
import type { AiReplyGenerator } from "@messenger/ai";
import type { OutboundJobPayload } from "@messenger/contracts";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";

describe("Stale Inbound Version Cancellation Race Protection", () => {
  it("cancels AI job when conversation inbound version is higher than job version", async () => {
    // Current DB state has inboundVersion = 19
    const mockConvRepo = {
      getConversationById: vi.fn().mockResolvedValue({
        conversation: {
          id: "conv-race-1",
          inboundVersion: 19,
          manualMode: false,
          isBlocked: false,
        },
        customer: { name: "Customer Test" },
      }),
      updateStatus: vi.fn(),
      getRecentMessages: vi.fn().mockResolvedValue([]),
    } as unknown as ConversationRepository;

    const mockEventRepo = {
      recordEvent: vi.fn().mockResolvedValue({}),
    } as unknown as EventRepository;

    const mockTurnRepo = {
      cancelTurn: vi.fn().mockResolvedValue({}),
    } as unknown as TurnRepository;

    const mockAiGenerator = {
      generateReply: vi.fn(),
    };

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

    // Job arrives with stale version 18
    await aiHandler({
      job: {
        id: "job-ai-stale",
        channelAccountId: "personal-messenger",
        queue: "ai",
        jobType: "ai",
        payload: {
          channelAccountId: "personal-messenger",
          conversationId: "conv-race-1",
          inboundVersion: 18,
          turnId: "turn-18",
        },
        status: "RUNNING",
        priority: 10,
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

    // Stale version must cancel turn and record event, but NOT generate AI reply
    expect(mockTurnRepo.cancelTurn).toHaveBeenCalledWith(
      "turn-18",
      "Inbound version changed during scheduling"
    );
    expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AI_CANCELLED_STALE",
        conversationId: "conv-race-1",
        inboundVersion: 18,
      })
    );
    expect(mockAiGenerator.generateReply).not.toHaveBeenCalled();
  });

  it("aborts sender action and clears composer when conversation version changes right before sending", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: "personal-messenger", status: "RUNNING", isSuspended: false, isPaused: false },
            ]),
          }),
        }),
      }),
    } as unknown as Database;

    // First check returns version 18, but second check right before send returns version 19
    let checkCount = 0;
    const mockConvRepo = {
      getConversationById: vi.fn().mockImplementation(async () => {
        checkCount++;
        return {
          conversation: {
            id: "conv-race-2",
            inboundVersion: checkCount === 1 ? 18 : 19, // Bumps version while typing!
            externalThreadRef: "https://www.facebook.com/messages/t/thread-2",
          },
          customer: { name: "Customer Test" },
        };
      }),
    } as unknown as ConversationRepository;

    const mockAdapter = {
      openConversation: vi.fn().mockResolvedValue(true),
      typeDraft: vi.fn().mockResolvedValue({ completed: true }),
      clearComposer: vi.fn().mockResolvedValue(undefined),
      sendDraft: vi.fn().mockResolvedValue({ sent: true }),
      verifySent: vi.fn().mockResolvedValue({ verified: true }),
    } as unknown as ChannelAdapter;

    const mockOutboundRepo = {
      updateStatus: vi.fn().mockResolvedValue({}),
      confirmSent: vi.fn(),
    } as unknown as OutboundRepository;

    const mockEventRepo = {
      recordEvent: vi.fn().mockResolvedValue({}),
    } as unknown as EventRepository;

    const senderWorker = new SenderWorkerService(
      mockDb,
      null,
      mockAdapter,
      null,
      mockConvRepo,
      null,
      mockOutboundRepo,
      mockEventRepo,
      { getSettings: vi.fn().mockResolvedValue({ settings: { maxConsecutiveAiReplies: 5 } }) } as unknown as SettingsRepository,
      {} as unknown as IncidentRepository,
      { updateStatus: vi.fn() } as unknown as JobRepository,
      undefined,
      {
        recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
      } as unknown as ReplyPolicyService
    );

    // Action has inboundVersion = 18
    await senderWorker.processAction({
      actionId: "action-race-1",
      channelAccountId: "personal-messenger",
      conversationId: "conv-race-2",
      turnId: "turn-race-1",
      inboundVersion: 18,
      actor: "AI",
      text: "Chào bạn, đây là tin nhắn",
      status: "QUEUED",
      retryCount: 0,
      createdAt: new Date(),
    } as unknown as OutboundJobPayload);

    // Should open conversation and clear composer due to race
    expect(mockAdapter.openConversation).toHaveBeenCalled();
    expect(mockAdapter.clearComposer).toHaveBeenCalled();

    // Should NOT have sent draft or confirmed
    expect(mockAdapter.sendDraft).not.toHaveBeenCalled();
    expect(mockOutboundRepo.confirmSent).not.toHaveBeenCalled();

    // Status of outbound action must be set to ABORTED
    expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
      "action-race-1",
      "ABORTED",
      expect.anything()
    );

    // Event TYPING_ABORTED should be emitted
    expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "TYPING_ABORTED",
        conversationId: "conv-race-2",
      })
    );
  });
});
