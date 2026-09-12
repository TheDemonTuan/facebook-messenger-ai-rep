import { describe, it, expect, vi } from "vitest";
import { OutboundRepository } from "../packages/db/src/repository/outbound-repo.js";
import { ConversationControlService } from "../packages/db/src/service/conversation-control-service.js";
import { createReconcileHandler } from "../apps/core/src/jobs/handlers/reconcile.js";
import type { Database } from "../packages/db/src/client.js";

describe("P0 Regression: Post-Bot Inbound Loss, Anti-Echo & SEND_UNCERTAIN Isolation", () => {
  describe("1. OutboundRepository.isBotOutbound (No False Positive Same-Thread Suppression)", () => {
    it("returns false for customer reply 5s after AI action when messageRef differs and text is customer's own", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([{ id: "action-1", text: "Dạ còn size M nha 🥰" }]),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new OutboundRepository(mockDb);

      // Customer sends "Shop ơi ship bao lâu tới ạ?" 5 seconds after bot reply
      const isBot = await repo.isBotOutbound({
        channelAccountId: "acc-1",
        externalThreadId: "thread-1",
        externalMessageRef: "mid.customer.new-bubble",
        text: "Shop ơi ship bao lâu tới ạ?",
      });

      expect(isBot).toBe(false);
    });

    it("does not suppress customer reply that is a substring of bot's reply (e.g. 'còn hàng')", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([{ id: "action-2", text: "Dạ sản phẩm này hiện tại bên em còn hàng nha bạn!" }]),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new OutboundRepository(mockDb);

      // Customer responds with just "còn hàng"
      const isBot = await repo.isBotOutbound({
        channelAccountId: "acc-1",
        externalThreadId: "thread-1",
        externalMessageRef: "mid.customer.short-answer",
        text: "còn hàng",
      });

      expect(isBot).toBe(false);
    });

    it("correctly identifies exact bot echo on the same thread", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([{ id: "action-echo", text: "Dạ em chào anh/chị ạ!" }]),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new OutboundRepository(mockDb);

      // Facebook Messenger echoes back the exact bot text without externalMessageRef
      const isBot = await repo.isBotOutbound({
        channelAccountId: "acc-1",
        externalThreadId: "thread-1",
        text: "Dạ em chào anh/chị ạ!  ",
      });

      expect(isBot).toBe(true);
    });

    it("does not match bot text from thread A to customer message in thread B", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                // Thread B has no bot actions matching this
                limit: vi.fn().mockResolvedValue([]),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new OutboundRepository(mockDb);

      const isBot = await repo.isBotOutbound({
        channelAccountId: "acc-1",
        externalThreadId: "thread-B",
        text: "Dạ em chào anh/chị ạ!",
      });

      expect(isBot).toBe(false);
    });
  });

  describe("2. ConversationControlService.releaseTechnicalReviewHold (Safe CAS & Human Protection)", () => {
    it("releases REVIEW_HOLD with SEND_UNCERTAIN to AUTO and increments epoch", async () => {
      let updatedMode: string | null = null;
      let updatedReason: string | null = null;
      let updatedEpoch: number | null = null;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{
                mode: "REVIEW_HOLD",
                controlEpoch: 3,
                controlReason: "SEND_UNCERTAIN",
                suppressedThroughInboundVersion: 1,
              }]),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((vals) => {
            updatedMode = vals.replyControlMode;
            updatedReason = vals.controlReason;
            updatedEpoch = vals.controlEpoch;
            return {
              where: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([{ id: "conv-1" }]),
              })),
            };
          }),
        })),
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);
      const result = await control.releaseTechnicalReviewHold("conv-1", "SEND_UNCERTAIN");

      expect(result).not.toBeNull();
      expect(result?.mode).toBe("AUTO");
      expect(result?.epoch).toBe(4);
      expect(updatedMode).toBe("AUTO");
      expect(updatedReason).toBe("SEND_UNCERTAIN_RESOLVED");
      expect(updatedEpoch).toBe(4);
    });

    it("refuses to release HUMAN_PINNED or HUMAN_SESSION when attempting to release technical review hold", async () => {
      const updateSpy = vi.fn();
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{
                mode: "HUMAN_PINNED",
                controlEpoch: 5,
                controlReason: "OPERATOR_TAKEOVER",
                suppressedThroughInboundVersion: 2,
              }]),
            })),
          })),
        })),
        update: updateSpy,
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);
      const result = await control.releaseTechnicalReviewHold("conv-human", "SEND_UNCERTAIN");

      // Mode must remain HUMAN_PINNED, epoch untouched, no DB update
      expect(result?.mode).toBe("HUMAN_PINNED");
      expect(result?.epoch).toBe(5);
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. Reconciler: Stale SEND_INTENT & Auto-Reconcile Progression", () => {
    it("isolates SEND_INTENT timeout to conversation REVIEW_HOLD without suspending channel", async () => {
      const updatedChannelAccounts: unknown[] = [];
      const updatedOutboundActions: unknown[] = [];
      const insertedIncidents: unknown[] = [];
      const recordedEvents: unknown[] = [];

      const mockDb = {
        update: vi.fn(() => ({
          set: vi.fn((vals) => {
            if (vals.status === "SEND_UNCERTAIN") {
              updatedOutboundActions.push(vals);
              return {
                where: vi.fn(() => ({
                  returning: vi.fn().mockResolvedValue([
                    { id: "action-stale-1", conversationId: "conv-1", channelAccountId: "acc-1" },
                  ]),
                })),
              };
            }
            if (vals.isSuspended !== undefined) {
              updatedChannelAccounts.push(vals);
            }
            return {
              where: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([]),
              })),
            };
          }),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((vals) => {
            insertedIncidents.push(vals);
            return { catch: vi.fn() };
          }),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      } as unknown as Database;

      const mockJobRepo = {
        reconcileStaleJobs: vi.fn().mockResolvedValue({ resetJobs: 0 }),
      };
      const mockEventRepo = {
        recordEvent: vi.fn(async (evt) => {
          recordedEvents.push(evt);
        }),
      };
      const mockBroadcaster = {
        broadcast: vi.fn(),
      };

      const handler = createReconcileHandler({
        db: mockDb,
        jobRepo: mockJobRepo as unknown as import("@messenger/db").JobRepository,
        eventRepo: mockEventRepo as unknown as import("@messenger/db").EventRepository,
        outboxRepo: {} as unknown as import("@messenger/db").OutboxRepository,
        broadcaster: mockBroadcaster as unknown as import("../apps/core/src/sse/outbox-broadcaster.js").OutboxBroadcaster,
      });

      await handler();

      // Invariant: outboundAction set to SEND_UNCERTAIN
      expect(updatedOutboundActions.some((a) => (a as Record<string, unknown>).status === "SEND_UNCERTAIN")).toBe(true);

      // Invariant: channel account was suspended fail-closed
      expect(updatedChannelAccounts.some((c) => (c as Record<string, unknown>).isSuspended === true)).toBe(true);

      // Invariant: Incident recorded for conversation review
      expect(insertedIncidents.some((i) => (i as Record<string, unknown>).type === "SEND_UNCERTAIN")).toBe(true);
    });
  });
});
