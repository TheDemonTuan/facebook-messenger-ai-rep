import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OutboundRepository,
  JobRepository,
  TurnRepository,
  OutboxRepository,
  UserRepository,
  JobRunner,
} from "../packages/db/src/index.js";
import {
  UserRoleSchema,
  ChannelStatusSchema,
  JobStatusSchema,
  TurnStatusSchema,
  OutboundActionStatusSchema,
  OutboxStatusSchema,
} from "../packages/contracts/src/index.js";

describe("Foundation Architecture & State Machine Unit Tests", () => {
  describe("Contracts & Schemas", () => {
    it("validates roles OWNER, OPERATOR, VIEWER", () => {
      expect(UserRoleSchema.parse("OWNER")).toBe("OWNER");
      expect(UserRoleSchema.parse("OPERATOR")).toBe("OPERATOR");
      expect(UserRoleSchema.parse("VIEWER")).toBe("VIEWER");
      expect(() => UserRoleSchema.parse("SUPERADMIN")).toThrow();
    });

    it("validates channel statuses including DEGRADED", () => {
      expect(ChannelStatusSchema.parse("RUNNING")).toBe("RUNNING");
      expect(ChannelStatusSchema.parse("PAUSED")).toBe("PAUSED");
      expect(ChannelStatusSchema.parse("SUSPENDED")).toBe("SUSPENDED");
      expect(ChannelStatusSchema.parse("DEGRADED")).toBe("DEGRADED");
      expect(ChannelStatusSchema.parse("ERROR")).toBe("ERROR");
    });

    it("validates outbound statuses including SEND_UNCERTAIN and RETRY_APPROVED", () => {
      expect(OutboundActionStatusSchema.parse("PENDING")).toBe("PENDING");
      expect(OutboundActionStatusSchema.parse("TYPING")).toBe("TYPING");
      expect(OutboundActionStatusSchema.parse("SEND_INTENT")).toBe("SEND_INTENT");
      expect(OutboundActionStatusSchema.parse("SEND_UNCERTAIN")).toBe("SEND_UNCERTAIN");
      expect(OutboundActionStatusSchema.parse("CONFIRMED")).toBe("CONFIRMED");
      expect(OutboundActionStatusSchema.parse("RETRY_APPROVED")).toBe("RETRY_APPROVED");
      expect(OutboundActionStatusSchema.parse("CANCELLED")).toBe("CANCELLED");
    });

    it("validates job, turn, and outbox statuses", () => {
      expect(JobStatusSchema.parse("READY")).toBe("READY");
      expect(JobStatusSchema.parse("RUNNING")).toBe("RUNNING");
      expect(JobStatusSchema.parse("RETRY_WAIT")).toBe("RETRY_WAIT");
      expect(TurnStatusSchema.parse("THINKING")).toBe("THINKING");
      expect(TurnStatusSchema.parse("DRAFT_READY")).toBe("DRAFT_READY");
      expect(OutboxStatusSchema.parse("PENDING")).toBe("PENDING");
      expect(OutboxStatusSchema.parse("PROCESSED")).toBe("PROCESSED");
    });
  });

  describe("Outbound State Machine & Idempotency", () => {
    it("computes deterministic actionId", () => {
      const id1 = OutboundRepository.computeActionId("acc-1", "conv-1", 5, 0);
      const id2 = OutboundRepository.computeActionId("acc-1", "conv-1", 5, 0);
      const id3 = OutboundRepository.computeActionId("acc-1", "conv-1", 5, 1);
      expect(id1).toBe(id2);
      expect(id1).not.toBe(id3);
    });

    it("enforces explicit transitions and rejects invalid state jumps", async () => {
      const mockDb = {
        select: vi.fn(),
        update: vi.fn(),
      } as any;
      const repo = new OutboundRepository(mockDb);

      // PENDING cannot jump directly to CONFIRMED without TYPING and SEND_INTENT
      await expect(
        repo.transitionStatus("act-1", "PENDING", "CONFIRMED")
      ).rejects.toThrow("Invalid outbound action transition from PENDING to CONFIRMED");

      // CONFIRMED is terminal and cannot transition to TYPING
      await expect(
        repo.transitionStatus("act-1", "CONFIRMED", "TYPING")
      ).rejects.toThrow("Invalid outbound action transition from CONFIRMED to TYPING");
    });

    it("supports the SEND_UNCERTAIN and operator reconciliation workflow", async () => {
      let currentStatus = "SEND_INTENT";
      let actionRow = {
        id: "action-uuid-1",
        actionId: "act-123",
        status: currentStatus,
        channelAccountId: "acc-1",
        conversationId: "conv-1",
        inboundVersion: 1,
        responseIndex: 0,
        text: "Xin chào",
        textHash: "hash-1",
        actor: "AI",
      };

      const createUpdateMock = () =>
        vi.fn(() => ({
          set: vi.fn((updateData) => ({
            where: vi.fn(() => {
              actionRow = { ...actionRow, ...updateData };
              const res = [actionRow];
              (res as any).returning = vi.fn(() => [actionRow]);
              return res;
            }),
          })),
        }));

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [actionRow]),
            })),
          })),
        })),
        update: createUpdateMock(),
        transaction: vi.fn(async (cb) => {
          return await cb({
            select: vi.fn(() => ({
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => [actionRow]),
                })),
              })),
            })),
            update: createUpdateMock(),
            insert: vi.fn(() => ({
              values: vi.fn(() => ({
                onConflictDoNothing: vi.fn(),
              })),
            })),
          });
        }),
      } as any;

      const repo = new OutboundRepository(mockDb);

      // 1. Move to SEND_UNCERTAIN on timeout/DOM failure
      const uncertainResult = await repo.markSendUncertain("act-123", "DOM verification timeout");
      expect(uncertainResult).toBeDefined();
      expect(actionRow.status).toBe("SEND_UNCERTAIN");

      // 2. Operator reconciles with RETRY_APPROVED -> moves to PENDING
      await repo.reconcileUncertain("act-123", "RETRY_APPROVED");
      expect(actionRow.status).toBe("PENDING");

      // 3. Move from PENDING to TYPING, then SEND_INTENT, then CONFIRMED
      await repo.transitionStatus("act-123", "PENDING", "TYPING");
      expect(actionRow.status).toBe("TYPING");

      await repo.transitionStatus("act-123", "TYPING", "SEND_INTENT");
      expect(actionRow.status).toBe("SEND_INTENT");

      // 4. Operator reconciles / confirms sent
      await repo.confirmSent("act-123", "ref-msg-dom-1");
      expect(actionRow.status).toBe("CONFIRMED");
    });
  });

  describe("Job Runner Lifecycle & CAS Fencing", () => {
    it("handles execution lifecycle with heartbeats and completes with fencing check", async () => {
      const mockJobRepo = {
        claimNext: vi.fn(),
        heartbeat: vi.fn().mockResolvedValue(true),
        complete: vi.fn().mockResolvedValue(true),
        fail: vi.fn().mockResolvedValue({ status: "FAILED", retrying: false }),
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
      } as unknown as JobRepository;

      const runner = new JobRunner({
        jobRepo: mockJobRepo,
        queues: ["default"],
        pollIntervalMs: 20,
        heartbeatIntervalMs: 50,
        reconcileIntervalMs: 100,
      });

      let handlerExecuted = false;
      runner.registerHandler("process_turn", async ({ job, ownerToken, fencingEpoch }) => {
        expect(job.id).toBe("job-1");
        expect(ownerToken).toBeDefined();
        expect(fencingEpoch).toBe(1);
        handlerExecuted = true;
        return { success: true };
      });

      // Mock claim returning a job
      const testJob = {
        id: "job-1",
        channelAccountId: "acc-1",
        queue: "default",
        jobType: "process_turn",
        payload: { inboundVersion: 1 },
        status: "RUNNING" as const,
        priority: 0,
        attempts: 1,
        maxAttempts: 3,
        availableAt: new Date(),
        fencingEpoch: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockJobRepo.claimNext as any)
        .mockResolvedValueOnce(testJob)
        .mockResolvedValue(null);

      runner.start();

      // Wait briefly for poll & execution
      await new Promise((r) => setTimeout(r, 100));
      await runner.stop();

      expect(handlerExecuted).toBe(true);
      expect(mockJobRepo.complete).toHaveBeenCalledWith(
        "job-1",
        expect.any(String),
        1,
        { success: true }
      );
    });

    it("triggers job failure and records error when handler throws", async () => {
      const mockJobRepo = {
        claimNext: vi.fn(),
        heartbeat: vi.fn().mockResolvedValue(true),
        complete: vi.fn(),
        fail: vi.fn().mockResolvedValue({ status: "FAILED", retrying: false }),
        reconcileStaleJobs: vi.fn().mockResolvedValue({ recovered: 0, failed: 0 }),
      } as unknown as JobRepository;

      const runner = new JobRunner({
        jobRepo: mockJobRepo,
        pollIntervalMs: 20,
      });

      runner.registerHandler("failing_job", async () => {
        throw new Error("Network timeout upstream");
      });

      const testJob = {
        id: "job-err-1",
        channelAccountId: "acc-1",
        queue: "default",
        jobType: "failing_job",
        payload: {},
        status: "RUNNING" as const,
        priority: 0,
        attempts: 1,
        maxAttempts: 3,
        availableAt: new Date(),
        fencingEpoch: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockJobRepo.claimNext as any)
        .mockResolvedValueOnce(testJob)
        .mockResolvedValue(null);

      runner.start();
      await new Promise((r) => setTimeout(r, 80));
      await runner.stop();

      expect(mockJobRepo.fail).toHaveBeenCalledWith(
        "job-err-1",
        expect.any(String),
        2,
        "Network timeout upstream",
        expect.any(Number)
      );
    });
  });

  describe("Cloudflare Identity User Management", () => {
    it("resolves or creates user from Cloudflare identity without password or sessions", async () => {
      const mockUser = {
        id: "user-uuid-1",
        email: "cskh@company.com",
        name: "Support Staff",
        role: "OPERATOR",
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(() => [mockUser]),
            })),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [mockUser]),
            })),
          })),
        })),
      } as any;

      const userRepo = new UserRepository(mockDb);
      const user = await userRepo.findOrCreateFromCloudflare({
        email: "CSKH@Company.com",
        name: "Support Staff",
        role: "OPERATOR",
      });

      expect(user).toBeDefined();
      expect(user.email).toBe("cskh@company.com");
      expect(user.role).toBe("OPERATOR");
      // Password hash and TOTP fields must not exist
      expect((user as any).passwordHash).toBeUndefined();
      expect((user as any).totpSecret).toBeUndefined();
    });
  });
});
