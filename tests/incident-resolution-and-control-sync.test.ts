import { describe, it, expect, vi } from "vitest";
import { ReplyPolicyService } from "../packages/db/src/service/reply-policy-service.js";
import { ConversationControlService } from "../packages/db/src/service/conversation-control-service.js";
import type { Database } from "../packages/db/src/client.js";
import type { InboundMessagePayload } from "@messenger/contracts";

describe("Incident Resolution and Control Sync Regressions", () => {
  const channelAccountId = "acc-test";
  const conversationId = "conv-sin-test";

  const samplePayload: InboundMessagePayload = {
    channelAccountId,
    externalThreadId: "thread-sin-1",
    externalThreadRef: "ref-sin-1",
    externalMessageId: "msg-sin-1",
    source: "MESSENGER",
    senderId: "customer-sin",
    senderName: "Sin Sin",
    text: "Chào shop ạ",
    timestamp: new Date(),
    direction: "INBOUND",
    threadKind: "DIRECT",
    threadReliability: "VERIFIED",
  };

  it("evaluates INELIGIBLE (CONVERSATION_MANUAL_MODE) when replyControlMode is HUMAN_PINNED even if manualMode is false", async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: conversationId,
                channelAccountId,
                externalThreadId: "thread-sin-1",
                threadKind: "DIRECT",
                reliability: "VERIFIED",
                replyControlMode: "HUMAN_PINNED",
                manualMode: false, // Legacy desync state
                isBlocked: false,
                humanHoldUntil: null,
              },
            ]),
          })),
        })),
      })),
    } as unknown as Database;

    const replyPolicyService = new ReplyPolicyService(mockDb);
    const result = await replyPolicyService.evaluateInbound({
      channelAccountId,
      conversationId,
      inboundMessageId: "inbound-1",
      payload: samplePayload,
      evaluationMode: "LIVE",
    });

    expect(result.result.eligible).toBe(false);
    expect(result.result.decision).toBe("INELIGIBLE");
    expect(result.result.reasonCode).toBe("CONVERSATION_MANUAL_MODE");
  });

  it("normalizeForInbound preserves HUMAN_PINNED and self-heals manualMode to true", async () => {
    let updatedFields: Record<string, unknown> | null = null;
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: conversationId,
                replyControlMode: "HUMAN_PINNED",
                controlEpoch: 135,
                humanHoldUntil: null,
                humanSessionStartedAt: null,
                suppressedThroughInboundVersion: 92,
                draftLeaseExpiresAt: null,
                manualMode: false,
              },
            ]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((fields) => {
          updatedFields = fields;
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      })),
    } as unknown as Database;

    const controlService = new ConversationControlService(mockDb);
    const control = await controlService.normalizeForInbound(conversationId, new Date());

    expect(control).not.toBeNull();
    expect(control?.mode).toBe("HUMAN_PINNED");
    expect(control?.epoch).toBe(135);
    expect(updatedFields).not.toBeNull();
    expect(updatedFields?.manualMode).toBe(true);
  });

  it("recheckEligibility returns INELIGIBLE when conversation has replyControlMode !== AUTO", async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    } as unknown as Database;

    const replyPolicyService = new ReplyPolicyService(mockDb);
    const result = await replyPolicyService.recheckEligibility({
      channelAccountId,
      conversationId,
      inboundVersion: 1,
      conversation: {
        id: conversationId,
        inboundVersion: 1,
        manualMode: false, // desync
        replyControlMode: "HUMAN_PINNED",
      } as unknown as { id: string; inboundVersion: number; manualMode?: boolean | null },
    });

    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe("CONVERSATION_MANUAL_MODE");
  });
});
