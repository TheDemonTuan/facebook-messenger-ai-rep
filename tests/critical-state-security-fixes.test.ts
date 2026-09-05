import { describe, it, expect, vi } from "vitest";
import { EnvSchema, resetEnvCache, validateCoreProductionEnv } from "../packages/config/src/index.js";
import { verifyCloudflareAccess } from "../apps/core/src/auth/cloudflare.js";
import { createAuthMiddleware } from "../apps/core/src/auth/session.js";
import { createAiHandler } from "../apps/core/src/jobs/handlers/ai.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import { MockChannelAdapter } from "../packages/channel/src/mock-adapter.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { OutboundRepository, ConversationRepository, EventRepository, SettingsRepository, IncidentRepository, TurnRepository, UserRepository, Database, OutboxRepository, Job } from "../packages/db/src/index.js";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";
import type { AiReplyGenerator } from "../packages/ai/src/index.js";

describe("Critical/High State, Security, and Concurrency Fixes", () => {
  describe("1. Cloudflare Production Security & Config", () => {
    it("fails startup validation in production if CLOUDFLARE_ACCESS_AUD or TEAM_NAME is missing", () => {
      const prodEnvMissingCf = {
        NODE_ENV: "production",
        XAI_API_KEY: "test-xai-key",
        ADMIN_EMAIL: "admin@example.com",
      };

      const result = EnvSchema.parse(prodEnvMissingCf);
      expect(() => validateCoreProductionEnv(result)).toThrow("CLOUDFLARE_ACCESS_TEAM_NAME");
      expect(() => validateCoreProductionEnv(result)).toThrow("CLOUDFLARE_ACCESS_AUD");
    });

    it("in production, rejects raw cf-access-authenticated-user-email header if JWT assertion is missing", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalXaiKey = process.env.XAI_API_KEY;
      const originalTeam = process.env.CLOUDFLARE_ACCESS_TEAM_NAME;
      const originalAud = process.env.CLOUDFLARE_ACCESS_AUD;
      const originalAdminEmail = process.env.ADMIN_EMAIL;

      process.env.NODE_ENV = "production";
      process.env.XAI_API_KEY = "test-xai-key-production";
      process.env.CLOUDFLARE_ACCESS_TEAM_NAME = "test-team";
      process.env.CLOUDFLARE_ACCESS_AUD = "test-aud";
      process.env.ADMIN_EMAIL = "admin@example.com";
      resetEnvCache();

      try {
        let statusCode = 0;
        let responseBody: unknown = null;

        const mockReq = {
          headers: {
            "cf-access-authenticated-user-email": "attacker-spoof@example.com",
            // Notice: no cf-access-jwt-assertion
          },
        } as unknown as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockImplementation((code: number) => {
            statusCode = code;
            return {
              send: vi.fn().mockImplementation((body: unknown) => {
                responseBody = body;
              }),
            };
          }),
        } as unknown as FastifyReply;

        const allowed = await verifyCloudflareAccess(mockReq, mockReply);
        expect(allowed).toBe(false);
        expect(statusCode).toBe(401);
        expect((responseBody as { error?: string })?.error).toContain("Missing Cloudflare Access assertion header");
        expect(mockReq.headers["x-cf-access-user"]).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.XAI_API_KEY = originalXaiKey;
        process.env.CLOUDFLARE_ACCESS_TEAM_NAME = originalTeam;
        process.env.CLOUDFLARE_ACCESS_AUD = originalAud;
        process.env.ADMIN_EMAIL = originalAdminEmail;
        resetEnvCache();
      }
    });

    it("in production, session auth middleware never trusts raw email header without verified x-cf-access-user", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalXaiKey = process.env.XAI_API_KEY;
      const originalTeam = process.env.CLOUDFLARE_ACCESS_TEAM_NAME;
      const originalAud = process.env.CLOUDFLARE_ACCESS_AUD;
      const originalAdminEmail = process.env.ADMIN_EMAIL;

      process.env.NODE_ENV = "production";
      process.env.XAI_API_KEY = "test-xai-key-production";
      process.env.CLOUDFLARE_ACCESS_TEAM_NAME = "test-team";
      process.env.CLOUDFLARE_ACCESS_AUD = "test-aud";
      process.env.ADMIN_EMAIL = "admin@example.com";
      resetEnvCache();

      try {
        let statusCode = 0;
        const mockReq = {
          headers: {
            "cf-access-authenticated-user-email": "attacker-spoof@example.com",
            // x-cf-access-user is NOT set (because JWT verification was not performed)
          },
        } as unknown as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockImplementation((code: number) => {
            statusCode = code;
            return {
              send: vi.fn(),
            };
          }),
        } as unknown as FastifyReply;

        const mockUserRepo = {
          findByEmail: vi.fn(),
          findOrCreateFromCloudflare: vi.fn(),
        } as unknown as UserRepository;

        const requireAuth = createAuthMiddleware(mockUserRepo);
        const sessionUser = await requireAuth(mockReq, mockReply);

        expect(sessionUser).toBeNull();
        expect(statusCode).toBe(401);
        expect(mockUserRepo.findOrCreateFromCloudflare).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.XAI_API_KEY = originalXaiKey;
        process.env.CLOUDFLARE_ACCESS_TEAM_NAME = originalTeam;
        process.env.CLOUDFLARE_ACCESS_AUD = originalAud;
        process.env.ADMIN_EMAIL = originalAdminEmail;
        resetEnvCache();
      }
    });
  });

  describe("2. Sender Worker Double TYPING Transition Guard", () => {
    it("calls transitionStatus(PENDING -> TYPING) exactly once and does not execute redundant updateStatus(TYPING)", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      adapter.abortOnType = true;

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
            id: "conv-typing-1",
            inboundVersion: 1,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-typing-1",
          },
          customer: { name: "Customer Typing" },
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const transitionCalls: string[] = [];
      const updateStatusCalls: string[] = [];

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockImplementation(async (_actionId, from, to) => {
          transitionCalls.push(`${from}->${to}`);
          return { id: "action-typing-1", status: to };
        }),
        updateStatus: vi.fn().mockImplementation(async (_actionId, status) => {
          updateStatusCalls.push(status);
          return { id: "action-typing-1", status };
        }),
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
        {} as unknown as IncidentRepository
      );

      await senderWorker.processAction({
        actionId: "action-typing-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-typing-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-typing-1",
        inboundVersion: 1,
        responseIndex: 0,
        text: "Xin chao!",
        textHash: "hash-typing-1",
        actor: "AI",
        claimToken: "token-1",
        fencingToken: 1,
      });

      // transitionStatus was called for PENDING->TYPING
      expect(transitionCalls).toContain("PENDING->TYPING");

      // Crucial fix: updateStatus was NOT called with TYPING right after transitionStatus
      expect(updateStatusCalls).not.toContain("TYPING");
    });

    it("uses the outbound action ownership instead of the browser job lease", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      adapter.abortOnType = true;

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
            id: "conv-owner-1",
            inboundVersion: 1,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-owner-1",
          },
          customer: { name: "Customer Owner" },
        }),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "action-owner-1", status: "TYPING" }),
        updateStatus: vi.fn().mockResolvedValue({ id: "action-owner-1", status: "ABORTED" }),
      } as unknown as OutboundRepository;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        adapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository,
        {
          getSettings: vi.fn().mockResolvedValue({
            settings: { typingTargetWpmMin: 60, typingTargetWpmMax: 70 },
          }),
        } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository
      );

      await senderWorker.processAction({
        actionId: "action-owner-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-owner-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-owner-1",
        inboundVersion: 1,
        responseIndex: 0,
        text: "Xin chao!",
        textHash: "hash-owner-1",
        actor: "AI",
        claimToken: "action-owner",
        ownerToken: "action-owner",
        fencingToken: 3,
        fencingEpoch: 3,
      }, {
        job: { payload: {} } as unknown as Job,
        ownerToken: "browser-job-owner",
        fencingEpoch: 8,
        signal: new AbortController().signal,
      });

      expect(mockOutboundRepo.transitionStatus).toHaveBeenCalledWith(
        "action-owner-1",
        "PENDING",
        "TYPING",
        { ownerToken: "action-owner", fencingEpoch: 3 }
      );
      expect(mockOutboundRepo.updateStatus).toHaveBeenCalledWith(
        "action-owner-1",
        "ABORTED",
        expect.objectContaining({ ownerToken: "action-owner", fencingEpoch: 3 })
      );
    });

    it("fails the browser job if PENDING -> TYPING transition is rejected", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      const openConversationSpy = vi.spyOn(adapter, "openConversation");

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
            id: "conv-typing-2",
            inboundVersion: 1,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-typing-2",
          },
          customer: { name: "Customer Typing" },
        }),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        // Return null simulating that action was already cancelled or fenced
        transitionStatus: vi.fn().mockResolvedValue(null),
        updateStatus: vi.fn(),
      } as unknown as OutboundRepository;

      const mockEventRepo = {
        recordEvent: vi.fn(),
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
        {} as unknown as IncidentRepository
      );

      await expect(senderWorker.processAction({
        actionId: "action-typing-2",
        channelAccountId: "personal-messenger",
        conversationId: "conv-typing-2",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-typing-2",
        inboundVersion: 1,
        responseIndex: 0,
        text: "Xin chao!",
        textHash: "hash-typing-2",
        actor: "AI",
      })).rejects.toThrow("could not start typing");

      // Did not record TYPING_STARTED event because transition failed
      expect(mockEventRepo.recordEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "TYPING_STARTED" })
      );
      expect(openConversationSpy).toHaveBeenCalledTimes(1);
    });

    it("fails the browser job without pressing Enter if TYPING -> SEND_INTENT is rejected", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      const sendDraftSpy = vi.spyOn(adapter, "sendDraft");
      const clearComposerSpy = vi.spyOn(adapter, "clearComposer");

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
            id: "conv-send-state-1",
            inboundVersion: 1,
            manualMode: false,
            externalThreadRef: "https://www.facebook.com/messages/t/thread-send-state-1",
          },
          customer: { name: "Customer Send State" },
        }),
      } as unknown as ConversationRepository;

      const mockOutboundRepo = {
        transitionStatus: vi.fn()
          .mockResolvedValueOnce({ id: "action-send-state-1", status: "TYPING" })
          .mockResolvedValueOnce(null),
        updateStatus: vi.fn(),
      } as unknown as OutboundRepository;

      const senderWorker = new SenderWorkerService(
        mockDb,
        null,
        adapter,
        null,
        mockConvRepo,
        null,
        mockOutboundRepo,
        { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository,
        {
          getSettings: vi.fn().mockResolvedValue({
            settings: { typingTargetWpmMin: 60000, typingTargetWpmMax: 60000 },
          }),
        } as unknown as SettingsRepository,
        {} as unknown as IncidentRepository
      );

      await expect(senderWorker.processAction({
        actionId: "action-send-state-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-send-state-1",
        externalThreadRef: "https://www.facebook.com/messages/t/thread-send-state-1",
        inboundVersion: 1,
        responseIndex: 0,
        text: "Xin chao!",
        textHash: "hash-send-state-1",
        actor: "AI",
        claimToken: "action-owner",
        fencingToken: 2,
      })).rejects.toThrow("could not enter the send state");

      expect(clearComposerSpy).toHaveBeenCalledTimes(1);
      expect(sendDraftSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. AI Job Handler Honors claimTurn Failure", () => {
    it("aborts AI job and does not generate reply or update conversation if claimTurn returns null", async () => {
      const mockDb = {} as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-claim-1",
            inboundVersion: 2,
            manualMode: false,
            isBlocked: false,
            summary: null,
          },
          customer: { name: "Test Customer" },
        }),
        updateStatus: vi.fn(),
      } as unknown as ConversationRepository;

      const mockTurnRepo = {
        claimTurn: vi.fn().mockResolvedValue(null), // Claim failed!
        transitionStatus: vi.fn(),
        failTurn: vi.fn(),
      } as unknown as TurnRepository;

      const mockEventRepo = {
        recordEvent: vi.fn(),
      } as unknown as EventRepository;

      const job = {
        id: "job-ai-claim-1",
        payload: {
          channelAccountId: "personal-messenger",
          conversationId: "conv-claim-1",
          inboundVersion: 2,
          turnId: "turn-fail-1",
        },
      } as unknown as Job;

      const context = {
        job,
        ownerToken: "worker-token-1",
        fencingEpoch: 1,
        signal: new AbortController().signal,
      };

      const mockAiGenerator = {
        generateReply: vi.fn(),
      };

      const aiHandler = createAiHandler({
        db: mockDb,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: {} as unknown as OutboundRepository,
        settingsRepo: {} as unknown as SettingsRepository,
        incidentRepo: {} as unknown as IncidentRepository,
        eventRepo: mockEventRepo,
        outboxRepo: {} as unknown as OutboxRepository,
        broadcaster: {} as unknown as OutboxBroadcaster,
        aiGenerator: mockAiGenerator as unknown as AiReplyGenerator,
      });

      await aiHandler(context);

      expect(mockTurnRepo.claimTurn).toHaveBeenCalledWith("turn-fail-1", "worker-token-1");
      // Must not call generateReply, update conversation to THINKING, or record AI_STARTED if claim failed
      expect(mockAiGenerator.generateReply).not.toHaveBeenCalled();
      expect(mockConvRepo.updateStatus).not.toHaveBeenCalled();
      expect(mockEventRepo.recordEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "AI_STARTED" })
      );
    });
  });

  describe("4. Exact Outgoing Bubble Verification (No false positives)", () => {
    it("does not accept historical bubbles that were present before send", async () => {
      const adapter = new MockChannelAdapter("personal-messenger");
      // Add existing historical message
      adapter.sentMessages.push({
        messageRef: "mid.$historical_1",
        text: "Dạ bạn cần hỗ trợ gì?",
        hash: "hash-1",
        actionId: "action-hist-1",
        timestamp: new Date(Date.now() - 60000),
      });

      const marker = await adapter.capturePreSendMarker();
      expect(marker.knownMessageIds).toContain("mid.$historical_1");

      // Verify that verifySent does not match the historical message
      const verifyResult = await adapter.verifySent("Dạ bạn cần hỗ trợ gì?", "hash-1", marker, 100);
      expect(verifyResult.verified).toBe(false);
    });
  });
});
