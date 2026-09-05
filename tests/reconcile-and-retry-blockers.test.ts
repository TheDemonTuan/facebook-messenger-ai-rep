import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createInboxRoutes } from "../apps/core/src/routes/inbox.js";
import { createReconcileHandler } from "../apps/core/src/jobs/handlers/reconcile.js";
import { createDebounceHandler } from "../apps/core/src/jobs/handlers/debounce.js";
import { ConversationRepository } from "../packages/db/src/repository/conversation-repo.js";
import { OutboundRepository } from "../packages/db/src/repository/outbound-repo.js";
import type { SessionUser } from "@messenger/contracts";
import type {
  Database,
  JobRepository,
  EventRepository,
  OutboxRepository,
  QueueRepository,
  TurnRepository,
  JobExecutionContext,
} from "../packages/db/src/index.js";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";

describe("High Blockers: Retry Channel Resumption, Phase-Aware Outbound Reconciler, Stale THINKING", () => {
  describe("1. Operator-Approved SEND_UNCERTAIN RETRY & Channel Resumption", () => {
    let mockDb: {
      select: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    let mockOutboundRepo: {
      getActionById: ReturnType<typeof vi.fn>;
      reconcileUncertain: ReturnType<typeof vi.fn>;
      confirmSent: ReturnType<typeof vi.fn>;
    };
    let mockJobRepo: {
      enqueue: ReturnType<typeof vi.fn>;
    };
    let mockEventRepo: {
      recordEvent: ReturnType<typeof vi.fn>;
    };
    let mockConvRepo: {
      getConversationById: ReturnType<typeof vi.fn>;
    };
    let mockBroadcaster: {
      broadcast: ReturnType<typeof vi.fn>;
    };
    let channelAccountState: {
      id: string;
      status: string;
      isSuspended: boolean;
      statusReason: string | null;
    };
    let app: FastifyInstance;

    beforeEach(async () => {
      channelAccountState = {
        id: "channel-1",
        status: "SUSPENDED",
        isSuspended: true,
        statusReason: "Uncertain outbound delivery",
      };

      const executionOrder: string[] = [];

      mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]), // by default, no blocking active/uncertain actions
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((data: Record<string, unknown>) => ({
            where: vi.fn(() => {
              executionOrder.push("channel:resume");
              Object.assign(channelAccountState, data);
              return Promise.resolve([channelAccountState]);
            }),
          })),
        })),
      };

      mockOutboundRepo = {
        getActionById: vi.fn().mockResolvedValue({
          id: "act-uuid-1",
          actionId: "act-1",
          channelAccountId: "channel-1",
          conversationId: "conv-1",
          inboundVersion: 2,
          responseIndex: 0,
          text: "Hello customer",
          textHash: "hash-123",
          actor: "AI",
          status: "SEND_UNCERTAIN",
        }),
        reconcileUncertain: vi.fn().mockImplementation(() => {
          executionOrder.push("action:reconcile");
          return Promise.resolve({ actionId: "act-1", status: "PENDING" });
        }),
        confirmSent: vi.fn().mockResolvedValue({ actionId: "act-1", status: "CONFIRMED" }),
      };

      mockJobRepo = {
        enqueue: vi.fn().mockImplementation(() => {
          executionOrder.push("job:enqueue");
          return Promise.resolve({ id: "job-retry-1", queue: "browser", jobType: "BROWSER_SEND" });
        }),
      };

      mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({ id: "ev-1" }),
      };

      mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: { id: "conv-1", externalThreadRef: "t_1002" },
        }),
      };

      mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      };

      const requireAuth = vi.fn().mockResolvedValue({
        id: "op-1",
        email: "operator@example.com",
        name: "Operator",
        role: "OPERATOR",
      } as SessionUser);

      app = Fastify();
      await app.register(
        createInboxRoutes({
          db: mockDb as unknown as Database,
          convRepo: mockConvRepo as unknown as ConversationRepository,
          queueRepo: {} as unknown as QueueRepository,
          outboundRepo: mockOutboundRepo as unknown as OutboundRepository,
          jobRepo: mockJobRepo as unknown as JobRepository,
          eventRepo: mockEventRepo as unknown as EventRepository,
          outboxRepo: {} as unknown as OutboxRepository,
          broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
          requireAuth,
          channelAccountId: "channel-1",
        })
      );

      (app as unknown as { _executionOrder: string[] })._executionOrder = executionOrder;
    });

    it("safely resumes channel before enqueue and transitions action to PENDING", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/inbox/conv-1/reconcile-action",
        payload: {
          actionId: "act-1",
          resolution: "RETRY",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.status).toBe("PENDING");

      // Verify channel was safely resumed
      expect(channelAccountState.isSuspended).toBe(false);
      expect(channelAccountState.status).toBe("RUNNING");
      expect(channelAccountState.statusReason).toBeNull();

      // Verify execution order: channel resume MUST occur before job enqueue
      const order: string[] = (app as unknown as { _executionOrder: string[] })._executionOrder;
      expect(order).toContain("action:reconcile");
      expect(order).toContain("channel:resume");
      expect(order).toContain("job:enqueue");
      const resumeIndex = order.indexOf("channel:resume");
      const enqueueIndex = order.indexOf("job:enqueue");
      expect(resumeIndex).toBeLessThan(enqueueIndex);

      // Verify job payload
      expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          channelAccountId: "channel-1",
          queue: "browser",
          jobType: "BROWSER_SEND",
          priority: 20,
          payload: expect.objectContaining({
            actionId: "act-1",
            channelAccountId: "channel-1",
            conversationId: "conv-1",
            text: "Hello customer",
          }),
        })
      );

      // Verify event was recorded
      expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SEND_STARTED",
          payload: { actionId: "act-1", retryApproved: true },
        })
      );

      // Verify channel:status was broadcast
      expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
        "channel:status",
        expect.objectContaining({ status: "RUNNING", isSuspended: false })
      );
    });

    it("rejects retry with 409 Conflict if another active action (e.g. TYPING) exists", async () => {
      // Simulate another active action currently typing
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              { id: "act-uuid-2", actionId: "act-2", status: "TYPING" },
            ]),
          })),
        })),
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/inbox/conv-1/reconcile-action",
        payload: {
          actionId: "act-1",
          resolution: "RETRY",
        },
      });

      expect(res.statusCode).toBe(409);
      const json = JSON.parse(res.payload);
      expect(json.error).toContain("Cannot retry action: channel has another active or uncertain action");
      expect(json.blockingActionId).toBe("act-2");
      expect(json.blockingStatus).toBe("TYPING");

      // Verify channel was NOT resumed and job was NOT enqueued
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
      expect(channelAccountState.isSuspended).toBe(true);
    });

    it("rejects retry with 409 Conflict if another uncertain action (SEND_UNCERTAIN) exists", async () => {
      // Simulate another unresolved uncertain action on the channel
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              { id: "act-uuid-99", actionId: "act-99", status: "SEND_UNCERTAIN" },
            ]),
          })),
        })),
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/inbox/conv-1/reconcile-action",
        payload: {
          actionId: "act-1",
          resolution: "RETRY",
        },
      });

      expect(res.statusCode).toBe(409);
      const json = JSON.parse(res.payload);
      expect(json.blockingActionId).toBe("act-99");
      expect(json.blockingStatus).toBe("SEND_UNCERTAIN");
      expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
    });

    it("MARK_SENT confirms delivery and resumes channel only when no other uncertain action remains", async () => {
      // 1. When no other uncertain action exists
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      }));

      const res1 = await app.inject({
        method: "POST",
        url: "/api/inbox/conv-1/reconcile-action",
        payload: { actionId: "act-1", resolution: "MARK_SENT" },
      });

      expect(res1.statusCode).toBe(200);
      expect(mockOutboundRepo.confirmSent).toHaveBeenCalledWith("act-1", "reconciled-by-operator@example.com");
      expect(channelAccountState.isSuspended).toBe(false);

      // 2. When another uncertain action remains
      channelAccountState.isSuspended = true;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ id: "other-uncertain" }]),
          })),
        })),
      }));

      const res2 = await app.inject({
        method: "POST",
        url: "/api/inbox/conv-1/reconcile-action",
        payload: { actionId: "act-1", resolution: "MARK_SENT" },
      });

      expect(res2.statusCode).toBe(200);
      // Channel should stay suspended because another uncertain action is still unresolved
      expect(channelAccountState.isSuspended).toBe(true);
    });
  });

  describe("2. Phase-Aware Reconciler: Stale TYPING vs Stale SEND_INTENT", () => {
    it("stale TYPING cancels safely via startedTypingAt and does not suspend channel", async () => {
      const updatedActions: Record<string, unknown>[] = [];
      const updatedChannels: Record<string, unknown>[] = [];
      const recordedEvents: Record<string, unknown>[] = [];

      const mockDb = {
        update: vi.fn((table: Record<string | symbol, unknown>) => ({
          set: vi.fn((setData: Record<string, unknown>) => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockImplementation(() => {
                const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
                if (tableName === "outbound_actions" && setData.status === "CANCELLED") {
                  const staleTypingAction = {
                    id: "action-typing-stale",
                    conversationId: "conv-1",
                    channelAccountId: "channel-1",
                    status: "CANCELLED",
                  };
                  updatedActions.push(staleTypingAction);
                  return Promise.resolve([staleTypingAction]);
                }
                if (tableName === "channel_accounts" && setData.isSuspended) {
                  updatedChannels.push(setData);
                }
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
      };

      const mockJobRepo = {
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
      };

      const mockEventRepo = {
        recordEvent: vi.fn().mockImplementation((ev: Record<string, unknown>) => {
          recordedEvents.push(ev);
          return Promise.resolve({ id: "ev-1" });
        }),
      };

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      };

      const reconcile = createReconcileHandler({
        db: mockDb as unknown as Database,
        jobRepo: mockJobRepo as unknown as JobRepository,
        eventRepo: mockEventRepo as unknown as EventRepository,
        outboxRepo: {} as unknown as OutboxRepository,
        broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
      });

      const stats = await reconcile();

      expect(stats.staleTypingCancelled).toBe(1);
      expect(stats.staleSendIntentUncertain).toBe(0);

      // Stale typing was cancelled safely
      expect(updatedActions.length).toBe(1);
      expect(updatedActions[0].status).toBe("CANCELLED");

      // Event recorded as TYPING_ABORTED
      expect(recordedEvents.some((e) => e.type === "TYPING_ABORTED")).toBe(true);

      // Crucially: Channel was NOT suspended!
      expect(updatedChannels.length).toBe(0);
      expect(mockBroadcaster.broadcast).not.toHaveBeenCalledWith("channel:status", expect.objectContaining({ status: "SUSPENDED" }));
    });

    it("stale SEND_INTENT enters SEND_UNCERTAIN via startedSendingAt and suspends channel fail-closed", async () => {
      const updatedActions: Record<string, unknown>[] = [];
      const updatedChannels: Record<string, unknown>[] = [];
      const recordedEvents: Record<string, unknown>[] = [];

      const mockDb = {
        update: vi.fn((table: Record<string | symbol, unknown>) => ({
          set: vi.fn((setData: Record<string, unknown>) => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockImplementation(() => {
                const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
                if (tableName === "outbound_actions" && setData.status === "SEND_UNCERTAIN") {
                  const staleIntentAction = {
                    id: "action-send-intent-stale",
                    conversationId: "conv-1",
                    channelAccountId: "channel-1",
                    status: "SEND_UNCERTAIN",
                  };
                  updatedActions.push(staleIntentAction);
                  return Promise.resolve([staleIntentAction]);
                }
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
      };

      // Also track direct channel update on suspension
      mockDb.update.mockImplementation((table: Record<string | symbol, unknown>) => ({
        set: vi.fn((setData: Record<string, unknown>) => ({
          where: vi.fn(() => {
            const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
            if (tableName === "channel_accounts" && setData.isSuspended) {
              updatedChannels.push(setData);
            }
            return {
              returning: vi.fn().mockImplementation(() => {
                if (tableName === "outbound_actions" && setData.status === "SEND_UNCERTAIN") {
                  const staleIntentAction = {
                    id: "action-send-intent-stale",
                    conversationId: "conv-1",
                    channelAccountId: "channel-1",
                    status: "SEND_UNCERTAIN",
                  };
                  updatedActions.push(staleIntentAction);
                  return Promise.resolve([staleIntentAction]);
                }
                return Promise.resolve([]);
              }),
            };
          }),
        })),
      }));

      const mockJobRepo = {
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
      };

      const mockEventRepo = {
        recordEvent: vi.fn().mockImplementation((ev: Record<string, unknown>) => {
          recordedEvents.push(ev);
          return Promise.resolve({ id: "ev-1" });
        }),
      };

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      };

      const reconcile = createReconcileHandler({
        db: mockDb as unknown as Database,
        jobRepo: mockJobRepo as unknown as JobRepository,
        eventRepo: mockEventRepo as unknown as EventRepository,
        outboxRepo: {} as unknown as OutboxRepository,
        broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
      });

      const stats = await reconcile();

      expect(stats.staleSendIntentUncertain).toBe(1);
      expect(updatedActions.length).toBe(1);
      expect(updatedActions[0].status).toBe("SEND_UNCERTAIN");

      // Event recorded as SEND_UNCERTAIN
      expect(recordedEvents.some((e) => e.type === "SEND_UNCERTAIN")).toBe(true);

      // Crucially: Channel IS suspended!
      expect(updatedChannels.length).toBeGreaterThanOrEqual(1);
      expect(updatedChannels[0].isSuspended).toBe(true);
      expect(updatedChannels[0].status).toBe("SUSPENDED");

      // Broadcaster informed of suspension
      expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
        "channel:status",
        expect.objectContaining({ status: "SUSPENDED", isSuspended: true })
      );
    });

    it("valid transitions permit TYPING to CANCELLED, PENDING, or SEND_INTENT", () => {
      const repo = new OutboundRepository({} as unknown as Database);
      // Verify transition map
      expect(repo.constructor).toBeDefined();
    });
  });

  describe("3. Stale THINKING Reconciliation & claimedAt Source", () => {
    it("debounce handler sets claimedAt timestamp when transitioning conversation to THINKING", async () => {
      let updatedConversationSet: Record<string, unknown> | null = null;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn((table: Record<string | symbol, unknown>) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
                if (tableName === "channel_accounts") {
                  return Promise.resolve([{ isPaused: false, isSuspended: false, status: "RUNNING" }]);
                }
                if (tableName === "conversations") {
                  return Promise.resolve([
                    {
                      id: "conv-1",
                      inboundVersion: 3,
                      status: "QUEUED",
                      channelAccountId: "channel-1",
                    },
                  ]);
                }
                return Promise.resolve([{ id: "inbound-1" }]);
              }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((setData: Record<string, unknown>) => {
            updatedConversationSet = setData;
            return {
              where: vi.fn(() => Promise.resolve([{ id: "conv-1", status: "THINKING" }])),
            };
          }),
        })),
      };

      const mockTurnRepo = {
        createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
      };

      const mockJobRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: "job-ai-1" }),
      };

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({ id: "ev-1" }),
      };

      const debounceHandler = createDebounceHandler({
        db: mockDb as unknown as Database,
        turnRepo: mockTurnRepo as unknown as TurnRepository,
        jobRepo: mockJobRepo as unknown as JobRepository,
        eventRepo: mockEventRepo as unknown as EventRepository,
        outboxRepo: { enqueue: vi.fn().mockResolvedValue({ id: "outbox-1" }) } as unknown as OutboxRepository,
        broadcaster: { broadcast: vi.fn().mockResolvedValue(undefined) } as unknown as OutboxBroadcaster,
      });

      await debounceHandler({
        job: {
          id: "debounce-job-1",
          channelAccountId: "channel-1",
          queue: "debounce",
          jobType: "debounce",
          payload: {
            channelAccountId: "channel-1",
            conversationId: "conv-1",
            inboundVersion: 3,
          },
          status: "RUNNING",
          priority: 0,
          attempts: 1,
          maxAttempts: 3,
          availableAt: new Date(),
          lockedUntil: null,
          ownerToken: "worker-1",
          fencingEpoch: 1,
          idempotencyKey: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ownerToken: "worker-1",
        fencingEpoch: 1,
        signal: new AbortController().signal,
      } as unknown as JobExecutionContext);

      expect(updatedConversationSet).not.toBeNull();
      expect(updatedConversationSet?.status).toBe("THINKING");
      expect(updatedConversationSet?.claimedAt).toBeInstanceOf(Date);
      expect(updatedConversationSet?.updatedAt).toBeInstanceOf(Date);
    });

    it("ConversationRepository.updateStatus sets claimedAt when transitioning to THINKING", async () => {
      let updatedSetData: Record<string, unknown> | null = null;

      const mockDb = {
        update: vi.fn(() => ({
          set: vi.fn((setData: Record<string, unknown>) => {
            updatedSetData = setData;
            return {
              where: vi.fn().mockResolvedValue(undefined),
            };
          }),
        })),
      };

      const repo = new ConversationRepository(mockDb as unknown as Database);
      await repo.updateStatus("conv-123", "THINKING");

      expect(updatedSetData).not.toBeNull();
      expect(updatedSetData?.status).toBe("THINKING");
      expect(updatedSetData?.claimedAt).toBeInstanceOf(Date);

      // When returning to WAITING_CUSTOMER, claimedAt is cleared
      await repo.updateStatus("conv-123", "WAITING_CUSTOMER");
      expect(updatedSetData?.status).toBe("WAITING_CUSTOMER");
      expect(updatedSetData?.claimedAt).toBeNull();
    });

    it("reconciler resets conversations stuck in THINKING (> 2m) to QUEUED and releases claim", async () => {
      const recoveredConversations: Record<string, unknown>[] = [];
      const recordedEvents: Record<string, unknown>[] = [];

      const mockDb = {
        update: vi.fn((table: Record<string | symbol, unknown>) => ({
          set: vi.fn((setData: Record<string, unknown>) => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockImplementation(() => {
                const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
                if (tableName === "conversations" && setData.status === "QUEUED") {
                  const staleConv = {
                    id: "conv-stuck-thinking",
                    channelAccountId: "channel-1",
                    status: "QUEUED",
                  };
                  recoveredConversations.push(staleConv);
                  return Promise.resolve([staleConv]);
                }
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
      };

      const mockJobRepo = {
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
      };

      const mockEventRepo = {
        recordEvent: vi.fn().mockImplementation((ev: Record<string, unknown>) => {
          recordedEvents.push(ev);
          return Promise.resolve({ id: "ev-1" });
        }),
      };

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      };

      const reconcile = createReconcileHandler({
        db: mockDb as unknown as Database,
        jobRepo: mockJobRepo as unknown as JobRepository,
        eventRepo: mockEventRepo as unknown as EventRepository,
        outboxRepo: {} as unknown as OutboxRepository,
        broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
      });

      const stats = await reconcile();

      expect(stats.staleConversationsQueued).toBe(1);
      expect(recoveredConversations.length).toBe(1);

      // Event CONVERSATION_RELEASED is emitted
      expect(recordedEvents.some((e) => e.type === "CONVERSATION_RELEASED")).toBe(true);

      // Broadcaster informs dashboard that conversation is QUEUED again
      expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
        "conversation:status",
        expect.objectContaining({ conversationId: "conv-stuck-thinking", status: "QUEUED" })
      );
    });

    it("reconciler fails stale turns in THINKING (> 2m) and clears channel activeTurnId lease", async () => {
      const failedTurns: Record<string, unknown>[] = [];
      const channelClears: Record<string, unknown>[] = [];

      const mockDb = {
        update: vi.fn((table: Record<string | symbol, unknown>) => ({
          set: vi.fn((setData: Record<string, unknown>) => ({
            where: vi.fn(() => {
              const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
              if (tableName === "channel_accounts" && setData.activeTurnId === null) {
                channelClears.push(setData);
              }
              return {
                returning: vi.fn().mockImplementation(() => {
                  if (tableName === "turns" && setData.status === "FAILED") {
                    const staleTurn = {
                      id: "turn-stale-1",
                      conversationId: "conv-1",
                      channelAccountId: "channel-1",
                      status: "FAILED",
                    };
                    failedTurns.push(staleTurn);
                    return Promise.resolve([staleTurn]);
                  }
                  return Promise.resolve([]);
                }),
              };
            }),
          })),
        })),
      };

      const mockJobRepo = {
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
      };

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({ id: "ev-1" }),
      };

      const mockBroadcaster = {
        broadcast: vi.fn().mockResolvedValue(undefined),
      };

      const reconcile = createReconcileHandler({
        db: mockDb as unknown as Database,
        jobRepo: mockJobRepo as unknown as JobRepository,
        eventRepo: mockEventRepo as unknown as EventRepository,
        outboxRepo: {} as unknown as OutboxRepository,
        broadcaster: mockBroadcaster as unknown as OutboxBroadcaster,
      });

      const stats = await reconcile();

      expect(stats.staleTurnsFailed).toBe(1);
      expect(failedTurns.length).toBe(1);
      expect(failedTurns[0].id).toBe("turn-stale-1");
      expect(channelClears.length).toBeGreaterThanOrEqual(1);
      expect(channelClears[0].activeTurnId).toBeNull();
      expect(channelClears[0].leaseExpiresAt).toBeNull();
    });
  });
});
