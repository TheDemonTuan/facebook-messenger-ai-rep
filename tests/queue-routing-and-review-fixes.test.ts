import { describe, it, expect, vi } from "vitest";
import { SystemSettingsSchema, type SystemSettings } from "../packages/contracts/src/settings.js";
import { shouldRefetchIncidents, shouldRefetchOverview } from "../apps/dashboard/src/helpers/sse-helpers";
import { createDebounceHandler, type DebounceHandlerDeps } from "../apps/core/src/jobs/handlers/debounce.js";
import { createAiHandler, type AiHandlerDeps } from "../apps/core/src/jobs/handlers/ai.js";
import { SenderWorkerService } from "../apps/browser-agent/src/sender-worker.js";
import { CoreJobService, type CoreJobServiceDeps } from "../apps/core/src/jobs/scheduler.js";
import { buildCoreServer } from "../apps/core/src/server.js";
import { ConversationRepository } from "../packages/db/src/repository/conversation-repo.js";
import { IncidentRepository } from "../packages/db/src/repository/incident-repo.js";
import type {
  Database,
  JobRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
} from "../packages/db/src/index.js";
import type { Job } from "../packages/contracts/src/index.js";
import type { ChannelAdapter } from "../packages/channel/src/index.js";

describe("Queue Routing, Inbound Atomic Ingestion & Dashboard-API Alignment", () => {
  describe("1. Queue Routing & Explicit Queue Assignments", () => {
    it("browser JobRunner only claims browser queues and never default/system/ai", () => {
      const mockDb = {} as unknown as Database;
      const mockJobRepo = {
        claimNext: vi.fn().mockResolvedValue(null),
        reconcileStaleJobs: vi.fn().mockResolvedValue({}),
      } as unknown as JobRepository;

      const worker = new SenderWorkerService(
        mockDb,
        null,
        {} as unknown as ChannelAdapter,
        null,
        {} as unknown as ConversationRepository,
        null,
        {} as unknown as OutboundRepository,
        {} as unknown as EventRepository,
        {} as unknown as SettingsRepository,
        {} as unknown as IncidentRepository,
        mockJobRepo
      );

      worker.start();
      const runner = (worker as unknown as { jobRunner: { queues: string[] } }).jobRunner;
      expect(runner).toBeDefined();
      const claimedQueues: string[] = runner.queues;

      expect(claimedQueues).toContain("browser");
      expect(claimedQueues).toContain("browser-actions");
      expect(claimedQueues).not.toContain("default");
      expect(claimedQueues).not.toContain("system");
      expect(claimedQueues).not.toContain("ai");
      expect(claimedQueues).not.toContain("debounce");

      worker.stop();
    });

    it("CoreJobService runner claims default, debounce, ai, and system queues", () => {
      const mockDb = {} as unknown as Database;
      const mockJobRepo = {
        claimNext: vi.fn().mockResolvedValue(null),
        reconcileStaleJobs: vi.fn().mockResolvedValue({}),
      } as unknown as JobRepository;

      const coreJobService = new CoreJobService({
        db: mockDb,
        jobRepo: mockJobRepo,
        outboxRepo: { claimBatch: vi.fn().mockResolvedValue([]) },
        broadcaster: { broadcast: vi.fn().mockResolvedValue(undefined) },
      } as unknown as CoreJobServiceDeps);

      const runner = (coreJobService as unknown as { runner: { queues: string[] } }).runner;
      expect(runner).toBeDefined();
      const coreQueues: string[] = runner.queues;

      expect(coreQueues).toContain("debounce");
      expect(coreQueues).toContain("ai");
      expect(coreQueues).toContain("system");
      expect(coreQueues).toContain("default");
      expect(coreQueues).not.toContain("browser");
    });

    it("Debounce handler explicitly sets queue: 'ai' when enqueuing AI job", async () => {
      let selectCount = 0;
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                selectCount++;
                if (selectCount === 1) {
                  return Promise.resolve([
                    {
                      id: "conv-1",
                      inboundVersion: 2,
                      status: "DEBOUNCING",
                      manualMode: false,
                      isBlocked: false,
                    },
                  ]);
                }
                return Promise.resolve([{ status: "RUNNING", isPaused: false, isSuspended: false }]);
              }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      };

      const mockTurnRepo = {
        createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
      };
      const mockJobRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: "job-ai-1" }),
      };
      const mockOutboxRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: "outbox-1" }),
      };
      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({ id: "ev-1" }),
      };
      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      };

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: mockOutboxRepo,
        eventRepo: mockEventRepo,
        broadcaster: mockBroadcaster,
        replyPolicyService: {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService,
      } as unknown as DebounceHandlerDeps);

      await debounceHandler({
        signal: new AbortController().signal,
        ownerToken: "test-owner",
        fencingEpoch: 1,
        job: {
          id: "job-db-1",
          jobType: "debounce",
          queue: "debounce",
          payload: { channelAccountId: "acc-1", conversationId: "conv-1", inboundVersion: 2 },
        } as unknown as Job,
      });

      expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: "ai",
          jobType: "ai",
          payload: expect.objectContaining({
            conversationId: "conv-1",
            inboundVersion: 2,
            turnId: "turn-1",
          }),
        })
      );
    });

    it("AI handler explicitly sets queue: 'browser' when enqueuing BROWSER_SEND outbound job", async () => {
      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "run-1" }]),
          })),
        })),
      };

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: {
            id: "conv-1",
            inboundVersion: 3,
            status: "THINKING",
            externalThreadRef: "https://facebook.com/messages/t/thread-1",
          },
          customer: { name: "Test Cust" },
          messages: [{ text: "Hello" }],
        }),
        getRecentMessages: vi.fn().mockResolvedValue([{ text: "Hello" }]),
        updateStatus: vi.fn().mockResolvedValue({}),
      };

      const mockTurnRepo = {
        claimTurn: vi.fn().mockResolvedValue({}),
        transitionStatus: vi.fn().mockResolvedValue({}),
      };

      const mockOutboundRepo = {
        createAction: vi.fn().mockResolvedValue({
          actionId: "action-uuid-1",
          textHash: "hash-1",
          claimToken: "action-owner-1",
          ownerToken: "action-owner-1",
          fencingToken: 4,
          fencingEpoch: 4,
        }),
      };

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: { aiMaxResponseCount: 1, aiTotalMaxChars: 480 },
        }),
      };

      const mockJobRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: "job-send-1" }),
      };

      const mockAiGenerator = {
        generateReply: vi.fn().mockResolvedValue({
          success: true,
          data: { messages: ["Xin chao quy khach!"] },
          runId: "run-1",
        }),
      };

      const aiHandler = createAiHandler({
        db: mockDb,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: mockOutboundRepo,
        settingsRepo: mockSettingsRepo,
        aiConfigRepo: {
          getConfig: vi.fn().mockResolvedValue({
            apiFormat: "OPENAI_COMPATIBLE",
            baseUrl: "https://example.com/v1",
            apiKey: "test-key",
            model: "test-model",
          }),
        },
        incidentRepo: {},
        eventRepo: { recordEvent: vi.fn().mockResolvedValue({}) },
        outboxRepo: { enqueue: vi.fn().mockResolvedValue({}) },
        broadcaster: { broadcast: vi.fn().mockResolvedValue(undefined) },
        aiGenerator: mockAiGenerator,
        jobRepo: mockJobRepo,
        replyPolicyService: {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService,
      } as unknown as AiHandlerDeps);

      await aiHandler({
        signal: new AbortController().signal,
        ownerToken: "test-owner",
        fencingEpoch: 1,
        job: {
          id: "job-ai-1",
          queue: "ai",
          jobType: "ai",
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-1",
            inboundVersion: 3,
            turnId: "turn-1",
          },
        } as unknown as Job,
      });

      expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queue: "browser",
          jobType: "BROWSER_SEND",
          payload: expect.objectContaining({
            actionId: "action-uuid-1",
            conversationId: "conv-1",
            inboundVersion: 3,
            text: "Xin chao quy khach!",
            claimToken: "action-owner-1",
            ownerToken: "action-owner-1",
            fencingToken: 4,
            fencingEpoch: 4,
          }),
        })
      );
    });
  });

  describe("2. Inbound Atomic Ingestion & Debounce Scheduling", () => {
    it("ConversationRepository.ingestInboundMessage atomically enqueues debounce job and outbox event", async () => {
      const recordedOperations: string[] = [];

      const mockTx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                recordedOperations.push("select-existing");
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
        insert: vi.fn((_table: unknown) => ({
          values: vi.fn((vals: { jobType?: string; eventType?: string; direction?: string }) => {
            recordedOperations.push(`insert-${vals.jobType || vals.eventType || vals.direction || "row"}`);
            return {
              returning: vi.fn().mockResolvedValue([{ id: "generated-id" }]),
              onConflictDoUpdate: vi.fn().mockResolvedValue([{ id: "generated-id" }]),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockImplementation(() => {
              recordedOperations.push("update-cancel-older-jobs");
              return Promise.resolve([]);
            }),
          })),
        })),
      };

      const mockDb = {
        transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx)),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);
      const res = await repo.ingestInboundMessage(
        {
          channelAccountId: "acc-1",
          externalThreadId: "thread-101",
          externalThreadRef: "https://facebook.com/messages/t/thread-101",
          externalCustomerId: "cust-1",
          customerName: "Nguyen Van A",
          externalMessageId: "mid.12345",
          text: "Gia san pham la bao nhieu?",
          timestamp: new Date(),
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          senderKind: "PERSON",
          senderReliability: "VERIFIED",
          participantIdentity: {
            channelAccountId: "acc-1",
            participantId: "cust-1",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        { debounceMs: 4000 }
      );

      expect(res.isDuplicate).toBe(false);
      expect(recordedOperations).toContain("update-cancel-older-jobs");
      expect(recordedOperations).toContain("insert-debounce");
      expect(recordedOperations).toContain("insert-inbound:received");
    });
  });

  describe("3. API AI Health Response Shape & Settings Reason Preservation", () => {
    function createMockServerDb(userEmail = "operator@example.com", role = "OWNER") {
      const userRecord = {
        id: "user-1",
        email: userEmail,
        role,
      };

      const createChain = () => {
        const chain: Record<string, unknown> = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          offset: vi.fn(() => chain),
          then: (resolve: (records: typeof userRecord[]) => void) => resolve([userRecord]),
          [Symbol.iterator]: function* () {
            yield userRecord;
          },
        };
        return chain;
      };

      const mockDb = {
        execute: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
        select: vi.fn(() => createChain()),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([userRecord]),
            })),
            returning: vi.fn().mockResolvedValue([userRecord]),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([userRecord]),
          })),
        })),
        transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockDb)),
      };

      return mockDb as unknown as Database;
    }

    it("test-ai returns healthy, status, model and latencyMs matching dashboard expectations", async () => {
      const mockDb = createMockServerDb("operator@example.com", "OPERATOR");
      const serverCtx = await buildCoreServer({ db: mockDb });

      const res = await serverCtx.fastify.inject({
        method: "POST",
        url: "/api/settings/test-ai",
        headers: {
          "cf-access-authenticated-user-email": "operator@example.com",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        payload: { model: "test-model" },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json).toHaveProperty("healthy");
      expect(json).toHaveProperty("status");
      expect(typeof json.healthy).toBe("boolean");
      expect(["healthy", "unhealthy"]).toContain(json.status);
      expect(json).toHaveProperty("model", "test-model");
      expect(json).toHaveProperty("latencyMs");
      expect(typeof json.latencyMs).toBe("number");

      serverCtx.rateLimiter.destroy();
      serverCtx.broadcaster.stop();
    });

    it("POST /api/settings preserves caller-provided reason in updateSettings and audit log", async () => {
      let savedReason = "";
      let recordedReason = "";

      const mockDb = createMockServerDb("owner@example.com", "OWNER");
      const serverCtx = await buildCoreServer({ db: mockDb });

      // Spy on settingsRepo.updateSettings
      vi.spyOn(serverCtx.repos.settingsRepo, "updateSettings").mockImplementation(
        async (_accId, _newSettings, _user, reason) => {
          savedReason = reason || "";
          return {
            settings: {} as SystemSettings,
            revision: 5,
          };
        }
      );

      vi.spyOn(serverCtx.repos.eventRepo, "recordEvent").mockImplementation(async (ev) => {
        const payload = ev.payload as { reason?: string } | undefined;
        recordedReason = payload?.reason || "";
        return {} as never;
      });

      const res = await serverCtx.fastify.inject({
        method: "POST",
        url: "/api/settings",
        headers: {
          "cf-access-authenticated-user-email": "owner@example.com",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        payload: {
          debounceMs: 5000,
          reason: "Tang debounce de nhan du tin nhan khach go don dap",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(savedReason).toBe("Tang debounce de nhan du tin nhan khach go don dap");
      expect(recordedReason).toBe("Tang debounce de nhan du tin nhan khach go don dap");

      serverCtx.rateLimiter.destroy();
      serverCtx.broadcaster.stop();
    });
  });

  describe("4. WPM Upper Limit & SSE Incident Subscriptions", () => {
    it("SystemSettingsSchema allows typingTargetWpm up to 300 and rejects values above 300", () => {
      const validSettings = SystemSettingsSchema.safeParse({
        typingTargetWpmMin: 120,
        typingTargetWpmMax: 280,
      });
      expect(validSettings.success).toBe(true);

      const maxEdgeSettings = SystemSettingsSchema.safeParse({
        typingTargetWpmMin: 300,
        typingTargetWpmMax: 300,
      });
      expect(maxEdgeSettings.success).toBe(true);

      const invalidSettings = SystemSettingsSchema.safeParse({
        typingTargetWpmMax: 301,
      });
      expect(invalidSettings.success).toBe(false);
    });

    it("SSE helpers trigger refetch on incident:created for both Incidents and Overview", () => {
      expect(shouldRefetchIncidents("incident:created")).toBe(true);
      expect(shouldRefetchIncidents("incident:resolved")).toBe(true);
      expect(shouldRefetchIncidents("unrelated:event")).toBe(false);

      expect(shouldRefetchOverview("incident:created")).toBe(true);
      expect(shouldRefetchOverview("incident:resolved")).toBe(true);
      expect(shouldRefetchOverview("queue:updated")).toBe(true);
    });

    it("IncidentRepository.createIncident enqueues outbox event incident:created", async () => {
      const operations: string[] = [];
      const mockTx = {
        insert: vi.fn(() => ({
          values: vi.fn((vals: { eventType?: string; type?: string }) => {
            operations.push(`insert-${vals.eventType || vals.type || "incident"}`);
            return {
              returning: vi.fn().mockResolvedValue([{ id: "inc-1", type: vals.type || "DOM_DEGRADED", title: "Test" }]),
            };
          }),
        })),
      };

      const mockDb = {
        transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx)),
      } as unknown as Database;

      const incidentRepo = new IncidentRepository(mockDb);
      const inc = await incidentRepo.createIncident({
        channelAccountId: "acc-1",
        type: "DOM_DEGRADED",
        title: "DOM Structure Changed",
        description: "Missing send button",
      });

      expect(inc.id).toBe("inc-1");
      expect(operations).toContain("insert-DOM_DEGRADED");
      expect(operations).toContain("insert-incident:created");
    });
  });
});
