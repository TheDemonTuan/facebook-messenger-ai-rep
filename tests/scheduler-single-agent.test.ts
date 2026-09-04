import { describe, it, expect, vi } from "vitest";
import { LeaseManager } from "../packages/queue/src/lease.js";
import type { Redis } from "ioredis";

describe("Single Agent Leases and Fencing Tokens", () => {
  it("acquires lease with monotonic fencing token and blocks concurrent holder", async () => {
    let currentLease: string | null = null;
    let fencingCounter = 0;

    // Simulate Redis Lua script execution
    const mockRedis = {
      eval: vi.fn().mockImplementation(async (_script, _numKeys, key, fencingKey, token, ttlMs) => {
        if (currentLease !== null) {
          return null; // Already held
        }
        fencingCounter++;
        currentLease = token;
        return [token, fencingCounter];
      }),
      get: vi.fn().mockImplementation(async () => {
        if (!currentLease) return null;
        return JSON.stringify({ token: currentLease, fencingToken: fencingCounter });
      }),
    } as unknown as Redis;

    const leaseManager = new LeaseManager(mockRedis);

    // First worker acquires lease
    const lease1 = await leaseManager.acquire("sender:personal-messenger", 30000);
    expect(lease1).not.toBeNull();
    expect(lease1?.token).toBeDefined();
    expect(lease1?.fencingToken).toBe(1);

    // Second worker attempts to acquire the same lease concurrently -> must fail (null)
    const lease2 = await leaseManager.acquire("sender:personal-messenger", 30000);
    expect(lease2).toBeNull();

    // Verify fencing token validation
    const isValidToken1 = await leaseManager.verifyFencing("sender:personal-messenger", 1);
    expect(isValidToken1).toBe(true);

    const isStaleToken = await leaseManager.verifyFencing("sender:personal-messenger", 0);
    expect(isStaleToken).toBe(false);
  });
});
