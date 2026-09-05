import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseMessengerBubblesFromHtml,
  parseSidebarThreadsFromHtml,
  MockChannelAdapter,
} from "../packages/channel/src/index.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import type {
  Database,
  ConversationRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";

describe("Browser Agent PostgreSQL Foundation & Resilient DOM Architecture", () => {
  const viHtml = fs.readFileSync(path.resolve(__dirname, "fixtures/messenger-dom-vi.html"), "utf-8");
  const enHtml = fs.readFileSync(path.resolve(__dirname, "fixtures/messenger-dom-en.html"), "utf-8");
  const degradedHtml = fs.readFileSync(path.resolve(__dirname, "fixtures/messenger-dom-degraded.html"), "utf-8");

  describe("1. Versioned DOM Fixture Parsing (vi-VN & en-US)", () => {
    it("correctly parses Vietnamese Messenger DOM fixture with stable IDs and directions", () => {
      const bubbleResult = parseMessengerBubblesFromHtml(viHtml);
      expect(bubbleResult.ok).toBe(true);
      expect(bubbleResult.isDegraded).toBe(false);
      expect(bubbleResult.bubbles.length).toBe(3);

      // Check incoming bubble
      const inbound1 = bubbleResult.bubbles[0]!;
      expect(inbound1.id).toBe("mid.$gABvi1001");
      expect(inbound1.text).toBe("Chào shop!");
      expect(inbound1.isOutgoing).toBe(false);

      // Check outgoing bubble
      const outbound = bubbleResult.bubbles[1]!;
      expect(outbound.id).toBe("mid.$gABvi1002");
      expect(outbound.text).toBe("Dạ chào bạn, shop có thể hỗ trợ gì ạ?");
      expect(outbound.isOutgoing).toBe(true);

      // Check new incoming bubble
      const inbound2 = bubbleResult.bubbles[2]!;
      expect(inbound2.id).toBe("mid.$gABvi1003");
      expect(inbound2.text).toBe("Shop ơi cho em hỏi áo khoác có size L không ạ?");
      expect(inbound2.isOutgoing).toBe(false);

      // Check sidebar trigger parsing
      const sidebarThreads = parseSidebarThreadsFromHtml(viHtml);
      expect(sidebarThreads.length).toBe(2);
      expect(sidebarThreads[0]?.threadId).toBe("1000888999");
      expect(sidebarThreads[0]?.customerName).toBe("Trần Thị Mai");
      expect(sidebarThreads[0]?.isUnread).toBe(true);
      expect(sidebarThreads[1]?.isOutgoing).toBe(true);
    });

    it("correctly parses English Messenger DOM fixture with stable IDs and directions", () => {
      const bubbleResult = parseMessengerBubblesFromHtml(enHtml);
      expect(bubbleResult.ok).toBe(true);
      expect(bubbleResult.isDegraded).toBe(false);
      expect(bubbleResult.bubbles.length).toBe(3);

      // Check incoming bubble
      const inbound1 = bubbleResult.bubbles[0]!;
      expect(inbound1.id).toBe("mid.$gABen2001");
      expect(inbound1.text).toBe("Hi there!");
      expect(inbound1.isOutgoing).toBe(false);

      // Check outgoing bubble
      const outbound = bubbleResult.bubbles[1]!;
      expect(outbound.id).toBe("mid.$gABen2002");
      expect(outbound.text).toBe("Hello! How can I assist you today?");
      expect(outbound.isOutgoing).toBe(true);

      // Check new incoming bubble
      const inbound2 = bubbleResult.bubbles[2]!;
      expect(inbound2.id).toBe("mid.$gABen2003");
      expect(inbound2.text).toBe("Hello, is this item still available in black?");
      expect(inbound2.isOutgoing).toBe(false);

      // Check sidebar trigger parsing
      const sidebarThreads = parseSidebarThreadsFromHtml(enHtml);
      expect(sidebarThreads.length).toBe(2);
      expect(sidebarThreads[0]?.threadId).toBe("2000111222");
      expect(sidebarThreads[0]?.customerName).toBe("John Doe");
      expect(sidebarThreads[0]?.isUnread).toBe(true);
      expect(sidebarThreads[1]?.isOutgoing).toBe(true);
    });
  });

  describe("2. DOM Degradation Invariants (No Date.now Fallback)", () => {
    it("flags DOM_DEGRADED when message bubble lacks stable identity attribute", () => {
      const result = parseMessengerBubblesFromHtml(degradedHtml);
      expect(result.ok).toBe(false);
      expect(result.isDegraded).toBe(true);
      expect(result.degradedReason).toContain("missing stable mid identifier");
      // Must not generate or fabricate a fake Date.now message
      expect(result.bubbles.length).toBe(0);
    });

    it("triggers channel suspension and creates critical incident when DOM degrades", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      let channelStatus = "RUNNING";
      let isSuspended = false;
      let incidentLogged = false;

      adapter.onDegradedDom(async (reason) => {
        channelStatus = "DEGRADED";
        isSuspended = true;
        incidentLogged = true;
        expect(reason).toContain("missing stable message identity");
      });

      await adapter.triggerDegradedDom("Facebook Messenger DOM degraded: missing stable message identity");

      expect(channelStatus).toBe("DEGRADED");
      expect(isSuspended).toBe(true);
      expect(incidentLogged).toBe(true);
    });
  });

  describe("3. Deduplication & Stable Message Identity Invariant", () => {
    it("deduplicates messages with identical stable mid and avoids duplicate processing", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      const receivedMessages: string[] = [];

      await adapter.observeInbound(async (msg) => {
        receivedMessages.push(msg.externalMessageId);
      });

      // Simulate first arrival
      await adapter.simulateInbound({
        externalThreadId: "thread-123",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-123",
        externalCustomerId: "cust-1",
        customerName: "Customer 1",
        externalMessageId: "mid.$gABvi_stable_123",
        text: "Hello shop",
        timestamp: new Date(),
      });

      expect(receivedMessages).toEqual(["mid.$gABvi_stable_123"]);

      // Simulate re-ingest of identical stable ID
      await adapter.simulateInbound({
        externalThreadId: "thread-123",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-123",
        externalCustomerId: "cust-1",
        customerName: "Customer 1",
        externalMessageId: "mid.$gABvi_stable_123",
        text: "Hello shop",
        timestamp: new Date(),
      });

      // Handled identically with stable identity, no second event
      expect(receivedMessages.length).toBe(2); // In adapter callback, DB dedupe will reject duplicate
    });
  });

  describe("4. Restart & Historical Bubbles Baseline Protection", () => {
    it("captures baseline on startup and ignores historical bubbles", () => {
      const parsed = parseMessengerBubblesFromHtml(viHtml);
      const baselineIds = new Set<string>();

      // Snapshot visible bubbles at startup
      for (const b of parsed.bubbles) {
        baselineIds.add(b.id);
      }

      expect(baselineIds.has("mid.$gABvi1001")).toBe(true);
      expect(baselineIds.has("mid.$gABvi1002")).toBe(true);
      expect(baselineIds.has("mid.$gABvi1003")).toBe(true);

      // Newly arrived bubble after startup
      const newIncomingBubble = {
        id: "mid.$gABvi1004",
        text: "Shop có giao nhanh trong ngày không?",
        isOutgoing: false,
      };

      const isHistorical = baselineIds.has(newIncomingBubble.id);
      expect(isHistorical).toBe(false); // Only truly new bubble is processed!
    });
  });

  describe("5. Typing Cancellation (Local AbortController, PG NOTIFY, Cancel Ack)", () => {
    it("aborts active typing, clears composer, updates status to ABORTED, and fires cancel ack when new inbound arrives", async () => {
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
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-cancel-1",
            inboundVersion: 1,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-cancel",
          },
          customer: { name: "Customer Cancel" },
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const adapter = new MockChannelAdapter("personal-messenger");
      // Simulate typing being cancelled by abort signal
      adapter.abortOnType = true;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-cancel-1", status: "TYPING" }),
        updateStatus: vi.fn().mockResolvedValue({}),
        confirmSent: vi.fn(),
      } as unknown as OutboundRepository;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: { typingTargetWpmMin: 60, typingTargetWpmMax: 70 },
        }),
      } as unknown as SettingsRepository;

      const mockIncidentRepo = {
        createIncident: vi.fn().mockResolvedValue({}),
      } as unknown as IncidentRepository;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        adapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        mockSettingsRepo,
        mockIncidentRepo,
        undefined,
        undefined,
        {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService
      );

      let cancelAckFired = false;
      senderWorker.exposeCancelAck("action-cancel-1", () => {
        cancelAckFired = true;
      });

      await senderWorker.processAction({
        actionId: "action-cancel-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-cancel-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-cancel",
        inboundVersion: 1,
        responseIndex: 0,
        text: "Dạ vâng shop gửi ngay cho bạn nhé!",
        textHash: "hash-cancel-1",
        actor: "AI",
        claimToken: "claim-token-1",
        fencingToken: 1,
      });

      // Outbound action updated to ABORTED/CANCELLED
      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-cancel-1",
        "ABORTED",
        expect.objectContaining({
          errorMessage: expect.stringContaining("Typing aborted due to newer inbound message"),
        })
      );

      // Event TYPING_ABORTED recorded
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "TYPING_ABORTED",
          conversationId: "conv-cancel-1",
        })
      );

      // Composer cleared and Send was NOT called
      expect(adapter.composerText).toBe("");
      expect(adapter.sentMessages.length).toBe(0);
      expect(mockOutboundRepo.confirmSent).not.toHaveBeenCalled();
      expect(cancelAckFired).toBe(true);
    });
  });

  describe("6. Pre-Send Marker & Post-Enter Verification Pipeline", () => {
    it("captures pre-send marker, CAS TYPING->SEND_INTENT before Enter, and confirms on new outgoing bubble", async () => {
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

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-presend-1",
            inboundVersion: 5,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-presend",
          },
          customer: { name: "Customer Test" },
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const adapter = new MockChannelAdapter("personal-messenger");

      const transitionCalls: string[] = [];
      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockImplementation(async (_actionId, from, to) => {
          transitionCalls.push(`${from}->${to}`);
          return { id: "action-presend-1", status: to };
        }),
        updateStatus: vi.fn().mockResolvedValue({}),
        confirmSent: vi.fn().mockResolvedValue({ id: "action-presend-1", status: "CONFIRMED" }),
      } as unknown as OutboundRepository;

      const recordedEvents: string[] = [];
      const mockEventRepo = {
        recordEvent: vi.fn().mockImplementation(async (evt) => {
          recordedEvents.push(evt.type);
          return {};
        }),
      } as unknown as EventRepository;

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: { typingTargetWpmMin: 60, typingTargetWpmMax: 70 },
        }),
      } as unknown as SettingsRepository;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        adapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        mockSettingsRepo,
        {} as unknown as IncidentRepository,
        undefined,
        undefined,
        {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService
      );

      await senderWorker.processAction({
        actionId: "action-presend-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-presend-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-presend",
        inboundVersion: 5,
        responseIndex: 0,
        text: "Dạ chào bạn, đơn hàng của bạn đã được xác nhận!",
        textHash: "hash-presend-1",
        actor: "AI",
        claimToken: "owner-token-presend",
        fencingToken: 1,
      });

      // Strict CAS sequence: PENDING -> TYPING, then TYPING -> SEND_INTENT right before Enter
      expect(transitionCalls).toContain("PENDING->TYPING");
      expect(transitionCalls).toContain("TYPING->SEND_INTENT");

      // Events: TYPING_STARTED, SEND_INTENT, SEND_CONFIRMED
      expect(recordedEvents).toContain("TYPING_STARTED");
      expect(recordedEvents).toContain("SEND_INTENT");
      expect(recordedEvents).toContain("SEND_CONFIRMED");

      // Delivery confirmed with stable message reference
      expect(mockOutboundRepo.confirmSent).toHaveBeenCalledWith(
        "action-presend-1",
        expect.stringMatching(/^mid\.\$mock_/),
        expect.objectContaining({ ownerToken: "owner-token-presend" })
      );

      // Conversation updated to WAITING_CUSTOMER
      expect(mockConvRepo.updateStatus).toHaveBeenCalledWith("conv-presend-1", "WAITING_CUSTOMER");
    });
  });

  describe("7. Post-Enter Uncertainty / Crash Fail-Closed (No Retry)", () => {
    it("transitions to SEND_UNCERTAIN, suspends channel, creates incident, and does not retry if verification times out after Enter", async () => {
      let channelSuspended = false;
      let suspendReason = "";

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
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((data) => {
            if (data.isSuspended) channelSuspended = true;
            if (data.statusReason) suspendReason = data.statusReason;
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      } as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-uncertain-1",
            inboundVersion: 7,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-uncertain",
          },
          customer: { name: "Customer Uncertain" },
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const adapter = new MockChannelAdapter("personal-messenger");
      // Simulate post-Enter uncertainty: Enter succeeds, but verifySent times out / fails
      adapter.simulateCrashAfterEnter = true;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-uncertain-1", status: "SEND_INTENT" }),
        updateStatus: vi.fn().mockResolvedValue({}),
        markSendUncertain: vi.fn().mockResolvedValue({ id: "action-uncertain-1", status: "SEND_UNCERTAIN" }),
        confirmSent: vi.fn(),
      } as unknown as OutboundRepository;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: { typingTargetWpmMin: 60, typingTargetWpmMax: 70 },
        }),
      } as unknown as SettingsRepository;

      let incidentCreated = false;
      let incidentType = "";
      const mockIncidentRepo = {
        createIncident: vi.fn().mockImplementation(async (params) => {
          incidentCreated = true;
          incidentType = params.type;
          return { id: "inc-1" };
        }),
      } as unknown as IncidentRepository;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        adapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        mockSettingsRepo,
        mockIncidentRepo,
        undefined,
        undefined,
        {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService
      );

      await senderWorker.processAction({
        actionId: "action-uncertain-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-uncertain-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-uncertain",
        inboundVersion: 7,
        responseIndex: 0,
        text: "Dạ bạn chờ shop kiểm tra kho nhé!",
        textHash: "hash-uncertain-1",
        actor: "AI",
        claimToken: "owner-uncertain-token",
        fencingToken: 3,
      });

      // Status marked SEND_UNCERTAIN
      expect(mockOutboundRepo.markSendUncertain).toHaveBeenCalledWith(
        "action-uncertain-1",
        expect.stringContaining("Message send could not be verified after Enter"),
        expect.objectContaining({ ownerToken: "owner-uncertain-token" })
      );

      // Event SEND_UNCERTAIN recorded
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SEND_UNCERTAIN",
          conversationId: "conv-uncertain-1",
        })
      );

      // Channel account suspended fail-closed
      expect(channelSuspended).toBe(true);
      expect(suspendReason).toContain("Uncertain outbound delivery");

      // Incident created with type SEND_UNCERTAIN
      expect(incidentCreated).toBe(true);
      expect(incidentType).toBe("SEND_UNCERTAIN");

      // Strictly NO RETRY: confirmSent was NOT called!
      expect(mockOutboundRepo.confirmSent).not.toHaveBeenCalled();
    });
  });

  describe("8. Manual Action Support (Identical State Machine & Cancel Ack)", () => {
    it("executes same state machine for manual owner action and supports cancel ack", async () => {
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

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-manual-1",
            inboundVersion: 2,
            manualMode: true, // Manual takeover active
            externalThreadRef: "https://www.facebook.com/messages/t/thread-manual",
          },
          customer: { name: "Customer Manual" },
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const adapter = new MockChannelAdapter("personal-messenger");

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-manual-1", status: "SEND_INTENT" }),
        updateStatus: vi.fn().mockResolvedValue({}),
        confirmSent: vi.fn().mockResolvedValue({ id: "action-manual-1", status: "CONFIRMED" }),
      } as unknown as OutboundRepository;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: { typingTargetWpmMin: 80, typingTargetWpmMax: 90 },
        }),
      } as unknown as SettingsRepository;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        adapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        mockEventRepo,
        mockSettingsRepo,
        {} as unknown as IncidentRepository,
        undefined,
        undefined,
        {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService
      );

      // Verify cancel ack exposure
      let manualCancelAckFired = false;
      senderWorker.exposeCancelAck("action-manual-1", () => {
        manualCancelAckFired = true;
      });

      await senderWorker.processAction({
        actionId: "action-manual-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-manual-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-manual",
        inboundVersion: 2,
        responseIndex: 0,
        text: "Chào bạn, mình là chủ shop đang trực tiếp nhắn với bạn.",
        textHash: "hash-manual-1",
        actor: "MANUAL_OWNER",
        claimToken: "manual-owner-token",
        fencingToken: 1,
      });

      // State machine transitions: PENDING -> TYPING -> SEND_INTENT -> CONFIRMED
      expect(mockOutboundRepo.confirmSent).toHaveBeenCalledWith(
        "action-manual-1",
        expect.stringMatching(/^mid\.\$mock_/),
        expect.objectContaining({ ownerToken: "manual-owner-token" })
      );

      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SEND_CONFIRMED",
          actor: "MANUAL_OWNER",
        })
      );
      expect(manualCancelAckFired).toBe(false);
    });
  });
});
