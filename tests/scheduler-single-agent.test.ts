import { describe, it, expect, vi } from "vitest";
import { JobRepository, type Database } from "../packages/db/src/index.js";

describe("Single Agent Leases and Fencing Tokens", () => {
  it("acquires lease with monotonic fencing token and blocks concurrent holder", async () => {
    let currentHolder: string | null = null;
    let currentFencingEpoch = 0;

    const mockDb = {
      execute: vi.fn().mockImplementation(async () => {
        // First call: worker-1 claims lease
        if (currentHolder === null) {
          currentFencingEpoch += 1;
          currentHolder = "worker-1";
          return {
            rows: [
              {
                id: "job-single-agent-1",
                channelAccountId: "personal-messenger",
                queue: "default",
                jobType: "ai",
                payload: {},
                status: "RUNNING",
                priority: 0,
                attempts: 1,
                maxAttempts: 3,
                availableAt: new Date(),
                lockedUntil: new Date(Date.now() + 60000),
                ownerToken: "worker-1",
                fencingEpoch: currentFencingEpoch,
                idempotencyKey: null,
                lastError: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
          };
        }

        // Subsequent call when already held: concurrent worker-2 gets empty result
        return { rows: [] };
      }),
    } as unknown as Database;

    const jobRepo = new JobRepository(mockDb);

    // 1. Worker 1 claims lease -> receives monotonic fencing token 1
    const claimedJob1 = await jobRepo.claimNext({
      ownerToken: "worker-1",
      leaseDurationSeconds: 60,
    });
    expect(claimedJob1).not.toBeNull();
    expect(claimedJob1?.ownerToken).toBe("worker-1");
    expect(claimedJob1?.fencingEpoch).toBe(1);

    // 2. Worker 2 attempts concurrent claim -> returns null (blocked)
    const claimedJob2 = await jobRepo.claimNext({
      ownerToken: "worker-2",
      leaseDurationSeconds: 60,
    });
    expect(claimedJob2).toBeNull();

    // 3. Heartbeat with matching ownerToken and valid fencingEpoch succeeds
    mockDb.execute.mockResolvedValueOnce({ rows: [{ id: "job-single-agent-1" }] });
    const heartbeatSuccess = await jobRepo.heartbeat("job-single-agent-1", "worker-1", 1, 60);
    expect(heartbeatSuccess).toBe(true);

    // 4. Heartbeat with stale fencingEpoch or mismatched ownerToken is rejected
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const heartbeatStale = await jobRepo.heartbeat("job-single-agent-1", "worker-1", 0, 60);
    expect(heartbeatStale).toBe(false);
  });
});
