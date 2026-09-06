import { describe, expect, it } from "vitest";
import { buildLeanConversationContext, estimateTextTokens } from "../packages/ai/src/context-builder.js";
import { buildChatMessages } from "../packages/ai/src/persona.js";
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

  it("correctly handles descending input from DB and keeps the latest message as the final item", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    // Like PostgreSQL orderBy(desc(timestamp)): newest at index 0, oldest at the end
    const descendingDbRows = [
      { direction: "INBOUND", text: "tôi muốn biết các sản phẩm shop bán ayas", timestamp: new Date(now.getTime() - 1000) },
      { direction: "OUTBOUND", text: "Dạ chào bạn!", timestamp: new Date(now.getTime() - 30000) },
      { direction: "INBOUND", text: "shop bán gì vậy ?", timestamp: new Date(now.getTime() - 60000) },
      { direction: "OUTBOUND", text: "Chào bạn nha!", timestamp: new Date(now.getTime() - 90000) },
      { direction: "INBOUND", text: "đâu rồi ?", timestamp: new Date(now.getTime() - 3600000) },
    ];

    const result = buildLeanConversationContext(descendingDbRows, {
      settings: SystemSettingsDefaults,
      now,
    });

    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    // The very last message in result.messages MUST be the newest customer question!
    const lastMessage = result.messages[result.messages.length - 1]!;
    expect(lastMessage.text).toBe("tôi muốn biết các sản phẩm shop bán ayas");
    expect(lastMessage.direction).toBe("INBOUND");
  });

  it("does not drop all messages when aiSystemPersona is very large (e.g. 15,000 chars)", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const hugePersona = "A".repeat(15000); // 15,000 chars = ~6000 tokens

    const descendingDbRows = [
      { direction: "INBOUND", text: "tôi muốn biết các sản phẩm shop bán ayas", timestamp: new Date(now.getTime() - 1000) },
      { direction: "OUTBOUND", text: "Dạ shop chào bạn!", timestamp: new Date(now.getTime() - 30000) },
      { direction: "INBOUND", text: "shop bán gì vậy ?", timestamp: new Date(now.getTime() - 60000) },
      { direction: "OUTBOUND", text: "Chào bạn nha!", timestamp: new Date(now.getTime() - 90000) },
      { direction: "INBOUND", text: "alo", timestamp: new Date(now.getTime() - 120000) },
    ];

    const result = buildLeanConversationContext(descendingDbRows, {
      settings: {
        ...SystemSettingsDefaults,
        aiSystemPersona: hugePersona,
      },
      now,
    });

    // Should NOT be trimmed down to 1 message!
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.messages[result.messages.length - 1]!.text).toBe("tôi muốn biết các sản phẩm shop bán ayas");
  });

  it("ensures buildChatMessages produces the latest user message as the final item sent to the proxy", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const descendingDbRows = [
      { direction: "INBOUND", text: "tôi muốn biết các sản phẩm shop bán ayas", timestamp: new Date(now.getTime() - 1000) },
      { direction: "OUTBOUND", text: "Dạ shop chào bạn!", timestamp: new Date(now.getTime() - 30000) },
      { direction: "INBOUND", text: "shop bán gì vậy ?", timestamp: new Date(now.getTime() - 60000) },
    ];

    const contextResult = buildLeanConversationContext(descendingDbRows, {
      settings: SystemSettingsDefaults,
      now,
    });

    const chatMessages = buildChatMessages({
      recentMessages: contextResult.messages,
      settings: SystemSettingsDefaults,
      customerName: "Sin Sin",
    });

    // 1st is system
    expect(chatMessages[0]!.role).toBe("system");

    // Last message MUST be role: user with the newest question
    const lastChatMsg = chatMessages[chatMessages.length - 1]!;
    expect(lastChatMsg.role).toBe("user");
    expect(lastChatMsg.content).toBe("tôi muốn biết các sản phẩm shop bán ayas");

    // The previous question should come before it
    const userMessages = chatMessages.filter((m) => m.role === "user");
    expect(userMessages[0]!.content).toBe("shop bán gì vậy ?");
    expect(userMessages[1]!.content).toBe("tôi muốn biết các sản phẩm shop bán ayas");
  });
});
