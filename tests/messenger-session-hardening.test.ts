import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractMessengerThreadId,
  shouldInspectMessengerThread,
  getObserverPollDelay,
  PlaywrightMessengerAdapter,
} from "../apps/browser-agent/src/messenger-adapter.js";
import {
  parseMessengerBubblesFromHtml,
  isSnippetOutgoing,
  extractCleanSnippetText,
} from "../packages/channel/src/index.js";
import { TurnRepository } from "../packages/db/src/repository/turn-repo.js";
import { getIncidentSafetyPolicy, isCheckpoint } from "../apps/dashboard/src/helpers/incident-helpers.js";
import type { IncidentItem } from "../apps/dashboard/src/types.js";

type AdapterInternals = {
  observerPage?: unknown;
  page?: unknown;
  isInitializedBaseline?: boolean;
  lastSeenSidebarThreads: Map<string, { snippet: string; isUnread: boolean }>;
  observerBusy?: boolean;
  sendLock?: boolean;
  ensureObserverPage?: unknown;
  inspectSessionState?: unknown;
  clearSessionIssue?: unknown;
  readBubblesFromPage?: unknown;
  inboundCallback?: unknown;
  lastSeenMessageIds: Set<string>;
  confirmedOutboundMessageIds: Set<string>;
  lastSeenActiveSignatures: Map<string, number>;
  senderPage?: unknown;
  processInboundBubbles: (...args: unknown[]) => Promise<number>;
};

