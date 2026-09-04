import { describe, it, expect, vi } from "vitest";
import { AiWorkerService } from "../apps/ai-worker/src/worker.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";
import type { Redis } from "ioredis";
import type { AppQueues } from "@messenger/queue";
import type { ChannelAdapter } from "@messenger/channel";
import type { LeaseManager } from "@messenger/queue";

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

    const mockQueueRepo = {
      release: vi.fn(),
    } as unknown as QueueRepository;

    const aiWorker = new AiWorkerService(
      {} as Database,
      {} as Redis,
      {} as AppQueues,
      mockConvRepo,
      mockQueueRepo,
      {} as unknown as OutboundRepository,
      mockEventRepo,
      {} as unknown as SettingsRepository,
      {} as unknown as IncidentRepository
    );

    // Job arrives with stale version 18
    await aiWorker.processJob({
      channelAccountId: "personal-messenger",
      conversationId: "conv-race-1",
      inboundVersion: 18,
      claimToken: "token-18",
      fencingToken: 5,
    });

    // Verify AI job was cancelled stale
    expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AI_CANCELLED_STALE",
        inboundVersion: 18,
      })
    );
    // Should NOT have transitioned to THINKING
    expect(mockConvRepo.updateStatus).not.toHaveBeenCalledWith("conv-race-1", "THINKING");
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

    const mockSettingsRepo = {
      getSettings: vi.fn().mockResolvedValue({
        settings: { typingTargetWpmMin: 100, typingTargetWpmMax: 100 },
      }),
    } as unknown as SettingsRepository;

    const mockLeaseManager = {
      acquire: vi.fn().mockResolvedValue({ token: "lease-sender-1" }),
      release: vi.fn().mockResolvedValue(true),
    } as unknown as LeaseManager;

    const senderWorker = new SenderWorkerService(
      mockDb,
      {} as Redis,
      mockAdapter,
      mockLeaseManager,
      mockConvRepo,
      {} as unknown as QueueRepository,
      mockOutboundRepo,
      mockEventRepo,
      mockSettingsRepo,
      {} as unknown as IncidentRepository
    );

    await senderWorker.processAction({
      actionId: "action-stale-test",
      channelAccountId: "personal-messenger",
      conversationId: "conv-race-2",
      externalThreadRef: "https://www.facebook.com/messages/t/thread-2",
      inboundVersion: 18,
      responseIndex: 0,
      text: "Tin nhắn trả lời version 18",
      textHash: "hash18",
      actor: "AI",
      claimToken: "claim-18",
      fencingToken: 10,
    });

    // Should abort action
    expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
      "action-stale-test",
      "ABORTED",
      expect.objectContaining({
        errorMessage: expect.stringContaining("New inbound received right before send"),
      })
    );

    // Composer must be cleared
    expect(mockAdapter.clearComposer).toHaveBeenCalled();

    // sendDraft must NOT have been called!
    expect(mockAdapter.sendDraft).not.toHaveBeenCalled();
    expect(mockOutboundRepo.confirmSent).not.toHaveBeenCalled();
  });
});
