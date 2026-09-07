import { describe, it, expect, vi } from "vitest";
import { ConversationControlService } from "../packages/db/src/service/conversation-control-service.js";
import { createHumanFallbackHandler } from "../apps/core/src/jobs/handlers/human-fallback.js";
import type { Database, JobRepository, EventRepository, OutboxRepository, JobExecutionContext } from "@messenger/db";
import { conversations, conversationQueue, jobs, outboundActions } from "../packages/db/src/schema/index.js";

describe("Human Handoff & Auto Resume Tests (H1 - H8)", () => {
  // Mock DB factory
  function createMockDb(initialConv: Record<string, unknown> = {}) {
    const state = {
      conv: {
        id: "conv-h-1",
        channelAccountId: "acc-1",
        inboundVersion: 1,
        controlEpoch: 1,
        replyControlMode: "AUTO",
        manualMode: false,
        status: "WAITING_CUSTOMER",
        humanHoldUntil: null as Date | null,
        humanSessionStartedAt: null as Date | null,
        humanSessionLastActivityAt: null as Date | null,
        draftLeaseExpiresAt: null as Date | null,
        suppressedThroughInboundVersion: 0,
        isBlocked: false,
        lastInboundAt: new Date(),
        lastHumanOutboundAt: null as Date | null,
        ...initialConv,
      },
      updates: [] as Record<string, unknown>[],
      jobs: [] as Record<string, unknown>[],
      events: [] as Record<string, unknown>[],
      cancelledActions: [] as string[],
    };

    const mockTx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([state.conv]),
          })),
        })),
      })),
      update: vi.fn((table) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          state.updates.push(values);
          const name = (table as any)?.[Symbol.for("drizzle:Name")] || (table as any)?._?.name || (table as any)?.name;
          if (name === "conversations" || table === conversations || (!name && ("replyControlMode" in values || "manualMode" in values))) {
            Object.assign(state.conv, values);
          }
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((val: Record<string, unknown>) => {
          state.jobs.push(val);
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          };
        }),
      })),
    };

    const mockDb = {
      ...mockTx,
      transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    } as unknown as Database;

    return { mockDb, state };
  }

  // H1: AUTO -> customer inbound -> AI queued -> human outbound -> AI cancelled, HUMAN_SESSION
  it("H1: human outbound cancels active AI and transitions to HUMAN_SESSION", async () => {
    const { mockDb, state } = createMockDb({ replyControlMode: "AUTO", controlEpoch: 5 });
    const controlService = new ConversationControlService(mockDb);

    const control = await controlService.acquireOrRefreshSession("conv-h-1", {
      outboundRef: "msg-ext-1",
      holdDurationMs: 120_000,
    });

    expect(control.mode).toBe("HUMAN_SESSION");
    expect(control.epoch).toBe(6);
    expect(state.conv.replyControlMode).toBe("HUMAN_SESSION");
    expect(state.conv.manualMode).toBe(true);
    expect(state.conv.status).toBe("MANUAL");
    expect(control.holdUntil).toBeDefined();
  });

  // H2: HUMAN_SESSION expires -> customer sends -> normalize AUTO -> same inbound gets debounce, AI replies
  it("H2: expired HUMAN_SESSION normalizes to AUTO immediately without requiring customer to re-send twice", async () => {
    const expiredTime = new Date(Date.now() - 5000);
    const { mockDb, state } = createMockDb({
      replyControlMode: "HUMAN_SESSION",
      manualMode: true,
      humanHoldUntil: expiredTime,
      controlEpoch: 10,
    });

    const controlService = new ConversationControlService(mockDb);
    const normalized = await controlService.normalizeForInbound("conv-h-1", new Date());

    expect(normalized).toBeDefined();
    expect(normalized?.mode).toBe("AUTO");
    expect(normalized?.epoch).toBe(11);
    expect(state.conv.replyControlMode).toBe("AUTO");
    expect(state.conv.manualMode).toBe(false);
    expect(state.conv.status).toBe("WAITING_CUSTOMER");
    expect(state.conv.humanHoldUntil).toBeNull();
  });

  // H3: HUMAN_SESSION active -> customer sends -> human sends within wait -> AI fallback cancelled/stale
  it("H3: human replies within grace window, aborting deferred AI fallback", async () => {
    const now = new Date();
    const inboundTime = new Date(now.getTime() - 10000);
    const humanReplyTime = new Date(now.getTime() - 5000); // Human replied after customer

    const { mockDb, state } = createMockDb({
      replyControlMode: "HUMAN_SESSION",
      controlEpoch: 20,
      inboundVersion: 5,
      lastInboundAt: inboundTime,
      lastHumanOutboundAt: humanReplyTime,
    });

    const mockEventRepo = { recordEvent: vi.fn() } as unknown as EventRepository;
    const mockJobRepo = { enqueue: vi.fn() } as unknown as JobRepository;
    const mockOutboxRepo = {} as unknown as OutboxRepository;
    const mockBroadcaster = { broadcast: vi.fn() };

    const fallbackHandler = createHumanFallbackHandler({
      db: mockDb,
      jobRepo: mockJobRepo,
      eventRepo: mockEventRepo,
      outboxRepo: mockOutboxRepo,
      broadcaster: mockBroadcaster as any,
    });

    const mockContext = {
      job: {
        payload: {
          channelAccountId: "acc-1",
          conversationId: "conv-h-1",
          inboundVersion: 5,
          controlEpoch: 20,
        },
      },
    } as unknown as JobExecutionContext;

    await fallbackHandler(mockContext);

    // Should NOT resume to AUTO and NOT enqueue debounce because human replied!
    expect(state.conv.replyControlMode).toBe("HUMAN_SESSION");
    expect(mockEventRepo.recordEvent).not.toHaveBeenCalled();
    expect(mockBroadcaster.broadcast).not.toHaveBeenCalled();
  });

  // H4: HUMAN_SESSION active -> customer sends -> human silent -> fallback job resumes AUTO and AI handles latest inbound
  it("H4: human remains silent during wait, deferred fallback auto-resumes to AUTO and triggers debounce", async () => {
    const now = new Date();
    const inboundTime = new Date(now.getTime() - 60000);

    const { mockDb, state } = createMockDb({
      replyControlMode: "HUMAN_SESSION",
      controlEpoch: 25,
      inboundVersion: 6,
      lastInboundAt: inboundTime,
      lastHumanOutboundAt: null, // Human was silent!
    });

    const mockEventRepo = { recordEvent: vi.fn().mockResolvedValue({}) } as unknown as EventRepository;
    const mockJobRepo = { enqueue: vi.fn() } as unknown as JobRepository;
    const mockOutboxRepo = {} as unknown as OutboxRepository;
    const mockBroadcaster = { broadcast: vi.fn() };

    const fallbackHandler = createHumanFallbackHandler({
      db: mockDb,
      jobRepo: mockJobRepo,
      eventRepo: mockEventRepo,
      outboxRepo: mockOutboxRepo,
      broadcaster: mockBroadcaster as any,
    });

    const mockContext = {
      job: {
        payload: {
          channelAccountId: "acc-1",
          conversationId: "conv-h-1",
          inboundVersion: 6,
          controlEpoch: 25,
        },
      },
    } as unknown as JobExecutionContext;

    await fallbackHandler(mockContext);

    // Resumed to AUTO!
    expect(state.conv.replyControlMode).toBe("AUTO");
    expect(state.conv.manualMode).toBe(false);
    expect(state.conv.status).toBe("DEBOUNCING");
    expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AI_RESUMED_AFTER_HUMAN",
        inboundVersion: 6,
      })
    );
    // Debounce job was enqueued
    expect(state.jobs.some((j) => j.jobType === "debounce")).toBe(true);
    expect(mockBroadcaster.broadcast).toHaveBeenCalledWith("conversation:resumed", expect.any(Object));
  });

  // H5: HUMAN_PINNED customer sends -> persist inbound, AI never auto-resumes
  it("H5: HUMAN_PINNED mode never auto-releases to AUTO", async () => {
    const { mockDb, state } = createMockDb({
      replyControlMode: "HUMAN_PINNED",
      controlEpoch: 30,
      manualMode: true,
      humanHoldUntil: null,
    });

    const controlService = new ConversationControlService(mockDb);
    const normalized = await controlService.normalizeForInbound("conv-h-1", new Date());

    expect(normalized?.mode).toBe("HUMAN_PINNED");
    expect(state.conv.replyControlMode).toBe("HUMAN_PINNED");
    expect(state.conv.manualMode).toBe(true);
  });

  // H6: HUMAN_DRAFT expires without send -> AUTO
  it("H6: expired HUMAN_DRAFT lease automatically releases back to AUTO", async () => {
    const pastLease = new Date(Date.now() - 10000);
    const { mockDb, state } = createMockDb({
      replyControlMode: "HUMAN_DRAFT",
      manualMode: true,
      draftLeaseExpiresAt: pastLease,
      controlEpoch: 40,
    });

    const controlService = new ConversationControlService(mockDb);
    const normalized = await controlService.normalizeForInbound("conv-h-1", new Date());

    expect(normalized?.mode).toBe("AUTO");
    expect(normalized?.epoch).toBe(41);
    expect(state.conv.replyControlMode).toBe("AUTO");
    expect(state.conv.manualMode).toBe(false);
    expect(state.conv.status).toBe("WAITING_CUSTOMER");
  });

  // H7: external human sends repeatedly -> session refresh, holdUntil capped, no state corruption
  it("H7: repeated human sends refresh session and respect maxSessionMs cap", async () => {
    const now = new Date();
    const sessionStart = new Date(now.getTime() - 500000); // 500s ago
    const { mockDb, state } = createMockDb({
      replyControlMode: "HUMAN_SESSION",
      humanSessionStartedAt: sessionStart,
      controlEpoch: 50,
      inboundVersion: 2,
    });

    const controlService = new ConversationControlService(mockDb);

    // Refresh with hold 120s, maxSessionMs 600s (10m)
    const control = await controlService.acquireOrRefreshSession("conv-h-1", {
      outboundRef: "ref-subsequent",
      holdDurationMs: 120_000,
      maxSessionMs: 600_000,
    });

    expect(control.mode).toBe("HUMAN_SESSION");
    expect(control.epoch).toBe(51);
    // Capped by maxSessionMs (sessionStart + 600_000 = now + 100s, less than now + 120s)
    const maxPossibleHold = sessionStart.getTime() + 600_000;
    expect(control.holdUntil?.getTime()).toBeLessThanOrEqual(maxPossibleHold);
  });

  // H8: AI action created epoch 10 -> human takeover changes epoch 11 -> canAiReply fails
  it("H8: epoch bump invalidates AI reply permission from older epoch", async () => {
    const { mockDb } = createMockDb({
      replyControlMode: "AUTO",
      controlEpoch: 11, // moved to 11
      suppressedThroughInboundVersion: 0,
    });

    const controlService = new ConversationControlService(mockDb);

    // AI generated under epoch 10 tries to reply:
    const canReply = await controlService.canAiReply("conv-h-1", 10, 1);
    expect(canReply).toBe(false);

    // AI generated under epoch 11 can reply:
    const canReplyFresh = await controlService.canAiReply("conv-h-1", 11, 1);
    expect(canReplyFresh).toBe(true);
  });
});
