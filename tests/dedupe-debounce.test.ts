import { describe, it, expect, vi } from "vitest";
import { createDebounceHandler } from "../apps/core/src/jobs/handlers/debounce.js";

describe("Deduplication and Debounce Invariants", () => {
  it("detects stale debounce job when conversation inboundVersion has advanced", async () => {
    const conversationRow = {
      id: "conv-123",
      inboundVersion: 4, // conversation has moved to version 4
      status: "DEBOUNCING",
      manualMode: false,
      isBlocked: false,
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => [conversationRow]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any;

    const mockTurnRepo = {
      createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
    } as any;

    const mockJobRepo = {
      enqueue: vi.fn().mockResolvedValue({ id: "job-ai-1" }),
    } as any;

    const mockOutboxRepo = {
      enqueue: vi.fn().mockResolvedValue({ id: "outbox-1" }),
    } as any;

    const mockEventRepo = {
      recordEvent: vi.fn().mockResolvedValue({ id: "event-1" }),
    } as any;

    const mockBroadcaster = {
      broadcast: vi.fn().mockResolvedValue(undefined),
    } as any;

    const debounceHandler = createDebounceHandler({
      db: mockDb,
      turnRepo: mockTurnRepo,
      jobRepo: mockJobRepo,
      outboxRepo: mockOutboxRepo,
      eventRepo: mockEventRepo,
      broadcaster: mockBroadcaster,
    });

    // Job with stale version 3
    await debounceHandler({
      job: {
        id: "job-debounce-stale",
        channelAccountId: "personal-messenger",
        queue: "default",
        jobType: "inbound_debounce",
        payload: {
          channelAccountId: "personal-messenger",
          conversationId: "conv-123",
          inboundVersion: 3, // Stale!
        },
        status: "RUNNING",
        priority: 0,
        attempts: 1,
        maxAttempts: 3,
        availableAt: new Date(),
        lockedUntil: null,
        ownerToken: null,
        fencingEpoch: 0,
        idempotencyKey: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ownerToken: "test-owner",
      fencingEpoch: 1,
      signal: new AbortController().signal,
    });

    // Turn should NOT be created and AI job should NOT be enqueued
    expect(mockTurnRepo.createOrGetTurn).not.toHaveBeenCalled();
    expect(mockJobRepo.enqueue).not.toHaveBeenCalled();
    // Stale cancellation event must be recorded
    expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AI_CANCELLED_STALE",
        conversationId: "conv-123",
      })
    );
  });

  it("processes fresh debounce job, creates turn and enqueues AI job when versions match", async () => {
    const conversationRow = {
      id: "conv-123",
      inboundVersion: 3,
      status: "DEBOUNCING",
      manualMode: false,
      isBlocked: false,
    };

    const channelRow = {
      id: "personal-messenger",
      status: "RUNNING",
      isPaused: false,
      isSuspended: false,
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn((tbl) => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              const tableName = (tbl as any)?._?.name || (tbl as any)?.[Symbol.for("drizzle:Name")];
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
    } as any;

    const mockTurnRepo = {
      createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
    } as any;

    const mockJobRepo = {
      enqueue: vi.fn().mockResolvedValue({ id: "job-ai-1" }),
    } as any;

    const mockOutboxRepo = {
      enqueue: vi.fn().mockResolvedValue({ id: "outbox-1" }),
    } as any;

    const mockEventRepo = {
      recordEvent: vi.fn().mockResolvedValue({ id: "event-1" }),
    } as any;

    const mockBroadcaster = {
      broadcast: vi.fn().mockResolvedValue(undefined),
    } as any;

    const debounceHandler = createDebounceHandler({
      db: mockDb,
      turnRepo: mockTurnRepo,
      jobRepo: mockJobRepo,
      outboxRepo: mockOutboxRepo,
      eventRepo: mockEventRepo,
      broadcaster: mockBroadcaster,
    });

    // Job with matching version 3
    await debounceHandler({
      job: {
        id: "job-debounce-fresh",
        channelAccountId: "personal-messenger",
        queue: "default",
        jobType: "inbound_debounce",
        payload: {
          channelAccountId: "personal-messenger",
          conversationId: "conv-123",
          inboundVersion: 3,
        },
        status: "RUNNING",
        priority: 0,
        attempts: 1,
        maxAttempts: 3,
        availableAt: new Date(),
        lockedUntil: null,
        ownerToken: null,
        fencingEpoch: 0,
        idempotencyKey: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ownerToken: "test-owner",
      fencingEpoch: 1,
      signal: new AbortController().signal,
    });

    // Turn should be created and AI job should be enqueued
    expect(mockTurnRepo.createOrGetTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelAccountId: "personal-messenger",
        conversationId: "conv-123",
        inboundVersion: 3,
      })
    );
    expect(mockJobRepo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "ai",
      })
    );
  });
});
