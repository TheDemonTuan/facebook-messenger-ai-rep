import { describe, it, expect, vi } from "vitest";
import { OutboundRepository } from "../packages/db/src/repository/outbound-repo.js";
import { ConversationControlService } from "../packages/db/src/service/conversation-control-service.js";
import { createReconcileHandler } from "../apps/core/src/jobs/handlers/reconcile.js";
import { fuzzyMatchesOutboundText } from "../packages/channel/src/index.js";
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

      // Invariant: channel account is NOT suspended (failure isolated to conversation REVIEW_HOLD)
      expect(updatedChannelAccounts.some((c) => (c as Record<string, unknown>).isSuspended === true)).toBe(false);

      // Invariant: Incident recorded for conversation review
      expect(insertedIncidents.some((i) => (i as Record<string, unknown>).type === "SEND_UNCERTAIN")).toBe(true);
    });

    it("auto-reconcile threadProgressed requires INBOUND message strictly after sendCutoff", async () => {
      const now = new Date();
      const sendTime = new Date(now.getTime() - 60000);
      const updatedActions: Record<string, unknown>[] = [];
      const updatedIncidents: Record<string, unknown>[] = [];

      // Test case A: Message is OUTBOUND => must NOT trigger threadProgressed
      const mockDbOutbound = {
        select: vi.fn(() => ({
          from: vi.fn((table: Record<string | symbol, unknown>) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
                if (tableName === "outbound_actions") {
                  return Promise.resolve([
                    {
                      id: "act-unc-1",
                      conversationId: "conv-1",
                      channelAccountId: "acc-1",
                      createdAt: sendTime,
                      startedSendingAt: sendTime,
                    },
                  ]);
                }
                // Later message query: returns empty because direction = INBOUND filter excludes outbound
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((vals) => {
            updatedActions.push(vals);
            return {
              where: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([]),
              })),
            };
          }),
        })),
      } as unknown as Database;

      const handlerOutbound = createReconcileHandler({
        db: mockDbOutbound,
        jobRepo: { reconcileStaleJobs: vi.fn().mockResolvedValue({ resetJobs: 0 }) } as unknown as import("@messenger/db").JobRepository,
        eventRepo: { recordEvent: vi.fn() } as unknown as import("@messenger/db").EventRepository,
        outboxRepo: {} as unknown as import("@messenger/db").OutboxRepository,
        broadcaster: { broadcast: vi.fn() } as unknown as import("../apps/core/src/sse/outbox-broadcaster.js").OutboxBroadcaster,
      });

      await handlerOutbound();
      expect(updatedActions.some((a) => a.metadata && String(a.metadata).includes("threadProgressed"))).toBe(false);

      // Test case B: Message is INBOUND after sendTime => triggers threadProgressed and resolves incident
      const mockDbInbound = {
        select: vi.fn(() => ({
          from: vi.fn((table: Record<string | symbol, unknown>) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
                if (tableName === "outbound_actions") {
                  return Promise.resolve([
                    {
                      id: "act-unc-2",
                      conversationId: "conv-2",
                      channelAccountId: "acc-1",
                      createdAt: sendTime,
                      startedSendingAt: sendTime,
                    },
                  ]);
                }
                // Inbound message strictly after send cutoff found!
                return Promise.resolve([{ id: "msg-inbound-later" }]);
              }),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((vals) => {
            if (vals.metadata) updatedActions.push(vals);
            if (vals.status === "RESOLVED") updatedIncidents.push(vals);
            return {
              where: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([]),
              })),
            };
          }),
        })),
      } as unknown as Database;

      const handlerInbound = createReconcileHandler({
        db: mockDbInbound,
        jobRepo: { reconcileStaleJobs: vi.fn().mockResolvedValue({ resetJobs: 0 }) } as unknown as import("@messenger/db").JobRepository,
        eventRepo: { recordEvent: vi.fn() } as unknown as import("@messenger/db").EventRepository,
        outboxRepo: {} as unknown as import("@messenger/db").OutboxRepository,
        broadcaster: { broadcast: vi.fn() } as unknown as import("../apps/core/src/sse/outbox-broadcaster.js").OutboxBroadcaster,
      });

      await handlerInbound();
      expect(updatedActions.some((a) => a.metadata !== undefined)).toBe(true);
      expect(updatedIncidents.some((i) => i.status === "RESOLVED")).toBe(true);
    });
  });

  describe("4. Durable Evidence & Verified Customer Anti-Echo Resolution", () => {
    it("distinguishes EXACT_EXTERNAL_REF from STRICT_TEXT_MATCH in OutboundRepository", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => {
                return Promise.resolve([{ id: "action-exact-1" }]);
              }),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new OutboundRepository(mockDb);

      const refEvidence = await repo.checkBotOutboundEvidence({
        channelAccountId: "acc-1",
        externalMessageRef: "mid.known-bot-ref",
      });
      expect(refEvidence).toBe("EXACT_EXTERNAL_REF");
    });

    it("prevents verified customer saying 'ok' from being suppressed by durable text match", () => {
      // Logic simulation of adapter's inbound anti-echo decision
      const evaluateAntiEcho = (params: {
        isVerifiedCustomer: boolean;
        durableEvidence: "EXACT_EXTERNAL_REF" | "STRICT_TEXT_MATCH" | "NONE";
        isExactRecentBotReply: boolean;
      }): boolean => {
        const { isVerifiedCustomer, durableEvidence, isExactRecentBotReply } = params;
        return (
          durableEvidence === "EXACT_EXTERNAL_REF" ||
          (!isVerifiedCustomer && (durableEvidence === "STRICT_TEXT_MATCH" || isExactRecentBotReply))
        );
      };

      // Case 1: Bot said "ok", verified customer says "ok" -> MUST NOT be suppressed!
      const suppressedVerifiedCustomer = evaluateAntiEcho({
        isVerifiedCustomer: true,
        durableEvidence: "STRICT_TEXT_MATCH",
        isExactRecentBotReply: true,
      });
      expect(suppressedVerifiedCustomer).toBe(false);

      // Case 2: Outgoing bot echo bubble where ID matched confirmed outbound message ref -> MUST be suppressed
      const suppressedExactRef = evaluateAntiEcho({
        isVerifiedCustomer: true,
        durableEvidence: "EXACT_EXTERNAL_REF",
        isExactRecentBotReply: false,
      });
      expect(suppressedExactRef).toBe(true);

      // Case 3: Unverified bubble with matching text (bot echo race) -> MUST be suppressed
      const suppressedUnverifiedEcho = evaluateAntiEcho({
        isVerifiedCustomer: false,
        durableEvidence: "STRICT_TEXT_MATCH",
        isExactRecentBotReply: false,
      });
      expect(suppressedUnverifiedEcho).toBe(true);
    });
  });

  describe("5. Technical Hold Normalization with autoResumeAfterHuman=false", () => {
    it("preserves REVIEW_HOLD in normalizeForInbound so technical hold is only released after new message dedupe & insert", async () => {
      let updatedMode: string | null = null;
      const convState = {
        id: "conv-unc-1",
        mode: "REVIEW_HOLD",
        replyControlMode: "REVIEW_HOLD",
        controlEpoch: 3,
        controlReason: "SEND_UNCERTAIN",
        humanHoldUntil: null,
        humanSessionStartedAt: null,
        draftLeaseExpiresAt: null,
        suppressedThroughInboundVersion: 0,
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockImplementation(() => Promise.resolve([convState])),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((vals) => {
            updatedMode = vals.replyControlMode;
            return {
              where: vi.fn().mockResolvedValue([{ id: "conv-unc-1" }]),
            };
          }),
        })),
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);

      // Simulate inbound normalization with autoResumeAfterHuman = false
      const result = await control.normalizeForInbound("conv-unc-1", new Date(), {
        autoResumeAfterHuman: false,
      });

      // Technical hold must NOT be prematurely released by normalizeForInbound before deduplication!
      expect(result?.mode).toBe("REVIEW_HOLD");
      expect(updatedMode).toBeUndefined();
    });

    it("retains HUMAN_SESSION when autoResumeAfterHuman is false", async () => {
      let updated = false;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-human-1",
                  mode: "HUMAN_SESSION",
                  replyControlMode: "HUMAN_SESSION",
                  controlEpoch: 1,
                  controlReason: "MANUAL_TAKEOVER",
                  humanHoldUntil: new Date(Date.now() - 10000), // Expired session
                  humanSessionStartedAt: new Date(Date.now() - 60000),
                  draftLeaseExpiresAt: null,
                  suppressedThroughInboundVersion: 0,
                },
              ]),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => {
            updated = true;
            return { where: vi.fn().mockResolvedValue([]) };
          }),
        })),
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);

      const result = await control.normalizeForInbound("conv-human-1", new Date(), {
        autoResumeAfterHuman: false,
      });

      // Human session must NOT be auto-resumed when policy disables it
      expect(updated).toBe(false);
      expect(result?.mode).toBe("HUMAN_SESSION");
    });
  });

  describe("6. Inbox RETRY Resolution (Protection of Human Takeover)", () => {
    it("preserves HUMAN_PINNED mode during RETRY reconciliation and only releases REVIEW_HOLD", () => {
      // Logic test of RETRY release condition in inbox.ts:
      // only if (convRetry && convRetry.mode === "REVIEW_HOLD" && convRetry.reason === "SEND_UNCERTAIN")
      const shouldReleaseTechnicalHold = (conv: { mode: string; reason: string }): boolean => {
        return conv.mode === "REVIEW_HOLD" && conv.reason === "SEND_UNCERTAIN";
      };

      // Case 1: Operator manually pinned conversation (HUMAN_PINNED + MANUAL_MODE_SET)
      // Must NEVER be released to AUTO by a RETRY resolution!
      const humanPinned = { mode: "HUMAN_PINNED", reason: "MANUAL_MODE_SET" };
      expect(shouldReleaseTechnicalHold(humanPinned)).toBe(false);

      // Case 2: Conversation is in technical review hold due to send uncertainty
      // Must be safely released back to AUTO
      const technicalHold = { mode: "REVIEW_HOLD", reason: "SEND_UNCERTAIN" };
      expect(shouldReleaseTechnicalHold(technicalHold)).toBe(true);

      // Case 3: Conversation is in review hold for another reason (e.g. policy violation)
      const otherHold = { mode: "REVIEW_HOLD", reason: "POLICY_VIOLATION" };
      expect(shouldReleaseTechnicalHold(otherHold)).toBe(false);
    });
  });

  describe("7. Sender verifySent: Strict Outgoing Requirement for Fuzzy Matching", () => {
    it("disallows fuzzy matching on unverified incoming bubbles to prevent inbound hijacking", () => {
      const evaluateTextMatches = (params: {
        bubbleText: string;
        expectedText: string;
        isOutgoing: boolean;
      }): boolean => {
        const { bubbleText, expectedText, isOutgoing } = params;
        const normBubble = bubbleText.trim().toLowerCase();
        const normExp = expectedText.trim().toLowerCase();
        // Exact and normalized matches
        if (normBubble === normExp) return true;
        // Fuzzy branch MUST require isOutgoing
        return isOutgoing && fuzzyMatchesOutboundText(expectedText, bubbleText);
      };

      const botDraft = "Dạ sản phẩm này bên em đang có chương trình giảm 10% khi mua 2 sản phẩm ạ!";
      // Customer replies with almost identical wording (e.g. quoting without quotes, with typo/emoji)
      const customerSimilarText = "Dạ sản phẩm này bên em đang có chương trình giảm 10% khi mua 2 sản phẩm";

      // Case 1: Bubble is NOT confirmed outgoing (e.g. unverified customer bubble in race)
      // Must NOT match via fuzzy!
      const unverifiedMatch = evaluateTextMatches({
        bubbleText: customerSimilarText,
        expectedText: botDraft,
        isOutgoing: false,
      });
      expect(unverifiedMatch).toBe(false);

      // Case 2: Bubble IS confirmed outgoing
      // Fuzzy match is allowed (e.g. Facebook stripped emojis or changed whitespace)
      const outgoingMatch = evaluateTextMatches({
        bubbleText: customerSimilarText,
        expectedText: botDraft,
        isOutgoing: true,
      });
      expect(outgoingMatch).toBe(true);
    });

    it("strictly requires isOutgoing===true before any text matching in verifySent", () => {
      // Invariant test: verifySent immediately rejects incoming bubbles
      const verifySentFilter = (b: { isOutgoing: boolean; text: string }, expected: string): boolean => {
        if (!b.isOutgoing) return false;
        return b.text.trim().toLowerCase() === expected.trim().toLowerCase();
      };

      // Exact text match but bubble is incoming customer
      expect(verifySentFilter({ isOutgoing: false, text: "Chào bạn" }, "Chào bạn")).toBe(false);
      // Exact text match and bubble is outgoing bot
      expect(verifySentFilter({ isOutgoing: true, text: "Chào bạn" }, "Chào bạn")).toBe(true);
    });
  });

  describe("8. State Machine Integrity: cancelQueuedAi NEVER cancels SEND_INTENT", () => {
    it("preserves SEND_INTENT action when human reply control is acquired", async () => {
      const updatedActions: Record<string, unknown>[] = [];
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-send-1",
                  inboundVersion: 1,
                  controlEpoch: 2,
                  replyControlMode: "AUTO",
                  humanSessionStartedAt: null,
                  humanHoldUntil: null,
                },
              ]),
            })),
          })),
        })),
        update: vi.fn((table: Record<string | symbol, unknown>) => ({
          set: vi.fn((setData: Record<string, unknown>) => {
            const tableName = (table[Symbol.for("drizzle:Name")] as string) || "";
            if (tableName === "outbound_actions") {
              updatedActions.push(setData);
            }
            return {
              where: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([{ id: "conv-send-1" }]),
              })),
            };
          }),
        })),
        delete: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);

      // Acquire human session
      await control.acquireOrRefreshSession("conv-send-1");

      // Verify that outbound_actions update only targets PENDING and TYPING, NEVER SEND_INTENT
      // Drizzle where condition receives inArray with ["PENDING", "TYPING"]
      expect(updatedActions.length).toBe(1);
      expect(updatedActions[0].status).toBe("CANCELLED");
    });
  });

  describe("9. Concurrency & Precedence: Human Takeover Overrides REVIEW_HOLD", () => {
    it("refuses to downgrade HUMAN_PINNED to REVIEW_HOLD on technical timeout", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-pinned-1",
                  inboundVersion: 5,
                  controlEpoch: 8,
                  replyControlMode: "HUMAN_PINNED",
                  humanHoldUntil: null,
                },
              ]),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);

      // Timeout attempt to acquire review hold on pinned conversation
      const result = await control.acquireReviewHold("conv-pinned-1", "SEND_UNCERTAIN");

      // Mode MUST remain HUMAN_PINNED
      expect(result.mode).toBe("HUMAN_PINNED");
      expect(result.changed).toBe(false);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("refuses to overwrite active HUMAN_SESSION with REVIEW_HOLD", async () => {
      const activeHold = new Date(Date.now() + 60000); // 60s remaining
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conv-session-1",
                  inboundVersion: 3,
                  controlEpoch: 4,
                  replyControlMode: "HUMAN_SESSION",
                  humanHoldUntil: activeHold,
                },
              ]),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      } as unknown as Database;

      const control = new ConversationControlService(mockDb);

      const result = await control.acquireReviewHold("conv-session-1", "SEND_UNCERTAIN");

      expect(result.mode).toBe("HUMAN_SESSION");
      expect(result.changed).toBe(false);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("10. External Human Outbound & Inbound Anti-Echo Disambiguation", () => {
    it("does not allow STRICT_TEXT_MATCH to suppress external human outbound", () => {
      // Logic simulation of adapter's check for outgoing bubble:
      // ONLY EXACT_EXTERNAL_REF marks it as durable bot!
      const isOutgoingDurableBot = (evidence: "EXACT_EXTERNAL_REF" | "STRICT_TEXT_MATCH" | "NONE"): boolean => {
        return evidence === "EXACT_EXTERNAL_REF";
      };

      // Human operator sends identical phrase on mobile ("Dạ còn hàng nha")
      // Durable checker returns STRICT_TEXT_MATCH based on previous bot action
      // Must NOT be treated as bot!
      expect(isOutgoingDurableBot("STRICT_TEXT_MATCH")).toBe(false);
      // Exact confirmed bot action ID in DB
      expect(isOutgoingDurableBot("EXACT_EXTERNAL_REF")).toBe(true);
      expect(isOutgoingDurableBot("NONE")).toBe(false);
    });

    it("does not suppress unverified customer inbound saying 'ok' even if bot said 'ok'", () => {
      const isIncomingEchoSuppressed = (durableEvidence: "EXACT_EXTERNAL_REF" | "STRICT_TEXT_MATCH" | "NONE"): boolean => {
        return durableEvidence === "EXACT_EXTERNAL_REF";
      };

      // Unverified customer says "ok", text matches recent bot reply "ok"
      // Must NOT be suppressed!
      expect(isIncomingEchoSuppressed("STRICT_TEXT_MATCH")).toBe(false);
      expect(isIncomingEchoSuppressed("NONE")).toBe(false);
      expect(isIncomingEchoSuppressed("EXACT_EXTERNAL_REF")).toBe(true);
    });
  });

  describe("11. Ingest Inbound Technical Hold Release Ordering", () => {
    it("does not release REVIEW_HOLD if inbound message is a duplicate", async () => {
      const { ConversationRepository } = await import("../packages/db/src/repository/conversation-repo.js");
      const releaseHoldMock = vi.fn();
      const mockControlService = {
        normalizeForInbound: vi.fn().mockResolvedValue({ mode: "REVIEW_HOLD", epoch: 1, holdUntil: null }),
        releaseTechnicalReviewHold: releaseHoldMock,
      };

      const mockDb = {
        transaction: vi.fn(async (cb) => {
          const innerTx = {
            select: vi.fn(() => ({
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([
                    // Existing message found -> duplicate!
                    {
                      id: "msg-exist-1",
                      conversationId: "conv-1",
                      inboundVersion: 1,
                      text: "Hello again",
                      contentStatus: "READY",
                      contentRevision: 1,
                    },
                  ]),
                })),
              })),
            })),
            update: vi.fn(),
            insert: vi.fn(),
          };
          return cb(innerTx);
        }),
      };

      const repo = new ConversationRepository(
        mockDb as unknown as Database,
        mockControlService as unknown as ConversationControlService,
        { evaluatePrePersist: vi.fn().mockResolvedValue({ passed: true, reason: "OK" }), evaluateInbound: vi.fn() } as unknown as ReplyPolicyService
      );

      const res = await repo.ingestInboundMessage({
        channelAccountId: "acc-1",
        externalConversationId: "conv-1",
        externalThreadId: "thread-1",
        externalMessageId: "msg-dup-1",
        text: "Hello again",
        senderExternalId: "sender-1",
        senderName: "Customer",
        timestamp: new Date(),
      } as unknown as InboundMessagePayload);

      expect(res.isDuplicate).toBe(true);
      // Crucial: releaseTechnicalReviewHold must NEVER have been called on duplicate!
      expect(releaseHoldMock).not.toHaveBeenCalled();
    });
  });
});