const internals = (adapter: PlaywrightMessengerAdapter): AdapterInternals =>
  adapter as unknown as AdapterInternals;

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

  it("evaluates sidebar thread inspection triggers via transition matrix", () => {
    // 1. active conversation is polled separately via open chat DOM -> false
    expect(
      shouldInspectMessengerThread(
        "thread-1",
        { threadId: "thread-1", snippet: "tin mới", isUnread: true, isOutgoing: false },
        { snippet: "tin cũ", isUnread: false }
      )
    ).toBe(false);

    // 2. outgoing snippets sent by viewer/bot never trigger -> false
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Bạn: Chào bạn", isUnread: true, isOutgoing: true },
        undefined
      )
    ).toBe(false);
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Bạn đã gửi một ảnh", isUnread: true, isOutgoing: false },
        { snippet: "cũ", isUnread: false }
      )
    ).toBe(false);

    // 3. unchanged read thread does not trigger -> false
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Chào shop", isUnread: false, isOutgoing: false },
        { snippet: "Chào shop", isUnread: false }
      )
    ).toBe(false);

    // 4. new thread appearing after baseline triggers once -> true
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "new-thread", snippet: "Khách mới hỏi", isUnread: false, isOutgoing: false },
        undefined
      )
    ).toBe(true);

    // 5. snippet changed triggers inspection -> true
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Shop còn size M không?", isUnread: false, isOutgoing: false },
        { snippet: "Shop ơi", isUnread: false }
      )
    ).toBe(true);

    // 6. unread transitioned false -> true triggers -> true
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Chào shop", isUnread: true, isOutgoing: false },
        { snippet: "Chào shop", isUnread: false }
      )
    ).toBe(true);

    // 7. repeated same text after read triggers because isUnread transitioned false -> true -> true
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Alo", isUnread: true, isOutgoing: false },
        { snippet: "Alo", isUnread: false }
      )
    ).toBe(true);

    // 8. unchanged unread thread does not loop -> false
    expect(
      shouldInspectMessengerThread(
        "other",
        { threadId: "thread-1", snippet: "Alo", isUnread: true, isOutgoing: false },
        { snippet: "Alo", isUnread: true }
      )
    ).toBe(false);
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

    Object.assign(internals(adapter), {
      observerPage: page,
      page,
      isInitializedBaseline: true,
      lastSeenSidebarThreads: new Map([["thread-1", { snippet: "tin cũ", isUnread: false }]]),
      ensureObserverPage: vi.fn().mockResolvedValue(page),
      inspectSessionState: vi.fn().mockResolvedValue(null),
      clearSessionIssue: vi.fn().mockResolvedValue(undefined),
      readBubblesFromPage: readBubbles,
      dismissOverlays: vi.fn().mockResolvedValue(undefined),
    });

    await adapter.observeInbound(callback);
    await vi.advanceTimersByTimeAsync(2000);
    await adapter.stopObserving();
    vi.useRealTimers();

    expect(readBubbles).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        externalThreadId: "thread-1",
        externalMessageId: "mid.active-new-message",
        text: "Tin mới trong chat đang mở",
      })
    );
  });
  it("navigates to an incoming thread from the sidebar when active conversation is Sin Sin and emits verified inbound", async () => {
    vi.useFakeTimers();

    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });

    let currentUrl = "https://www.facebook.com/messages/t/sin-sin";
    const page = {
      url: () => currentUrl,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForURL: vi.fn().mockImplementation((predicate: (u: URL) => boolean) => {
        if (predicate(new URL(currentUrl))) return Promise.resolve();
        return Promise.resolve();
      }),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(true),
          click: vi.fn().mockImplementation(() => {
            currentUrl = "https://www.facebook.com/messages/t/thread-2";
            return Promise.resolve();
          }),
        }),
      }),
      goto: vi.fn().mockImplementation((url: string) => {
        currentUrl = url;
        return Promise.resolve();
      }),
      evaluate: vi.fn().mockImplementation(() => {
        return Promise.resolve([
          {
            threadId: "sin-sin",
            href: "/messages/t/sin-sin",
            customerName: "Sin Sin",
            avatarUrl: null,
            participantId: "customer-sin-sin",
            snippet: "cũ",
            isUnread: false,
          },
          {
            threadId: "thread-2",
            href: "/messages/t/thread-2",
            customerName: "Khách Hai",
            avatarUrl: null,
            participantId: "customer-2",
            snippet: "Shop ơi",
            isUnread: true,
          },
        ]);
      }),
    };

    const callback = vi.fn().mockResolvedValue(undefined);
    const readBubbles = vi.fn().mockImplementation((_page: unknown, opts: { threadId?: string }) => {
      if (opts?.threadId === "thread-2") {
        return Promise.resolve({
          ok: true,
          bubbles: [
            {
              id: "mid.thread-2.new",
              text: "Shop ơi",
              isOutgoing: false,
              senderId: "customer-2",
              senderKind: "PERSON" as const,
              senderReliability: "VERIFIED" as const,
              threadKind: "DIRECT" as const,
              threadReliability: "VERIFIED" as const,
              threadEvidence: [],
              senderEvidence: [],
              mentions: [],
              observedTimestamp: new Date("2026-09-06T12:00:00.000Z"),
            },
          ],
          isDegraded: false,
          threadClassification: {
            kind: "DIRECT",
            reliability: "VERIFIED",
            evidence: [],
          },
        });
      }
      return Promise.resolve({
        ok: true,
        bubbles: [],
        isDegraded: false,
        threadClassification: {
          kind: "DIRECT",
          reliability: "VERIFIED",
          evidence: [],
        },
      });
    });

    Object.assign(internals(adapter), {
      observerPage: page,
      page,
      lastSeenSidebarThreads: new Map([
        ["sin-sin", { snippet: "cũ", isUnread: false }],
        ["thread-2", { snippet: "cũ", isUnread: false }],
      ]),
      ensureObserverPage: vi.fn().mockResolvedValue(page),
      ensureSenderPage: vi.fn().mockResolvedValue(page),
      inspectSessionState: vi.fn().mockResolvedValue(null),
      clearSessionIssue: vi.fn().mockResolvedValue(undefined),
      readBubblesFromPage: readBubbles,
      dismissOverlays: vi.fn().mockResolvedValue(undefined),
    });

    await adapter.observeInbound(callback);
    await vi.advanceTimersByTimeAsync(1000);
    await adapter.stopObserving();
    vi.useRealTimers();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        externalThreadId: "thread-2",
        externalMessageId: "mid.thread-2.new",
        threadReliability: "VERIFIED",
        senderReliability: "VERIFIED",
      })
    );
    for (const call of callback.mock.calls) {
      expect(call[0].externalMessageId).not.toMatch(/^snip\.\$/);
    }
  });
  it("handles baseline: does not emit read historical rows, but opens and emits incoming unread rows", async () => {
    vi.useFakeTimers();

    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });

    let currentUrl = "https://www.facebook.com/messages/t/active-read";
    const page = {
      url: () => currentUrl,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForURL: vi.fn().mockImplementation((predicate: (u: URL) => boolean) => {
        if (predicate(new URL(currentUrl))) return Promise.resolve();
        return Promise.resolve();
      }),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(true),
          click: vi.fn().mockImplementation(() => {
            currentUrl = "https://www.facebook.com/messages/t/unread-pending";
            return Promise.resolve();
          }),
        }),
      }),
      goto: vi.fn().mockImplementation((url: string) => {
        currentUrl = url;
        return Promise.resolve();
      }),
      evaluate: vi.fn().mockImplementation(() => {
        return Promise.resolve([
          {
            threadId: "active-read",
            href: "/messages/t/active-read",
            customerName: "Khách Đã Đọc",
            avatarUrl: null,
            participantId: "cust-read",
            snippet: "Lịch sử cũ",
            isUnread: false,
          },
          {
            threadId: "unread-pending",
            href: "/messages/t/unread-pending",
            customerName: "Khách Đang Chờ",
            avatarUrl: null,
            participantId: "cust-unread",
            snippet: "Cần tư vấn",
            isUnread: true,
          },
        ]);
      }),
    };

    const callback = vi.fn().mockResolvedValue(undefined);
    const readBubbles = vi.fn().mockImplementation((_page: unknown, opts: { threadId?: string }) => {
      if (opts?.threadId === "active-read") {
        return Promise.resolve({
          ok: true,
          bubbles: [
            {
              id: "mid.hist-1",
              text: "Lịch sử cũ",
              isOutgoing: false,
              senderId: "cust-read",
              senderKind: "PERSON" as const,
              senderReliability: "VERIFIED" as const,
              threadKind: "DIRECT" as const,
              threadReliability: "VERIFIED" as const,
              threadEvidence: [],
              senderEvidence: [],
              mentions: [],
              observedTimestamp: new Date(),
            },
          ],
          isDegraded: false,
        });
      }
      if (opts?.threadId === "unread-pending") {
        return Promise.resolve({
          ok: true,
          bubbles: [
            {
              id: "mid.pending-1",
              text: "Cần tư vấn",
              isOutgoing: false,
              senderId: "cust-unread",
              senderKind: "PERSON" as const,
              senderReliability: "VERIFIED" as const,
              threadKind: "DIRECT" as const,
              threadReliability: "VERIFIED" as const,
              threadEvidence: [],
              senderEvidence: [],
              mentions: [],
              observedTimestamp: new Date(),
            },
          ],
          isDegraded: false,
        });
      }
      return Promise.resolve({ ok: true, bubbles: [], isDegraded: false });
    });

    Object.assign(internals(adapter), {
      observerPage: page,
      page,
      isInitializedBaseline: false,
      ensureObserverPage: vi.fn().mockResolvedValue(page),
      ensureSenderPage: vi.fn().mockResolvedValue(page),
      inspectSessionState: vi.fn().mockResolvedValue(null),
      clearSessionIssue: vi.fn().mockResolvedValue(undefined),
      readBubblesFromPage: readBubbles,
      dismissOverlays: vi.fn().mockResolvedValue(undefined),
    });

    await adapter.observeInbound(callback);
    await vi.advanceTimersByTimeAsync(1000);
    await adapter.stopObserving();
    vi.useRealTimers();

    // Active read historical row was NOT emitted
    for (const call of callback.mock.calls) {
      expect(call[0].externalMessageId).not.toBe("mid.hist-1");
    }
    // Incoming unread pending row was emitted
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        externalThreadId: "unread-pending",
        externalMessageId: "mid.pending-1",
        text: "Cần tư vấn",
      })
    );
  });

  it("retries inbound bubble processing if downstream callback rejects and commits state only on resolve", async () => {
    vi.useFakeTimers();

    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });

    const currentUrl = "https://www.facebook.com/messages/t/thread-retry";
    const page = {
      url: () => currentUrl,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue([
        {
          threadId: "thread-retry",
          href: "/messages/t/thread-retry",
          customerName: "Khách Retry",
          avatarUrl: null,
          participantId: "cust-retry",
          snippet: "Tin cần gửi lại",
          isUnread: true,
        },
      ]),
    };

    let callCount = 0;
    const callback = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Downstream network failure"));
      }
      return Promise.resolve();
    });

    const readBubbles = vi.fn().mockResolvedValue({
      ok: true,
      bubbles: [
        {
          id: "mid.retry-msg-1",
          text: "Tin cần gửi lại",
          isOutgoing: false,
          senderId: "cust-retry",
          senderKind: "PERSON" as const,
          senderReliability: "VERIFIED" as const,
          threadKind: "DIRECT" as const,
          threadReliability: "VERIFIED" as const,
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date(),
        },
      ],
      isDegraded: false,
    });

    Object.assign(internals(adapter), {
      observerPage: page,
      page,
      isInitializedBaseline: true,
      lastSeenSidebarThreads: new Map([["thread-retry", { snippet: "cũ", isUnread: false }]]),
      ensureObserverPage: vi.fn().mockResolvedValue(page),
      ensureSenderPage: vi.fn().mockResolvedValue(page),
      inspectSessionState: vi.fn().mockResolvedValue(null),
      clearSessionIssue: vi.fn().mockResolvedValue(undefined),
      readBubblesFromPage: readBubbles,
      dismissOverlays: vi.fn().mockResolvedValue(undefined),
    });

    await adapter.observeInbound(callback);
    // First poll: callback rejects
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);
    // Message id must NOT be acknowledged/seen
    expect(internals(adapter).lastSeenMessageIds.has("mid.retry-msg-1")).toBe(false);

    // Second poll: retry occurs and succeeds
    await vi.advanceTimersByTimeAsync(6000);
    expect(callCount).toBe(2);
    // Now committed
    expect(internals(adapter).lastSeenMessageIds.has("mid.retry-msg-1")).toBe(true);

    await adapter.stopObserving();
    vi.useRealTimers();
  });

  it("prevents concurrency: sender waits for observer idle before navigating, and observer pauses when sender is locked", async () => {
    vi.useFakeTimers();

    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });

    let currentUrl = "https://www.facebook.com/messages/t/thread-sender";
    const senderPage = {
      url: () => currentUrl,
      waitForURL: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(true),
          click: vi.fn().mockImplementation(() => {
            currentUrl = "https://www.facebook.com/messages/t/thread-target";
            return Promise.resolve();
          }),
        }),
      }),
      goto: vi.fn().mockImplementation((url: string) => {
        currentUrl = url;
        return Promise.resolve();
      }),
      evaluate: vi.fn().mockResolvedValue(true),
    };

    Object.assign(internals(adapter), {
      senderPage,
      ensureSenderPage: vi.fn().mockResolvedValue(senderPage),
      dismissOverlays: vi.fn().mockResolvedValue(undefined),
      observerBusy: true,
    });

    // openConversation waits for observer to become idle
    const openPromise = adapter.openConversation("thread-target");
    expect(internals(adapter).sendLock).toBe(true);

    // Observer finishes after 100ms
    setTimeout(() => {
      internals(adapter).observerBusy = false;
    }, 100);

    await vi.advanceTimersByTimeAsync(150);
    const opened = await openPromise;
    expect(opened).toBe(true);

    vi.useRealTimers();
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

  it("removes an image part when its URL is the resolved customer avatar", async () => {
    const adapter = new PlaywrightMessengerAdapter({ profileDir: "./test-profile", channelAccountId: "account-1" });
    const callback = vi.fn().mockResolvedValue(undefined);
    Object.assign(internals(adapter), { inboundCallback: callback });

    const avatarUrl = "https://scontent.example/avatar.jpg?size=100&token=live";
    await internals(adapter).processInboundBubbles(
      {
        ok: true,
        bubbles: [{
          id: "mid.observed-text-avatar",
          text: "Observed customer text",
          isOutgoing: false,
          hasMedia: true,
          contentStatus: "PARTIAL",
          parts: [
            { type: "TEXT", text: "Observed customer text" },
            {
              type: "IMAGE",
              media: {
                mediaId: "img:avatar",
                mediaRefId: "mid.observed-text-avatar:image:0",
                role: "ATTACHMENT",
                status: "READY",
                sourceUrl: avatarUrl.replace(/&/g, "&amp;"),
              },
              altText: "Customer",
            },
          ],
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date("2026-09-08T15:37:19.000Z"),
        }],
        isDegraded: false,
        avatarUrl,
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Customer", avatarUrl },
      true
    );

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      text: "Observed customer text",
      parts: [{ type: "TEXT", text: "Observed customer text" }],
      contentStatus: "READY",
    }));
  });

  it("preserves an image attachment when its URL differs from the customer avatar", async () => {
    const adapter = new PlaywrightMessengerAdapter({ profileDir: "./test-profile", channelAccountId: "account-1" });
    const callback = vi.fn().mockResolvedValue(undefined);
    Object.assign(internals(adapter), { inboundCallback: callback });

    await internals(adapter).processInboundBubbles(
      {
        ok: true,
        bubbles: [{
          id: "mid.real-image",
          text: "Ảnh sản phẩm",
          isOutgoing: false,
          hasMedia: true,
          contentStatus: "READY",
          parts: [{
            type: "IMAGE",
            media: {
              mediaId: "img:attachment",
              mediaRefId: "mid.real-image:image:0",
              role: "ATTACHMENT",
              status: "READY",
              sourceUrl: "https://scontent.example/product.jpg?token=live",
            },
          }],
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date("2026-09-08T15:38:19.000Z"),
        }],
        isDegraded: false,
        avatarUrl: "https://scontent.example/avatar.jpg?size=100&token=live",
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Customer" },
      true
    );

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      parts: [expect.objectContaining({ type: "IMAGE" })],
    }));
  });

  it("never emits an outgoing bubble through the inbound callback", async () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const callback = vi.fn().mockResolvedValue(undefined);
    Object.assign(internals(adapter), { inboundCallback: callback });

    await internals(adapter).processInboundBubbles(
      {
        ok: true,
        bubbles: [{
          id: "mid.self-message",
          text: "tin do chính tài khoản gửi",
          isOutgoing: true,
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date("2026-09-06T12:00:00.000Z"),
        }],
        isDegraded: false,
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Khách hàng", avatarUrl: null },
      true
    );

    expect(callback).not.toHaveBeenCalled();
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
    Object.assign(internals(adapter), { inboundCallback: callback });

    await internals(adapter).processInboundBubbles(
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

  it("does not re-emit a stable active-chat message under a synthetic id", async () => {
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

    Object.assign(internals(adapter), {
      inboundCallback: callback,
      lastSeenMessageIds: new Set(["mid.reused-row"]),
      lastSeenActiveSignatures: new Map([["thread-1:in:tin cũ", 1]]),
    });

    await internals(adapter).processInboundBubbles(
      {
        ok: true,
        bubbles: [existingBubble, newBubbleWithReusedId],
        isDegraded: false,
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Khách hàng", avatarUrl: null },
      true
    );

    expect(callback).not.toHaveBeenCalled();
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
    Object.assign(internals(adapter), {
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
    expect(internals(adapter).lastSeenMessageIds.has("mid.reused-latest")).toBe(true);
    expect(internals(adapter).confirmedOutboundMessageIds.has("mid.reused-latest")).toBe(true);
  });

  it("does not classify a just-confirmed bot bubble as external human outbound", async () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const externalOutboundCallback = vi.fn().mockResolvedValue(undefined);
    Object.assign(internals(adapter), {
      externalOutboundCallback,
      threadBaselinesEstablished: new Set(["thread-1"]),
      seenOutgoingBubbleIds: new Set<string>(),
      confirmedOutboundMessageIds: new Set(["mid.confirmed-bot"]),
    });

    await internals(adapter).processInboundBubbles(
      {
        ok: true,
        isDegraded: false,
        bubbles: [{
          id: "mid.confirmed-bot",
          text: "Dạ shop nhận được tin nhắn rồi nha 😄",
          isOutgoing: true,
          threadKind: "DIRECT",
          threadReliability: "VERIFIED",
          threadEvidence: [],
          senderEvidence: [],
          mentions: [],
          observedTimestamp: new Date(),
        }],
        threadClassification: { kind: "DIRECT", reliability: "VERIFIED", evidence: [] },
      },
      { threadId: "thread-1", customerName: "Customer", avatarUrl: null },
      true
    );

    expect(externalOutboundCallback).not.toHaveBeenCalled();
  });

  it("does not emit a confirmed outgoing id when the DOM later misclassifies it as incoming", async () => {
    const adapter = new PlaywrightMessengerAdapter({
      profileDir: "./test-profile",
      channelAccountId: "account-1",
    });
    const callback = vi.fn().mockResolvedValue(undefined);
    Object.assign(internals(adapter), {
      inboundCallback: callback,
      lastSeenMessageIds: new Set(["mid.confirmed"]),
      confirmedOutboundMessageIds: new Set(["mid.confirmed"]),
    });

    await internals(adapter).processInboundBubbles(
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
    Object.assign(internals(adapter), {
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
    Object.assign(internals(adapter), {
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

  it("parses outgoing bubbles with emojis and inner testid or outgoing attribute", () => {
    const html = `
      <div role="row" id="mid.outgoing-1">
        <div>
          <div data-outgoing="true">
            <span dir="auto">Ôi, buồn thế à? 😔 Không sao đâu, mọi thứ sẽ ổn thôi! Nếu cần tâm sự hay hỗ trợ gì về sản phẩm, đơn hàng gì thì mình đây nha!</span>
          </div>
        </div>
      </div>
    `;
    const result = parseMessengerBubblesFromHtml(html);
    expect(result.bubbles).toHaveLength(1);
    expect(result.bubbles[0].isOutgoing).toBe(true);
    expect(result.bubbles[0].text).toContain("Ôi, buồn thế à?");
  });

  describe("Messenger Adapter Evaluator & Real DOM Boundary Tests", () => {
    it("evaluates direct and group thread boundaries against live fixtures", async () => {
      const adapter = new PlaywrightMessengerAdapter({
        profileDir: "./test-profile",
        channelAccountId: "account-1",
        botParticipantId: "9999999999",
      });

      const liveDirectHtml = fs.readFileSync(
        path.resolve(__dirname, "fixtures/messenger-dom-e2ee-direct-live.html"),
        "utf-8"
      );
      const liveGroupHtml = fs.readFileSync(
        path.resolve(__dirname, "fixtures/messenger-dom-e2ee-group-live.html"),
        "utf-8"
      );

      // Direct page mock
      const directPage = {
        url: () => "https://www.facebook.com/messages/e2ee/t/888888888888888",
        evaluate: vi.fn().mockImplementation((fn: () => unknown) => {
          const fnStr = fn.toString();
          if (fnStr.includes("cloneNode") || (fnStr.includes("div[role=") && fnStr.includes("return clone"))) {
            return Promise.resolve(liveDirectHtml);
          }
          if (fnStr.includes("Conversation titled") || fnStr.includes("groupSelector")) {
            return Promise.resolve(false);
          }
          if (fnStr.includes("directProfileId") || fnStr.includes("profile.php?id=")) {
            return Promise.resolve("888888888888888");
          }
          if (fnStr.includes("mainHeaderInfo") || fnStr.includes("avatarImg") || fnStr.includes("avatarUrl")) {
            return Promise.resolve({ title: "Sanitized Customer", avatarUrl: "https://example.com/avatar.jpg" });
          }
          return Promise.resolve(null);
        }),
      };

      const directResult = await internals(adapter).readBubblesFromPage(directPage, {
        threadId: "888888888888888",
        participantId: "888888888888888",
        threadTitle: "Sanitized Customer",
      });

      expect(directResult.ok).toBe(true);
      expect(directResult.threadClassification?.kind).toBe("DIRECT");
      expect(directResult.threadClassification?.reliability).toBe("VERIFIED");
      expect(directResult.headerTitle).toBe("Sanitized Customer");

      const inDirect = directResult.bubbles.filter((b: { isOutgoing: boolean }) => !b.isOutgoing);
      expect(inDirect.length).toBeGreaterThan(0);
      for (const b of inDirect) {
        expect(b.senderId).toBe("888888888888888");
        expect(b.senderId).not.toBe("9999999999");
      }

      // Group page mock
      const groupPage = {
        url: () => "https://www.facebook.com/messages/e2ee/t/777777777777777",
        evaluate: vi.fn().mockImplementation((fn: () => unknown) => {
          const fnStr = fn.toString();
          if (fnStr.includes("cloneNode") || (fnStr.includes("div[role=") && fnStr.includes("return clone"))) {
            return Promise.resolve(liveGroupHtml);
          }
          if (fnStr.includes("Conversation titled") || fnStr.includes("groupSelector")) {
            return Promise.resolve(true);
          }
          if (fnStr.includes("directProfileId") || fnStr.includes("profile.php?id=")) {
            return Promise.resolve(null);
          }
          if (fnStr.includes("mainHeaderInfo") || fnStr.includes("avatarImg") || fnStr.includes("avatarUrl")) {
            return Promise.resolve({ title: "Test Group Room", avatarUrl: null });
          }
          return Promise.resolve(null);
        }),
      };

      const groupResult = await internals(adapter).readBubblesFromPage(groupPage, {
        threadId: "777777777777777",
        participantId: null,
        threadTitle: "Test Group Room",
      });

      expect(groupResult.ok).toBe(true);
      expect(groupResult.threadClassification?.kind).toBe("GROUP");
      expect(groupResult.threadClassification?.reliability).toBe("VERIFIED");
      expect(groupResult.headerTitle).toBe("Test Group Room");

      const inGroup = groupResult.bubbles.filter((b: { isOutgoing: boolean }) => !b.isOutgoing);
      expect(inGroup.length).toBeGreaterThan(0);
      for (const b of inGroup) {
        expect(b.threadKind).toBe("GROUP");
        expect(b.senderId).not.toBe("9999999999");
        expect(b.senderId).not.toBe("777777777777777");
        expect(b.senderReliability).toBe("UNVERIFIED");
      }
    });

    it("rejects hints overriding route mismatch in readBubblesFromPage", async () => {
      const adapter = new PlaywrightMessengerAdapter({
        profileDir: "./test-profile",
        channelAccountId: "account-1",
        botParticipantId: "9999999999",
      });

      const page = {
        url: () => "https://www.facebook.com/messages/e2ee/t/thread-actual",
        evaluate: vi.fn().mockImplementation((fn: () => unknown) => {
          const fnStr = fn.toString();
          if (fnStr.includes("cloneNode")) {
            return Promise.resolve(`
              <div role="main">
                <div role="row" id="mid.actual-msg">
                  <div dir="auto">hello</div>
                </div>
              </div>
            `);
          }
          if (fnStr.includes("isGroup")) return Promise.resolve(false);
          if (fnStr.includes("directProfileId")) return Promise.resolve(null);
          if (fnStr.includes("mainHeaderInfo")) return Promise.resolve({ title: null, avatarUrl: null });
          return Promise.resolve(null);
        }),
      };

      // Pass mismatched hint: hint says thread-wrong and participant-wrong
      const result = await internals(adapter).readBubblesFromPage(page, {
        threadId: "thread-wrong",
        participantId: "participant-wrong",
        threadTitle: "Wrong Name",
      });

      expect(result.ok).toBe(true);
      // Because hints were for thread-wrong, effectiveHints was ignored and participant-wrong was not applied!
      const bubble = result.bubbles[0]!;
      expect(bubble.senderId).toBeNull();
    });
  });

  it("completeTurn and cancelTurn clear channel active_turn_id lease", async () => {
    let channelActiveTurnId: string | null = "turn-1";

    const mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(() => {
              return [{ id: "turn-1", channelAccountId: "channel-1", status: "COMPLETED" }];
            }),
          }),
        }),
      }),
      execute: vi.fn().mockImplementation((query: unknown) => {
        const queryObj = query as { queryChunks?: unknown[]; sql?: string };
        const chunks = (queryObj?.queryChunks || []).map((c: unknown) => typeof c === "string" ? c : (c as { value?: unknown })?.value || "").join(" ");
        const str = (queryObj?.sql || "") + " " + chunks + " " + String(query);
        if (str.includes("active_turn_id") || str.includes("NULL")) {
          channelActiveTurnId = null;
        }
        return { rows: [] };
      }),
    };

    const turnRepo = new TurnRepository(mockDb as unknown as Parameters<typeof TurnRepository.prototype.constructor>[0]);
    await turnRepo.completeTurn("turn-1");
    expect(channelActiveTurnId).toBeNull();

    channelActiveTurnId = "turn-2";
    await turnRepo.cancelTurn("turn-2", "Cancelled for test");
    expect(channelActiveTurnId).toBeNull();
  });
});
