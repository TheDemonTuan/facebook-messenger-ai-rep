import { describe, it, expect, vi } from "vitest";
import { createDebounceHandler } from "../apps/core/src/jobs/handlers/debounce.js";
import type { Database, TurnRepository, JobRepository, OutboxRepository, EventRepository } from "@messenger/db";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";

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
    } as unknown as Database;

    const mockTurnRepo = {
      createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
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

    const inboundRow = {
      id: "inbound-1",
      channelAccountId: "personal-messenger",
      conversationId: "conv-123",
      inboundVersion: 3,
      text: "Xin chào",
      senderKind: "PERSON",
      senderReliability: "VERIFIED",
      rawPayload: {
        threadKind: "DIRECT",
        threadReliability: "VERIFIED",
        senderKind: "PERSON",
        senderReliability: "VERIFIED",
        participantIdentity: {
          channelAccountId: "personal-messenger",
          participantId: "user-1",
          senderKind: "PERSON",
          isVerified: true,
        },
      },
    };

    const participantRow = {
      channelAccountId: "personal-messenger",
      participantId: "user-1",
      senderKind: "PERSON",
      isVerified: true,
      reliability: "VERIFIED",
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn((tbl: unknown) => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              const tableObj = tbl as { _?: { name?: string }; [key: symbol]: unknown } | null | undefined;
              const tableName = tableObj?._?.name || (tableObj?.[Symbol.for("drizzle:Name")] as string | undefined);
              if (tableName === "channel_accounts") return [channelRow];
              if (tableName === "inbound_messages") return [inboundRow];
              if (tableName === "participants") return [participantRow];
              if (tableName === "settings" || tableName === "reply_policy_members") return [];
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
      createOrGetTurn: vi.fn().mockResolvedValue({ id: "turn-1" }),
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
