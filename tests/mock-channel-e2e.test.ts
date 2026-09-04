import { describe, it, expect } from "vitest";
import { MockChannelAdapter } from "../packages/channel/src/mock-adapter.js";
import type { InboundMessagePayload } from "@messenger/contracts";

describe("Mock Channel Adapter & E2E Simulated Messenger Loop", () => {
  it("simulates full inbound to outbound typing and send flow", async () => {
    const adapter = new MockChannelAdapter("personal-messenger");

    let receivedInbound: InboundMessagePayload | null = null;
    await adapter.observeInbound(async (inbound) => {
      receivedInbound = inbound;
    });

    // 1. Customer sends message
    await adapter.simulateInbound({
      externalThreadId: "thread-1001",
      externalThreadRef: "https://www.facebook.com/messages/t/thread-1001",
      externalCustomerId: "cust-555",
      customerName: "Nguyễn Văn A",
      externalMessageId: "fb-msg-9999",
      text: "Shop có áo khoác size L màu đen không ạ?",
      timestamp: new Date(),
    });

    expect(receivedInbound).not.toBeNull();
    expect(receivedInbound?.text).toBe("Shop có áo khoác size L màu đen không ạ?");
    expect(receivedInbound?.channelAccountId).toBe("personal-messenger");

    // 2. Browser agent navigates to thread
    const opened = await adapter.openConversation(receivedInbound!.externalThreadRef);
    expect(opened).toBe(true);

    const activeRef = await adapter.getOpenConversationRef();
    expect(activeRef?.externalThreadRef).toBe(receivedInbound!.externalThreadRef);

    // 3. Browser agent types reply
    const replyText = "Dạ bên shop còn sẵn size L màu đen bạn nhé!";
    const typingRes = await adapter.typeDraft(replyText);
    expect(typingRes.completed).toBe(true);
    expect(adapter.composerText).toBe(replyText);

    // 4. Send draft
    const sendRes = await adapter.sendDraft("action-abc-123");
    expect(sendRes.sent).toBe(true);
    expect(adapter.composerText).toBe(""); // Composer cleared after send

    // 5. Verify sent
    const verifyRes = await adapter.verifySent(replyText, "hash-123");
    expect(verifyRes.verified).toBe(true);
    expect(verifyRes.messageRef).toBeDefined();

    // 6. Check sent messages history
    expect(adapter.sentMessages.length).toBe(1);
    expect(adapter.sentMessages[0]?.text).toBe(replyText);
  });

  it("triggers circuit breaker when checkpoint or DOM error occurs", async () => {
    const adapter = new MockChannelAdapter("personal-messenger");

    // Initially healthy
    let health = await adapter.health();
    expect(health.healthy).toBe(true);
    expect(health.status).toBe("RUNNING");

    // Simulate Facebook checkpoint trigger
    adapter.checkpointTriggered = true;

    health = await adapter.health();
    expect(health.healthy).toBe(false);
    expect(health.status).toBe("SUSPENDED");
    expect(health.checkpointDetected).toBe(true);
  });
});
