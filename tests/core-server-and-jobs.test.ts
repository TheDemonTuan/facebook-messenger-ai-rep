import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  buildCoreServer,
  hasRolePermission,
  ROLE_HIERARCHY,
  InMemoryRateLimiter,
  OutboxBroadcaster,
  verifySameOrigin,
  resetEnvCache,
} from "../apps/core/src/index.js";
import {
  createDebounceHandler,
} from "../apps/core/src/jobs/handlers/debounce.js";
import {
  createAiHandler,
} from "../apps/core/src/jobs/handlers/ai.js";
import {
  createReconcileHandler,
} from "../apps/core/src/jobs/handlers/reconcile.js";
import {
  createOutboxHandler,
} from "../apps/core/src/jobs/handlers/outbox.js";
import {
  createRetentionHandler,
} from "../apps/core/src/jobs/handlers/retention.js";
import type {
  Database,
  TurnRepository,
  JobRepository,
  OutboxRepository,
  EventRepository,
  ConversationRepository,
  SettingsRepository,
  IncidentRepository,
  Job,
} from "@messenger/db";
import type { AiReplyGenerator } from "@messenger/ai";

describe("Apps/Core Foundation Architecture & Flow Tests", () => {
  describe("Role Hierarchy & Permissions", () => {
    it("enforces VIEWER < OPERATOR < OWNER hierarchy correctly", () => {
      expect(ROLE_HIERARCHY.VIEWER).toBeLessThan(ROLE_HIERARCHY.OPERATOR);
      expect(ROLE_HIERARCHY.OPERATOR).toBeLessThan(ROLE_HIERARCHY.OWNER);

      // VIEWER permissions
      expect(hasRolePermission("VIEWER", "VIEWER")).toBe(true);
      expect(hasRolePermission("VIEWER", "OPERATOR")).toBe(false);
      expect(hasRolePermission("VIEWER", "OWNER")).toBe(false);

      // OPERATOR permissions
      expect(hasRolePermission("OPERATOR", "VIEWER")).toBe(true);
      expect(hasRolePermission("OPERATOR", "OPERATOR")).toBe(true);
      expect(hasRolePermission("OPERATOR", "OWNER")).toBe(false);

      // OWNER permissions
      expect(hasRolePermission("OWNER", "VIEWER")).toBe(true);
      expect(hasRolePermission("OWNER", "OPERATOR")).toBe(true);
      expect(hasRolePermission("OWNER", "OWNER")).toBe(true);
    });
  });

  describe("In-Memory Rate Limiter (Zero Dependency)", () => {
    let limiter: InMemoryRateLimiter;

    beforeEach(() => {
      limiter = new InMemoryRateLimiter({ maxRequests: 3, windowMs: 1000 });
    });

    afterEach(() => {
      limiter.destroy();
    });

    it("allows requests within threshold and throttles with 429 when exceeded", async () => {
      const mockReq = {
        url: "/api/test",
        headers: {},
        ip: "192.168.1.100",
      } as unknown as FastifyRequest;

      interface MockReply {
        statusCode: number;
        headers: Record<string, string | number>;
        body: { error?: string } | null;
        header(k: string, v: string | number): MockReply;
        status(code: number): MockReply;
        send(payload: unknown): MockReply;
      }

      const createMockReply = (): MockReply & FastifyReply => {
        const reply = {
          statusCode: 200,
          headers: {} as Record<string, string | number>,
          body: null as { error?: string } | null,
          header(k: string, v: string | number) {
            this.headers[k] = v;
            return this;
          },
          status(code: number) {
            this.statusCode = code;
            return this;
          },
          send(payload: unknown) {
            this.body = payload as { error?: string } | null;
            return this;
          },
        };
        return reply as unknown as MockReply & FastifyReply;
      };

      // Requests 1, 2, 3 should be allowed
      expect(await limiter.checkRateLimit(mockReq, createMockReply())).toBe(true);
      expect(await limiter.checkRateLimit(mockReq, createMockReply())).toBe(true);
      expect(await limiter.checkRateLimit(mockReq, createMockReply())).toBe(true);

      // Request 4 should be throttled
      const reply4 = createMockReply();
      const allowed4 = await limiter.checkRateLimit(mockReq, reply4);
      expect(allowed4).toBe(false);
      expect(reply4.statusCode).toBe(429);
      expect(reply4.headers["Retry-After"]).toBeDefined();
      expect(reply4.body?.error).toContain("Too many requests");
    });

    it("never throttles health probes /health, /healthz, /readyz", async () => {
      const createReq = (url: string) => ({ url, headers: {}, ip: "1.2.3.4" } as unknown as FastifyRequest);
      const reply = { status: vi.fn(), header: vi.fn(), send: vi.fn() } as unknown as FastifyReply;

      for (let i = 0; i < 10; i++) {
        expect(await limiter.checkRateLimit(createReq("/healthz"), reply)).toBe(true);
        expect(await limiter.checkRateLimit(createReq("/readyz"), reply)).toBe(true);
        expect(await limiter.checkRateLimit(createReq("/health"), reply)).toBe(true);
      }
    });
  });

  describe("Same-Origin & Sec-Fetch-Site Guard", () => {
    it("allows safe read methods GET, HEAD, OPTIONS without check", async () => {
      const req = { method: "GET", url: "/api/overview", headers: {} } as unknown as FastifyRequest;
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as FastifyReply;
      expect(await verifySameOrigin(req, reply)).toBe(true);
    });

    it("blocks cross-site state mutation with Sec-Fetch-Site: cross-site", async () => {
      const req = {
        method: "POST",
        url: "/api/settings",
        headers: { "sec-fetch-site": "cross-site", host: "app.example.com" },
      } as unknown as FastifyRequest;
      let sentBody: { error?: string } | undefined;
      let statusCode = 200;
      interface MockCsrfReply {
        status: (code: number) => MockCsrfReply;
        send: (body: { error?: string }) => void;
      }
      const reply: MockCsrfReply = {
        status: (code: number) => {
          statusCode = code;
          return reply;
        },
        send: (body: { error?: string }) => {
          sentBody = body;
        },
      };

      const allowed = await verifySameOrigin(req, reply as unknown as FastifyReply);
      expect(allowed).toBe(false);
      expect(statusCode).toBe(403);
      expect(sentBody?.error).toContain("cross-site requests are not permitted");
    });

    it("blocks mutating requests with mismatched Origin header in production", async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalKey = process.env.XAI_API_KEY;
      process.env.NODE_ENV = "production";
      process.env.XAI_API_KEY = "test-key-prod";
      try {
        const req = {
          method: "POST",
          url: "/api/channel/pause",
          headers: {
            host: "production.example.com",
            origin: "https://attacker.evil.com",
          },
        } as unknown as FastifyRequest;
        let statusCode = 200;
        const reply = {
          status: (code: number) => {
            statusCode = code;
            return reply;
          },
          send: vi.fn(),
        } as unknown as FastifyReply;

        const allowed = await verifySameOrigin(req, reply);
        expect(allowed).toBe(false);
        expect(statusCode).toBe(403);
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.XAI_API_KEY = originalKey;
      }
    });

    it("allows mutating requests when Origin matches Host header", async () => {
      const req = {
        method: "POST",
        url: "/api/channel/pause",
        headers: {
          host: "app.example.com",
          origin: "https://app.example.com",
        },
      } as unknown as FastifyRequest;
      const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as FastifyReply;
      const allowed = await verifySameOrigin(req, reply);
      expect(allowed).toBe(true);
    });
  });

  describe("SSE Outbox Broadcaster with Cursor, Heartbeat & Backpressure", () => {
    it("handles connection, sends headers, and broadcasts events with backpressure check", async () => {
      const mockOutboxRepo = {
        getEventsSince: vi.fn().mockResolvedValue([
          { id: "ev-1", eventType: "turn:created", payload: { turnId: "t-1" } },
        ]),
      } as unknown as OutboxRepository;

      const broadcaster = new OutboxBroadcaster(mockOutboxRepo);

      const writtenChunks: string[] = [];
      const mockReply = {
        raw: {
          destroyed: false,
          writable: true,
          setHeader: vi.fn(),
          flushHeaders: vi.fn(),
          write: vi.fn((chunk: string) => {
            writtenChunks.push(chunk);
            return true; // no backpressure
          }),
          on: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as FastifyReply;

      await broadcaster.addClient(mockReply, {
        lastEventId: "0",
        channelAccountId: "acc-1",
      });

      expect(broadcaster.connectedClientsCount).toBe(1);
      expect(mockReply.raw.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");

      // Broadcast a new event
      await broadcaster.broadcast("conversation:status", { conversationId: "c-1", status: "THINKING" }, "ev-2");

      expect(writtenChunks.some((c) => c.includes("conversation:status") && c.includes("THINKING"))).toBe(true);

      broadcaster.stop();
      expect(broadcaster.connectedClientsCount).toBe(0);
    });
  });

  describe("PostgreSQL Job Handlers Execution Flow", () => {
    it("Debounce Handler: skips when inboundVersion is stale; creates turn and enqueues AI job when fresh", async () => {
      const conversationRow = {
        id: "conv-101",
        inboundVersion: 2,
        status: "DEBOUNCING",
        manualMode: false,
        isBlocked: false,
      };

      const channelRow = {
        id: "acc-1",
        status: "RUNNING",
        isPaused: false,
        isSuspended: false,
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn((tbl: unknown) => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => {
                const tableObj = tbl as { _?: { name?: string }; [key: symbol]: unknown } | null | undefined;
                const tableName = tableObj?._?.name || (tableObj?.[Symbol.for("drizzle:Name")] as string | undefined);
                if (tableName === "channel_accounts") return [channelRow];
                return [conversationRow];
              }),
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
        createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-uuid-1" }),
      } as unknown as TurnRepository;

      const mockJobRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: "job-ai-1" }),
      } as unknown as JobRepository;

      const mockOutboxRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: "outbox-1" }),
      } as unknown as OutboxRepository;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({ id: "event-1" }),
      } as unknown as EventRepository;

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      } as unknown as OutboxBroadcaster;

      const debounceHandler = createDebounceHandler({
        db: mockDb,
        turnRepo: mockTurnRepo,
        jobRepo: mockJobRepo,
        outboxRepo: mockOutboxRepo,
        eventRepo: mockEventRepo,
        broadcaster: mockBroadcaster,
      });

      // 1. Stale test: job payload is version 1, but conversation is version 2
      await debounceHandler({
        signal: new AbortController().signal,
        ownerToken: "test-owner",
        fencingEpoch: 1,
        job: {
          id: "job-db-1",
          jobType: "debounce",
          payload: { channelAccountId: "acc-1", conversationId: "conv-101", inboundVersion: 1 },
        } as unknown as Job,
      });

      expect(mockTurnRepo.createOrGetTurn).not.toHaveBeenCalled();
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "AI_CANCELLED_STALE" })
      );

      // 2. Fresh test: job payload matches conversation version 2
      await debounceHandler({
        signal: new AbortController().signal,
        ownerToken: "test-owner",
        fencingEpoch: 1,
        job: {
          id: "job-db-2",
          jobType: "debounce",
          payload: { channelAccountId: "acc-1", conversationId: "conv-101", inboundVersion: 2 },
        } as unknown as Job,
      });

      expect(mockTurnRepo.createOrGetTurn).toHaveBeenCalledWith({
        channelAccountId: "acc-1",
        conversationId: "conv-101",
        inboundVersion: 2,
      });

      expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "ai",
          payload: expect.objectContaining({ conversationId: "conv-101", inboundVersion: 2 }),
        })
      );
    });

    it("AI Handler: generates reply, inserts runs and drafts, and creates outbound action", async () => {
      const convData = {
        conversation: {
          id: "conv-101",
          inboundVersion: 2,
          summary: "Customer looking for sizing",
          manualMode: false,
          isBlocked: false,
        },
        customer: {
          id: "cust-1",
          name: "Nguyen Van A",
        },
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "run-uuid-1" }]),
          })),
        })),
      } as unknown as Database;

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue(convData),
        getRecentMessages: vi.fn().mockResolvedValue([{ direction: "INBOUND", text: "Shop co size L khong?" }]),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepository;

      const mockTurnRepo = {
        claimTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
        transitionStatus: vi.fn().mockResolvedValue({ id: "turn-1", status: "DRAFT_READY" }),
        cancelTurn: vi.fn(),
        failTurn: vi.fn(),
      } as unknown as TurnRepository;

      const mockOutboundRepo = {
        createAction: vi.fn().mockResolvedValue({ actionId: "act-123" }),
      } as unknown as OutboundRepository;

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: { aiModel: "grok-2" },
        }),
      } as unknown as SettingsRepository;

      const mockIncidentRepo = {
        createIncident: vi.fn(),
      } as unknown as IncidentRepository;

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({}),
      } as unknown as EventRepository;

      const mockOutboxRepo = {
        enqueue: vi.fn().mockResolvedValue({}),
      } as unknown as OutboxRepository;

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      } as unknown as OutboxBroadcaster;

      const mockAiGenerator = {
        generateReply: vi.fn().mockResolvedValue({
          success: true,
          model: "grok-2",
          latencyMs: 150,
          promptTokens: 50,
          completionTokens: 30,
          totalTokens: 80,
          data: {
            messages: ["Chao ban, shop con san size L a!"],
          },
        }),
      } as unknown as AiReplyGenerator;

      const aiHandler = createAiHandler({
        db: mockDb,
        convRepo: mockConvRepo,
        turnRepo: mockTurnRepo,
        outboundRepo: mockOutboundRepo,
        settingsRepo: mockSettingsRepo,
        incidentRepo: mockIncidentRepo,
        eventRepo: mockEventRepo,
        outboxRepo: mockOutboxRepo,
        broadcaster: mockBroadcaster,
        aiGenerator: mockAiGenerator,
      });

      await aiHandler({
        signal: new AbortController().signal,
        ownerToken: "worker-token",
        fencingEpoch: 1,
        job: {
          id: "job-ai-1",
          jobType: "ai",
          payload: {
            channelAccountId: "acc-1",
            conversationId: "conv-101",
            inboundVersion: 2,
            turnId: "turn-1",
          },
        } as unknown as Job,
      });

      expect(mockTurnRepo.claimTurn).toHaveBeenCalledWith("turn-1", "worker-token");
      expect(mockAiGenerator.generateReply).toHaveBeenCalled();
      expect(mockOutboundRepo.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-101",
          text: "Chao ban, shop con san size L a!",
          actor: "AI",
        })
      );
      expect(mockTurnRepo.transitionStatus).toHaveBeenCalledWith(
        "turn-1",
        "THINKING",
        "DRAFT_READY",
        "worker-token",
        1
      );
      expect(mockConvRepo.updateStatus).toHaveBeenCalledWith("conv-101", "DRAFT_READY");
    });

    it("Reconcile Handler: invokes stale job reconciliation and cleans expired leases", async () => {
      const mockJobRepo = {
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 2, failed: 1 }),
      } as unknown as JobRepository;

      const mockDb = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      } as unknown as Database;

      const mockEventRepo = { recordEvent: vi.fn() } as unknown as EventRepository;
      const mockOutboxRepo = {} as unknown as OutboxRepository;
      const mockBroadcaster = { broadcast: vi.fn() } as unknown as OutboxBroadcaster;

      const reconcileHandler = createReconcileHandler({
        db: mockDb,
        jobRepo: mockJobRepo,
        eventRepo: mockEventRepo,
        outboxRepo: mockOutboxRepo,
        broadcaster: mockBroadcaster,
      });

      const stats = await reconcileHandler();
      expect(mockJobRepo.reconcileStaleJobs).toHaveBeenCalled();
      expect(stats.reconciledJobs).toEqual({ recovered: 2, failed: 1 });
    });

    it("Outbox Handler: dispatches claimed batch to broadcaster and completes batch", async () => {
      const eventsBatch = [
        { id: "outbox-1", eventType: "inbound:received", payload: { msg: "hi" } },
        { id: "outbox-2", eventType: "conversation:status", payload: { status: "THINKING" } },
      ];

      const mockOutboxRepo = {
        claimBatch: vi.fn().mockResolvedValue(eventsBatch),
        completeBatch: vi.fn().mockResolvedValue(2),
        failEvent: vi.fn(),
      } as unknown as OutboxRepository;

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      } as unknown as OutboxBroadcaster;

      const outboxHandler = createOutboxHandler({
        outboxRepo: mockOutboxRepo,
        broadcaster: mockBroadcaster,
      });

      const result = await outboxHandler();
      expect(result.processed).toBe(2);
      expect(mockBroadcaster.broadcast).toHaveBeenCalledTimes(2);
      expect(mockOutboxRepo.completeBatch).toHaveBeenCalledWith(["outbox-1", "outbox-2"]);
    });

    it("Retention Handler: prunes completed jobs and processed outbox events", async () => {
      const mockJobRepo = {
        cleanOldJobs: vi.fn().mockResolvedValue(15),
      } as unknown as JobRepository;

      const mockOutboxRepo = {
        cleanProcessedEvents: vi.fn().mockResolvedValue(30),
      } as unknown as OutboxRepository;

      const retentionHandler = createRetentionHandler({
        jobRepo: mockJobRepo,
        outboxRepo: mockOutboxRepo,
      });

      const result = await retentionHandler();
      expect(mockJobRepo.cleanOldJobs).toHaveBeenCalledWith(7);
      expect(mockOutboxRepo.cleanProcessedEvents).toHaveBeenCalledWith(7);
      expect(result).toEqual({ cleanedJobs: 15, cleanedOutboxEvents: 30 });
    });
  });

  describe("Core Fastify API Endpoints Integration (inject)", () => {
    interface MockRecord {
      id: string;
      email: string;
      name: string;
      role: string;
      conversation: { id: string; manualMode: boolean; status: string };
      customer: { id: string; name: string };
      queue: {
        id: string;
        queuedAt: Date;
        readyAt: Date;
        inboundVersion: number;
        attempt: number;
        continuationEligibleUntil: Date | null;
        stickyTurns: number;
        yieldRequired: boolean;
      };
      conv: { id: string };
      cust: { name: string };
      queuedAt: Date;
      estimatedWaitSeconds: number;
      count: number;
      [key: string]: unknown;
    }

    interface QueryChain {
      from: ReturnType<typeof vi.fn>;
      innerJoin: ReturnType<typeof vi.fn>;
      leftJoin: ReturnType<typeof vi.fn>;
      where: ReturnType<typeof vi.fn>;
      orderBy: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
      offset: ReturnType<typeof vi.fn>;
      then: (resolve: (val: unknown[]) => unknown) => unknown;
      [Symbol.iterator]: () => Generator<unknown, void, unknown>;
    }

    interface MockDb {
      execute: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    }

    let mockDb: MockDb & Database;
    let userRecord: MockRecord;

    beforeEach(() => {
      userRecord = {
        id: "11111111-1111-1111-1111-111111111111",
        email: "test@example.com",
        name: "Test User",
        role: "OWNER",
        conversation: { id: "c-1", manualMode: false, status: "QUEUED" },
        customer: { id: "cust-1", name: "Cust" },
        queue: {
          id: "q-1",
          queuedAt: new Date(),
          readyAt: new Date(),
          inboundVersion: 1,
          attempt: 1,
          continuationEligibleUntil: null,
          stickyTurns: 0,
          yieldRequired: false,
        },
        conv: { id: "c-1" },
        cust: { name: "Cust" },
        queuedAt: new Date(),
        estimatedWaitSeconds: 5,
        count: 1,
      };

      const createChain = (): QueryChain => {
        const chain: QueryChain = {
          from: vi.fn(() => chain),
          innerJoin: vi.fn(() => chain),
          leftJoin: vi.fn(() => chain),
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          offset: vi.fn(() => chain),
          then: (resolve: (val: unknown[]) => unknown) => resolve([userRecord]),
          [Symbol.iterator]: function* () {
            yield userRecord;
          },
        };
        return chain;
      };

      mockDb = {
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
        transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
      } as unknown as MockDb & Database;
    });

    it("GET /healthz verifies process liveness (200 OK)", async () => {
      const serverContext = await buildCoreServer({ db: mockDb });
      const res = await serverContext.fastify.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.status).toBe("ok");
      expect(json.uptime).toBeDefined();

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });

    it("GET /readyz queries database SELECT 1 (200 when up, 503 when down)", async () => {
      const serverContext = await buildCoreServer({ db: mockDb });

      // 1. Success case
      const resSuccess = await serverContext.fastify.inject({
        method: "GET",
        url: "/readyz",
      });
      expect(resSuccess.statusCode).toBe(200);
      expect(JSON.parse(resSuccess.payload)).toEqual(
        expect.objectContaining({ status: "ready", database: true })
      );

      // 2. Failure case
      mockDb.execute.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
      const resFail = await serverContext.fastify.inject({
        method: "GET",
        url: "/readyz",
      });
      expect(resFail.statusCode).toBe(503);
      expect(JSON.parse(resFail.payload)).toEqual(
        expect.objectContaining({ status: "unready", database: false })
      );

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });

    it("Fail-closed Cloudflare auth in production blocks unauthorized requests with 401", async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalKey = process.env.XAI_API_KEY;
      process.env.NODE_ENV = "production";
      process.env.XAI_API_KEY = "test-xai-api-key-production";
      try {
        const serverContext = await buildCoreServer({ db: mockDb });

        const res = await serverContext.fastify.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: {}, // No Cloudflare header
        });

        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload).error).toContain("Missing Cloudflare Access assertion header");

        serverContext.rateLimiter.destroy();
        serverContext.broadcaster.stop();
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.XAI_API_KEY = originalKey;
        resetEnvCache();
      }
    });

    it("Role guards: VIEWER can read /api/overview but is blocked on POST /api/channel/pause (403)", async () => {
      userRecord.role = "VIEWER";
      const serverContext = await buildCoreServer({ db: mockDb });

      // Read endpoint allowed for VIEWER
      const resGet = await serverContext.fastify.inject({
        method: "GET",
        url: "/api/overview",
        headers: {
          "cf-access-authenticated-user-email": "viewer@example.com",
        },
      });
      expect(resGet.statusCode).toBe(200);

      // Mutating endpoint requiring OPERATOR blocked for VIEWER
      const resPost = await serverContext.fastify.inject({
        method: "POST",
        url: "/api/channel/pause",
        headers: {
          "cf-access-authenticated-user-email": "viewer@example.com",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
      });

      expect(resPost.statusCode).toBe(403);
      const json = JSON.parse(resPost.payload);
      expect(json.error).toContain("insufficient role permissions");
      expect(json.requiredRole).toBe("OPERATOR");
      expect(json.currentRole).toBe("VIEWER");

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });

    it("Role guards: OPERATOR can pause channel but is blocked on POST /api/settings (403 required OWNER)", async () => {
      userRecord.role = "OPERATOR";
      const serverContext = await buildCoreServer({ db: mockDb });

      // Operator can perform operational actions
      const resPause = await serverContext.fastify.inject({
        method: "POST",
        url: "/api/channel/pause",
        headers: {
          "cf-access-authenticated-user-email": "operator@example.com",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
      });
      expect(resPause.statusCode).toBe(200);

      // Operator cannot update system settings (requires OWNER)
      const resSettings = await serverContext.fastify.inject({
        method: "POST",
        url: "/api/settings",
        headers: {
          "cf-access-authenticated-user-email": "operator@example.com",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        payload: { debounceMs: 5000 },
      });

      expect(resSettings.statusCode).toBe(403);
      const json = JSON.parse(resSettings.payload);
      expect(json.error).toContain("insufficient role permissions");
      expect(json.requiredRole).toBe("OWNER");

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });

    it("Pagination metadata: returns items/conversations with total, limit, offset, and hasMore", async () => {
      const serverContext = await buildCoreServer({ db: mockDb });

      const resInbox = await serverContext.fastify.inject({
        method: "GET",
        url: "/api/inbox?limit=10&offset=0",
        headers: {
          "cf-access-authenticated-user-email": "owner@example.com",
        },
      });

      expect(resInbox.statusCode).toBe(200);
      const inboxJson = JSON.parse(resInbox.payload);
      expect(inboxJson).toHaveProperty("conversations");
      expect(inboxJson).toHaveProperty("total");
      expect(inboxJson).toHaveProperty("limit", 10);
      expect(inboxJson).toHaveProperty("offset", 0);
      expect(inboxJson).toHaveProperty("hasMore");

      const resIncidents = await serverContext.fastify.inject({
        method: "GET",
        url: "/api/incidents?limit=25&offset=5",
        headers: {
          "cf-access-authenticated-user-email": "owner@example.com",
        },
      });

      expect(resIncidents.statusCode).toBe(200);
      const incidentsJson = JSON.parse(resIncidents.payload);
      expect(incidentsJson).toHaveProperty("items");
      expect(incidentsJson).toHaveProperty("total");
      expect(incidentsJson).toHaveProperty("limit", 25);
      expect(incidentsJson).toHaveProperty("offset", 5);

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });
  });
});
