import { describe, expect, it } from "vitest";
import { buildLeanConversationContext, estimateTextTokens } from "../packages/ai/src/context-builder.js";
import { SystemSettingsDefaults } from "../packages/contracts/src/settings.js";

describe("ContextBuilder & AI Context Budgeting", () => {
  it("estimates token count conservatively for Vietnamese text", () => {
    const text = "Xin chào shop, mình muốn tư vấn sản phẩm";
    const tokens = estimateTextTokens(text);
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(30);
  });

  it("filters out messages older than contextHistoryMaxAgeHours", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const oldTime = new Date("2026-09-04T12:00:00Z"); // 48 hours ago (> 24h)
    const freshTime = new Date("2026-09-06T10:00:00Z"); // 2 hours ago

    const rawMessages = [
      { direction: "INBOUND", text: "Tin nhắn cũ từ 2 ngày trước", timestamp: oldTime },
      { direction: "INBOUND", text: "Tin nhắn mới hôm nay", timestamp: freshTime },
    ];

    const result = buildLeanConversationContext(rawMessages, {
      settings: { ...SystemSettingsDefaults, contextHistoryMaxAgeHours: 24 },
      now,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe("Tin nhắn mới hôm nay");
    expect(result.manifest.droppedStaleCount).toBe(1);
  });

  it("enforces contextMaxMessages and contextMaxInboundMessages limits while preserving latest inbound", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const rawMessages = Array.from({ length: 20 }).map((_, i) => ({
      direction: i % 2 === 0 ? "INBOUND" : "OUTBOUND",
      text: `Tin nhắn thứ ${i + 1}`,
      timestamp: new Date(now.getTime() - (20 - i) * 60000),
    }));

    const result = buildLeanConversationContext(rawMessages, {
      settings: {
        ...SystemSettingsDefaults,
        contextMaxMessages: 6,
        contextMaxInboundMessages: 3,
      },
      now,
    });

    expect(result.messages.length).toBeLessThanOrEqual(6);
    const inboundMessages = result.messages.filter((m) => m.direction === "INBOUND");
    expect(inboundMessages.length).toBeLessThanOrEqual(3);
    // The very last message was inbound (index 18) or outbound (index 19): latest message preserved
    expect(result.messages[result.messages.length - 1].text).toBe("Tin nhắn thứ 20");
  });

  it("enforces contextMaxMessagesPerSender", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const rawMessages = Array.from({ length: 10 }).map((_, i) => ({
      direction: "INBOUND",
      text: `Khách gửi câu ${i + 1}`,
      senderParticipantId: "customer-123",
      timestamp: new Date(now.getTime() - (10 - i) * 60000),
    }));

    const result = buildLeanConversationContext(rawMessages, {
      settings: {
        ...SystemSettingsDefaults,
        contextMaxMessagesPerSender: 4,
        contextMaxMessages: 12,
        contextMaxInboundMessages: 12,
      },
      now,
    });

    expect(result.messages).toHaveLength(4);
    expect(result.messages[result.messages.length - 1].text).toBe("Khách gửi câu 10");
    expect(result.manifest.droppedSenderQuotaCount).toBe(6);
  });
});
