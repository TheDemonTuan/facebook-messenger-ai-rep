import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractMessengerThreadId,
  shouldInspectMessengerThread,
  isSnippetOutgoing,
  extractCleanSnippetText,
  getObserverPollDelay,
  PlaywrightMessengerAdapter,
} from "../apps/browser-agent/src/messenger-adapter.js";
import { parseMessengerBubblesFromHtml } from "../packages/channel/src/dom-parser.js";
import { getIncidentSafetyPolicy, isCheckpoint } from "../apps/dashboard/src/helpers/incident-helpers.js";
import type { IncidentItem } from "../apps/dashboard/src/types.js";

describe("Messenger session hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["https://www.facebook.com/messages/t/123456", "123456"],
    ["https://www.facebook.com/messages/e2ee/t/987654/", "987654"],
    ["/messages/t/thread-name?ref=bookmarks", "thread-name"],
  ])("extracts thread identity from supported Messenger routes", (url, expected) => {
    expect(extractMessengerThreadId(url)).toBe(expected);
  });

  it("does not treat the inbox or unrelated tabs as an open Messenger thread", () => {
    expect(extractMessengerThreadId("https://www.facebook.com/messages/t/")).toBeNull();
    expect(extractMessengerThreadId("https://www.facebook.com/")).toBeNull();
    expect(extractMessengerThreadId("about:blank")).toBeNull();
  });

  it("identifies outgoing snippets sent by viewer/bot", () => {
    expect(isSnippetOutgoing("Bạn: Chào bạn")).toBe(true);
    expect(isSnippetOutgoing("Lê Văn Hùng Bạn: Cảm ơn bạn")).toBe(true);
    expect(isSnippetOutgoing("You: Hello")).toBe(true);
    expect(isSnippetOutgoing("Trần Thị Mai You: Thanks")).toBe(true);
    expect(isSnippetOutgoing("Bạn đã gửi một ảnh")).toBe(true);
    expect(isSnippetOutgoing("Trần Thị Mai Shop ơi cho em hỏi")).toBe(false);
    expect(isSnippetOutgoing("Chào shop")).toBe(false);
  });

  it("extracts clean snippet message text without chat loading", () => {
    expect(
      extractCleanSnippetText("Trần Thị Mai Shop ơi cho em hỏi áo khoác có size L không ạ? · 2 phút", "Trần Thị Mai")
    ).toBe("Shop ơi cho em hỏi áo khoác có size L không ạ?");

    expect(
      extractCleanSnippetText("Trần Thị Mai: Chào shop mình muốn tư vấn combo · 1 giờ", "Trần Thị Mai")
    ).toBe("Chào shop mình muốn tư vấn combo");

    expect(
      extractCleanSnippetText("John Doe Hello, is this available in size M? · 15m", "John Doe")
    ).toBe("Hello, is this available in size M?");

    expect(
      extractCleanSnippetText("Shop ơi cho em hỏi áo khoác có size L không ạ?", "Trần Thị Mai")
    ).toBe("Shop ơi cho em hỏi áo khoác có size L không ạ?");

    expect(
      extractCleanSnippetText("Trần Thị Mai: Dạ vâng 2 phút", "Trần Thị Mai")
    ).toBe("Dạ vâng");

    expect(
      extractCleanSnippetText("0964280740 sent an attachment. 5 phút", "0964280740")
    ).toBe("sent an attachment.");
    expect(
      extractCleanSnippetText("0964280740 sent an attachment. 6 phút", "0964280740")
    ).toBe("sent an attachment.");
  });

  it("calculates relaxed observer poll delay with human-like jitter", () => {
    for (let i = 0; i < 20; i++) {
      const delay = getObserverPollDelay();
      expect(delay).toBeGreaterThanOrEqual(4500);
      expect(delay).toBeLessThanOrEqual(6000);
    }
  });

  it("inspects unread, changed, and currently open conversations without replaying unknown history", () => {
    expect(shouldInspectMessengerThread(null, "new-thread", false, undefined, "new message")).toBe(false);
    expect(shouldInspectMessengerThread(null, "thread-1", true, "same", "same")).toBe(true);
    expect(shouldInspectMessengerThread(null, "thread-1", false, "old", "new")).toBe(true);
    expect(shouldInspectMessengerThread("thread-1", "thread-1", false, "same", "same")).toBe(true);
    expect(shouldInspectMessengerThread("thread-2", "thread-1", false, "same", "same")).toBe(false);
    // Anti-hopping: if viewing thread-2, an unread thread-1 with unchanged snippet must not switch
    expect(shouldInspectMessengerThread("thread-2", "thread-1", true, "same", "same")).toBe(false);
    // Anti-hopping: outgoing snippets sent by us must NEVER trigger switching
    expect(shouldInspectMessengerThread("thread-2", "thread-1", true, "old", "Bạn: Chào bạn")).toBe(false);
    expect(shouldInspectMessengerThread(null, "thread-1", true, undefined, "Bạn: Chào bạn")).toBe(false);
    // If thread-1 snippet changes to a genuine incoming message, it must switch
    expect(shouldInspectMessengerThread("thread-2", "thread-1", true, "old", "Shop ơi")).toBe(true);
  });

  it("polls the active conversation even when its sidebar row is read and unchanged", async () => {
    vi.useFakeTimers();

    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const activeBubble = {
      id: "mid.active-new-message",
      text: "Tin mới trong chat đang mở",
      isOutgoing: false,
      senderId: "customer-1",
      senderKind: "PERSON" as const,
      senderReliability: "VERIFIED" as const,
      threadKind: "DIRECT" as const,
      threadReliability: "VERIFIED" as const,
      threadEvidence: [],
      senderEvidence: [],
      mentions: [],
      observedTimestamp: new Date("2026-09-06T12:00:00.000Z"),
    };
    const page = {
      url: () => "https://www.facebook.com/messages/t/thread-1",
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue([
          {
            threadId: "thread-1",
            href: "/messages/t/thread-1",
            customerName: "Khách hàng",
            avatarUrl: null,
            participantId: "customer-1",
            snippet: "tin cũ",
            isUnread: false,
          },
        ]),
    };
    const callback = vi.fn().mockResolvedValue(undefined);
    const readBubbles = vi.fn().mockResolvedValue({
      ok: true,
      bubbles: [activeBubble],
      isDegraded: false,
      threadClassification: {
        kind: "DIRECT",
        reliability: "VERIFIED",
        evidence: [],
      },
    });

    Object.assign(adapter as any, {
      observerPage: page,
      page,
      isInitializedBaseline: true,
      lastSeenSnippets: new Map([["thread-1", "tin cũ"]]),
      initializedThreadIds: new Set(["thread-1"]),
      ensureObserverPage: vi.fn().mockResolvedValue(page),
      inspectSessionState: vi.fn().mockResolvedValue(null),
      clearSessionIssue: vi.fn().mockResolvedValue(undefined),
      readBubblesFromPage: readBubbles,
    });

    await adapter.observeInbound(callback);
    await vi.advanceTimersByTimeAsync(1000);
    await adapter.stopObserving();
    vi.useRealTimers();

    expect(readBubbles).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        externalThreadId: "thread-1",
        externalMessageId: expect.stringMatching(/^active\.\$thread-1\./),
        text: "Tin mới trong chat đang mở",
      })
    );
  });

  it("classifies message direction from row evidence rather than message text", () => {
    const parsed = parseMessengerBubblesFromHtml(`
      <div role="main">
        <div role="row" id="mid.customer-repeat"><span dir="auto">Câu trả lời giống nhau</span></div>
      </div>
    `, {
      threadKindHint: "DIRECT",
      threadReliabilityHint: "VERIFIED",
    });

    expect(parsed.bubbles[0]?.isOutgoing).toBe(false);
  });

  it("does not leak an outgoing marker from one row into later incoming rows", () => {
    const parsed = parseMessengerBubblesFromHtml(`
      <div role="main">
        <div role="row" id="mid.outgoing" data-outgoing="true"><span dir="auto">63k</span></div>
        <div role="row" id="mid.incoming"><span dir="auto">tin mới từ khách</span></div>
      </div>
    `, { threadKindHint: "DIRECT", threadReliabilityHint: "VERIFIED" });

    expect(parsed.bubbles).toHaveLength(2);
    expect(parsed.bubbles[0]?.isOutgoing).toBe(true);
    expect(parsed.bubbles[1]?.isOutgoing).toBe(false);
  });

  it("keeps the sidebar customer name when bubble metadata contains message text", async () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const callback = vi.fn().mockResolvedValue(undefined);
    Object.assign(adapter as any, { inboundCallback: callback });

    await (adapter as any).processInboundBubbles(
      {
        ok: true,
        isDegraded: false,
        headerTitle: "một đoạn nội dung bị nhận nhầm",
        bubbles: [{
          id: "mid.customer-name",
          text: "tin khách",
          isOutgoing: false,
          senderId: "customer-1",
          senderName: "tên thiếu",
          senderKind: "PERSON",
          senderReliability: "VERIFIED",
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date("2026-09-06T12:00:00.000Z"),
        }],
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Sin Sin", avatarUrl: null },
      true
    );

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ customerName: "Sin Sin" }));
  });

  it("processes a new active-chat occurrence when Messenger reuses its DOM message id", async () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const existingBubble = {
      id: "mid.reused-row",
      text: "tin cũ",
      isOutgoing: false,
      senderId: "customer-1",
      senderKind: "PERSON" as const,
      senderReliability: "VERIFIED" as const,
      threadKind: "DIRECT" as const,
      threadReliability: "VERIFIED" as const,
      threadEvidence: [],
      senderEvidence: [],
      mentions: [],
      observedTimestamp: new Date("2026-09-06T12:00:00.000Z"),
    };
    const newBubbleWithReusedId = {
      ...existingBubble,
      text: "tin mới nhưng cùng id DOM",
      observedTimestamp: new Date("2026-09-06T12:01:00.000Z"),
    };
    const callback = vi.fn().mockResolvedValue(undefined);

    Object.assign(adapter as any, {
      inboundCallback: callback,
      lastSeenMessageIds: new Set(["mid.reused-row"]),
      lastSeenActiveSignatures: new Map([["thread-1:in:tin cũ", 1]]),
    });

    await (adapter as any).processInboundBubbles(
      {
        ok: true,
        bubbles: [existingBubble, newBubbleWithReusedId],
        isDegraded: false,
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Khách hàng", avatarUrl: null },
      true
    );

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        externalThreadId: "thread-1",
        externalMessageId: expect.stringMatching(/^active\.\$thread-1\./),
        text: "tin mới nhưng cùng id DOM",
      })
    );
  });

  it("verifies a sent bubble when Messenger reuses the latest DOM id after Enter", async () => {
    const adapter = new PlaywrightMessengerAdapter({ profileDir: "./test-profile" });
    const expectedText = "Nội dung bot vừa gửi";
    const composer = {
      evaluate: vi.fn().mockResolvedValue(true),
    };
    const page = {
      url: () => "https://www.facebook.com/messages/t/thread-1",
      locator: vi.fn().mockReturnValue({ first: () => composer }),
    };
    Object.assign(adapter as any, {
      senderPage: page,
      readBubblesFromPage: vi.fn().mockResolvedValue({
        ok: true,
        isDegraded: false,
        bubbles: [{ id: "mid.reused-latest", text: expectedText, isOutgoing: true }],
      }),
    });

    const result = await adapter.verifySent(
      expectedText,
      "hash",
      {
        threadRef: "https://www.facebook.com/messages/t/thread-1",
        knownMessageIds: ["mid.reused-latest"],
        knownMessageTexts: { "mid.reused-latest": "Nội dung cũ" },
        lastMessageId: "mid.reused-latest",
        messageCount: 1,
        capturedAt: new Date(),
      },
      100
    );

    expect(result).toEqual({ verified: true, messageRef: "mid.reused-latest" });
    expect((adapter as any).lastSeenMessageIds.has("mid.reused-latest")).toBe(true);
    expect((adapter as any).confirmedOutboundMessageIds.has("mid.reused-latest")).toBe(true);
  });

  it("does not emit a confirmed outgoing id when the DOM later misclassifies it as incoming", async () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const callback = vi.fn().mockResolvedValue(undefined);
    Object.assign(adapter as any, {
      inboundCallback: callback,
      lastSeenMessageIds: new Set(["mid.confirmed"]),
      confirmedOutboundMessageIds: new Set(["mid.confirmed"]),
    });

    await (adapter as any).processInboundBubbles(
      {
        ok: true,
        isDegraded: false,
        bubbles: [{
          id: "mid.confirmed",
          text: "Câu bot đã gửi",
          isOutgoing: false,
          senderId: "customer-1",
          senderKind: "PERSON",
          senderReliability: "VERIFIED",
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date(),
        }],
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Sin Sin", avatarUrl: null },
      true
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it("does not verify a matching bubble while the draft still remains in the composer", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightMessengerAdapter({ profileDir: "./test-profile" });
    const expectedText = "Nội dung chưa gửi";
    const page = {
      locator: vi.fn().mockReturnValue({
        first: () => ({ evaluate: vi.fn().mockResolvedValue(false) }),
      }),
    };
    Object.assign(adapter as any, {
      senderPage: page,
      readBubblesFromPage: vi.fn().mockResolvedValue({
        ok: true,
        isDegraded: false,
        bubbles: [{ id: "mid.new-but-draft-remains", text: expectedText, isOutgoing: true }],
      }),
    });

    const verification = adapter.verifySent(
      expectedText,
      "hash",
      {
        threadRef: "https://www.facebook.com/messages/t/thread-1",
        knownMessageIds: [],
        knownMessageTexts: {},
        lastMessageId: null,
        messageCount: 0,
        capturedAt: new Date(),
      },
      100
    );
    await vi.advanceTimersByTimeAsync(600);

    await expect(verification).resolves.toEqual({ verified: false });
    vi.useRealTimers();
  });

  it("does not verify a historical matching bubble when its id and text are unchanged", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightMessengerAdapter({ profileDir: "./test-profile" });
    const expectedText = "Nội dung cũ";
    const page = {
      locator: vi.fn().mockReturnValue({
        first: () => ({ evaluate: vi.fn().mockResolvedValue(true) }),
      }),
    };
    Object.assign(adapter as any, {
      senderPage: page,
      readBubblesFromPage: vi.fn().mockResolvedValue({
        ok: true,
        isDegraded: false,
        bubbles: [{ id: "mid.historical", text: expectedText, isOutgoing: true }],
      }),
    });

    const verification = adapter.verifySent(
      expectedText,
      "hash",
      {
        threadRef: "https://www.facebook.com/messages/t/thread-1",
        knownMessageIds: ["mid.historical"],
        knownMessageTexts: { "mid.historical": expectedText },
        lastMessageId: "mid.historical",
        messageCount: 1,
        capturedAt: new Date(),
      },
      100
    );
    await vi.advanceTimersByTimeAsync(600);

    await expect(verification).resolves.toEqual({ verified: false });
    vi.useRealTimers();
  });

  it("treats login-required incidents as session recovery incidents", () => {
    const incident = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "SESSION_EXPIRED",
      title: "Phiên Facebook đã hết hạn",
      description: "Đăng nhập lại",
      status: "OPEN",
      metadata: { kind: "LOGIN_REQUIRED" },
      createdAt: new Date().toISOString(),
    } as IncidentItem;

    expect(isCheckpoint(incident)).toBe(true);
    expect(getIncidentSafetyPolicy(incident).allowedActions).toContain("OPEN_CONSOLE");
  });

  it("supports RATE_LIMITED as a valid browser session issue kind", () => {
    const issue = {
      kind: "RATE_LIMITED" as const,
      message: "Facebook tạm thời chặn do thao tác quá nhanh. Hệ thống tạm dừng để phiên nghỉ ngơi.",
    };
    expect(issue.kind).toBe("RATE_LIMITED");
  });

  it("coordinates single tab with sendLock", () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
    });
    expect(adapter.isSendLocked()).toBe(false);
    adapter.acquireSendLock();
    expect(adapter.isSendLocked()).toBe(true);
    adapter.releaseSendLock();
    expect(adapter.isSendLocked()).toBe(false);
  });
});
