import { describe, it, expect, vi } from "vitest";
import { DebounceManager } from "../packages/queue/src/debounce.js";
import type { Redis } from "ioredis";
import type { AppQueues } from "../packages/queue/src/queues.js";

describe("Deduplication and Debounce Invariants", () => {
  it("detects expired debounce when version matches and pttl is zero or key expired", async () => {
    // Mock Redis
    const mockRedis = {
      get: vi.fn().mockResolvedValue("3"),
      pttl: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue("OK"),
    } as unknown as Redis;

    const mockQueues = {
      inboundDebounce: {
        getJob: vi.fn().mockResolvedValue(null),
        add: vi.fn().mockResolvedValue({}),
      },
    } as unknown as AppQueues;

    const debounceManager = new DebounceManager(mockRedis, mockQueues);

    // Scenario 1: Version matches and TTL expired -> should be expired (ready to dispatch)
    const isExpired = await debounceManager.isDebounceExpired({
      channelAccountId: "personal-messenger",
      conversationId: "conv-123",
      inboundVersion: 3,
    });
    expect(isExpired).toBe(true);

    // Scenario 2: A newer inbound version (4) arrived in the meantime -> this job (version 3) is stale
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue("4");
    const isStale = await debounceManager.isDebounceExpired({
      channelAccountId: "personal-messenger",
      conversationId: "conv-123",
      inboundVersion: 3,
    });
    expect(isStale).toBe(false);

    // Scenario 3: Key already disappeared from Redis (natural TTL expiry)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const naturallyExpired = await debounceManager.isDebounceExpired({
      channelAccountId: "personal-messenger",
      conversationId: "conv-123",
      inboundVersion: 4,
    });
    expect(naturallyExpired).toBe(true);
  });

  it("registers delayed job and resets TTL on consecutive inbounds", async () => {
    const mockRedis = {
      set: vi.fn().mockResolvedValue("OK"),
    } as unknown as Redis;

    const mockJob = { remove: vi.fn().mockResolvedValue(true) };
    const mockQueues = {
      inboundDebounce: {
        getJob: vi.fn().mockResolvedValue(mockJob),
        add: vi.fn().mockResolvedValue({}),
      },
    } as unknown as AppQueues;

    const debounceManager = new DebounceManager(mockRedis, mockQueues);

    await debounceManager.registerInbound("personal-messenger", "conv-1", 1, 3000);
    expect(mockRedis.set).toHaveBeenCalledWith("debounce:personal-messenger:conv-1", "1", "PX", 3000);
    expect(mockQueues.inboundDebounce.add).toHaveBeenCalled();

    // Second message arrives 1s later (version 2) -> resets timer
    await debounceManager.registerInbound("personal-messenger", "conv-1", 2, 3000);
    expect(mockRedis.set).toHaveBeenCalledWith("debounce:personal-messenger:conv-1", "2", "PX", 3000);
  });
});
