import { chromium, type BrowserContext, type Page } from "playwright";
import type { ChannelAdapter } from "@messenger/channel";
import { TypingEngine } from "@messenger/channel";
import type {
  InboundMessagePayload,
  ChannelHealthReport,
  ActiveConversationRef,
} from "@messenger/contracts";
import path from "node:path";
import { createHash } from "node:crypto";

export interface PlaywrightAdapterOptions {
  profileDir: string;
  headless?: boolean;
  channelAccountId?: string;
}

export class PlaywrightMessengerAdapter implements ChannelAdapter {
  readonly channelAccountId: string;
  private profileDir: string;
  private headless: boolean;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isObserving = false;
  private observeTimer: NodeJS.Timeout | null = null;
  private lastSeenSnippets = new Map<string, string>();
  private isInitializedBaseline = false;
  private pollCount = 0;
  public isSendingOrTyping = false;
  private typingEngine = new TypingEngine();
  private inboundCallback: ((inbound: InboundMessagePayload) => Promise<void>) | null = null;
  constructor(options: PlaywrightAdapterOptions) {
    this.channelAccountId = options.channelAccountId || "personal-messenger";
    this.profileDir = path.resolve(options.profileDir);
    this.headless = options.headless ?? true;
  }
  async init(): Promise<void> {
    if (this.context && this.page) return;

    console.log(`[BrowserAdapter] Launching Chromium persistent context from ${this.profileDir} (headless=${this.headless})...`);

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
      permissions: ["notifications"],
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
        "--disable-ipc-flooding-protection",
        "--disable-session-crashed-bubble",
        "--disable-infobars",
        "--no-first-run",
      ],
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Keep page active and prevent Facebook Web from sleeping or throttling real-time WebSockets
      Object.defineProperty(document, "hidden", { get: () => false });
      Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    });

    const pages = this.context.pages();
    this.page = pages[0] || (await this.context.newPage());

    // Check if we have cookies already, otherwise navigate to facebook.com
    const currentUrl = this.page.url();
    if (!currentUrl.includes("/messages")) {
      console.log("[BrowserAdapter] Navigating to Messenger inbox: https://www.facebook.com/messages/t/");
      await this.page.goto("https://www.facebook.com/messages/t/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }
  }
  private async dismissOverlays(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.evaluate(() => {
        const dialogButtons = Array.from(
          document.querySelectorAll('div[role="dialog"] button, div[role="dialog"] div[role="button"]')
        );
        for (const btn of dialogButtons) {
          const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
          if (
            text === "để sau" ||
            text === "not now" ||
            text === "bỏ qua" ||
            text === "skip" ||
            text === "đóng" ||
            text === "close" ||
            text === "lúc khác"
          ) {
            (btn as HTMLElement).click();
          }
        }
      });
    } catch {
      // Ignore evaluation errors during page transitions
    }
  }

  async observeInbound(callback: (inbound: InboundMessagePayload) => Promise<void>): Promise<void> {
    this.inboundCallback = callback;
    if (!this.page) await this.init();
    if (this.isObserving) return;
    this.isObserving = true;

    console.log("[BrowserAdapter] Inbound polling observer started (interval: 2500ms).");

    const poll = async () => {
      if (!this.isObserving || !this.page) return;
      if (this.isSendingOrTyping) {
        // Skip polling while actively typing/sending to avoid self-abort race conditions
        this.observeTimer = setTimeout(poll, 2000);
        return;
      }

      try {
        const currentUrl = this.page.url();
        if (!currentUrl.includes("/messages")) {
          await this.page.goto("https://www.facebook.com/messages/t/", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
        }

        // Periodic keep-alive pulse to ensure Facebook real-time Comet/WebSocket stays awake
        this.pollCount++;
        if (this.pollCount % 10 === 0) {
          await this.page.evaluate(() => {
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await this.dismissOverlays();
        }

        // Scan conversation thread items in sidebar
        const threads = await this.page.evaluate(() => {
          const links = Array.from(
            document.querySelectorAll('a[href*="/messages/t/"]')
          );

          return links.slice(0, 15).map((a) => {
            const href = (a as HTMLAnchorElement).href;
            const match = href.match(/\/messages\/t\/([^/?#]+)/);
            const threadId = match && match[1] ? match[1] : "";
            const textContent = (a as HTMLElement).innerText || "";
            const lines = textContent.split("\n").map((l: string) => l.trim()).filter(Boolean);

            // Filter out presence text like "Active now", "Đang hoạt động", timestamps
            const cleanLines = lines.filter(
              (l: string) =>
                !/^(active now|đang hoạt động|\d+[mhdw])$/i.test(l) &&
                !l.startsWith("Unread message:")
            );

            const customerName = cleanLines[0] || "Khách hàng";
            const rawSnippet = cleanLines.slice(1).join(" ") || lines.slice(1).join(" ");

            return {
              href,
              threadId,
              customerName,
              snippet: rawSnippet,
            };
          });
        });

        // Initialize baseline state on first poll so startup doesn't fire stale historical inbounds
        if (!this.isInitializedBaseline) {
          for (const t of threads) {
            if (t.threadId && t.snippet) {
              this.lastSeenSnippets.set(t.threadId, t.snippet);
            }
          }
          this.isInitializedBaseline = true;
          console.log(`[BrowserAdapter] Baseline snapshot captured for ${threads.length} threads. Listening for new inbounds...`);
          await this.dismissOverlays();
          this.observeTimer = setTimeout(poll, 2500);
          return;
        }

        for (const t of threads) {
          if (!t.threadId || !t.snippet) continue;

          // Skip group chats to prevent bot chatting into friend groups
          const isGroupChat =
            t.customerName.toLowerCase().includes("group") ||
            t.customerName.toLowerCase().includes("club") ||
            t.snippet.includes("left the group") ||
            t.snippet.includes("đã rời khỏi") ||
            t.snippet.includes("đã tham gia") ||
            t.snippet.includes("đã thêm");

          if (isGroupChat) {
            this.lastSeenSnippets.set(t.threadId, t.snippet);
            continue;
          }

          // Check if snippet is outgoing from bot/owner or is an in-progress draft
          const isOutgoingSnippet =
            t.snippet.includes("Bạn:") ||
            t.snippet.includes("You:") ||
            t.snippet.includes("Bạn đã gửi") ||
            t.snippet.includes("You sent") ||
            t.snippet.includes("Draft:") ||
            t.snippet.includes("Draft ") ||
            t.snippet.includes("Bản nháp:") ||
            t.snippet.includes("Bản nháp ");

          if (isOutgoingSnippet) {
            this.lastSeenSnippets.set(t.threadId, t.snippet);
            continue;
          }

          const previousSnippet = this.lastSeenSnippets.get(t.threadId);
          if (previousSnippet !== t.snippet) {
            this.lastSeenSnippets.set(t.threadId, t.snippet);

            let messageText = t.snippet;
            // Remove name prefix if present
            if (messageText.startsWith(t.customerName)) {
              messageText = messageText.slice(t.customerName.length).trim();
            }
            // Remove unread message prefix if present
            if (messageText.startsWith("Unread message:")) {
              messageText = messageText.slice(15).trim();
            }
            const splitDot = messageText.split("·");
            if (splitDot.length > 1 && splitDot[0]) {
              messageText = splitDot[0].trim();
            }

            if (messageText.length > 0 && this.inboundCallback) {
              const msgId = createHash("sha256")
                .update(`${t.threadId}:${messageText}:${Date.now()}`)
                .digest("hex");

              console.log(
                `[BrowserAdapter] Inbound message detected in thread ${t.threadId} (${t.customerName}): "${messageText.slice(0, 30)}..."`
              );

              await this.inboundCallback({
                channelAccountId: this.channelAccountId,
                externalThreadId: t.threadId,
                externalThreadRef: t.href,
                externalCustomerId: `fb-${t.threadId}`,
                customerName: t.customerName,
                externalMessageId: msgId,
                text: messageText,
                timestamp: new Date(),
              });
            }
          }
        }
      } catch (err) {
        // Transient evaluation or navigation error
      } finally {
        if (this.isObserving && !this.isSendingOrTyping) {
          this.observeTimer = setTimeout(poll, 2500);
        }
      }
    };

    this.observeTimer = setTimeout(poll, 1500);
  }

  async stopObserving(): Promise<void> {
    this.isObserving = false;
    if (this.observeTimer) {
      clearTimeout(this.observeTimer);
      this.observeTimer = null;
    }
    this.inboundCallback = null;
  }

  async openConversation(threadRef: string): Promise<boolean> {
    if (!this.page) await this.init();
    if (!this.page) return false;

    const threadMatch = threadRef.match(/\/messages\/t\/([^/?#]+)/);
    const threadId = threadMatch && threadMatch[1] ? threadMatch[1] : threadRef;

    console.log(`[BrowserAdapter] Opening conversation: ${threadRef} (threadId: ${threadId})`);
    const currentUrl = this.page.url();

    if (!currentUrl.includes(threadId)) {
      // Try fast client-side navigation by clicking the sidebar link if already present in DOM
      let clicked = false;
      try {
        const link = await this.page.$(`a[href*="/messages/t/${threadId}"]`);
        if (link) {
          await link.click();
          clicked = true;
          console.log(`[BrowserAdapter] Navigated via sidebar click: ${threadId}`);
        }
      } catch {
        clicked = false;
      }

      if (!clicked) {
        const targetUrl = threadRef.startsWith("http")
          ? threadRef
          : `https://www.facebook.com/messages/t/${threadId}`;
        await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
    }

    await this.dismissOverlays();

    // Wait for composer textbox to be visible
    try {
      await this.page.waitForSelector('div[role="textbox"][contenteditable="true"]', {
        state: "visible",
        timeout: 15000,
      });
      return true;
    } catch {
      console.warn("[BrowserAdapter] Composer textbox not found in opened thread");
      return false;
    }
  }

  async getOpenConversationRef(): Promise<ActiveConversationRef | null> {
    if (!this.page) return null;
    const url = this.page.url();
    const match = url.match(/\/messages\/t\/([^/?#]+)/);
    if (!match || !match[1]) return null;

    const threadId = match[1];
    return {
      externalThreadId: threadId,
      externalThreadRef: url,
      externalCustomerId: `fb-${threadId}`,
      customerName: null,
    };
  }

  async typeDraft(
    text: string,
    options?: {
      targetWpmMin?: number;
      targetWpmMax?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ completed: boolean; aborted?: boolean }> {
    this.isSendingOrTyping = true;
    if (!this.page) await this.init();
    if (!this.page) throw new Error("Browser page not ready");

    const composer = this.page.locator('div[role="textbox"][contenteditable="true"]').first();
    await composer.focus();

    // Clear any existing composer text first
    await this.clearComposer();
    const result = await this.typingEngine.typeWithPacing(
      text,
      async (char) => {
        if (this.page) {
          await this.page.keyboard.type(char);
        }
      },
      options?.signal
    );

    if (result.aborted) {
      await this.clearComposer();
      this.isSendingOrTyping = false;
    }

    return result;
  }

  async clearComposer(): Promise<void> {
    if (!this.page) return;
    const composer = this.page.locator('div[role="textbox"][contenteditable="true"]').first();
    try {
      await composer.focus();
      // Select all and delete
      await this.page.keyboard.press("ControlOrMeta+A");
      await this.page.keyboard.press("Backspace");
    } catch (err) {
      console.warn("[BrowserAdapter] Error clearing composer:", err);
    }
  }

  async sendDraft(_actionId: string): Promise<{ sent: boolean }> {
    if (!this.page) return { sent: false };
    try {
      await this.page.keyboard.press("Enter");
      return { sent: true };
    } catch (err) {
      console.error("[BrowserAdapter] Failed to press Enter to send draft:", err);
      return { sent: false };
    } finally {
      this.isSendingOrTyping = false;
    }
  }

  async verifySent(
    expectedText: string,
    _expectedHash: string,
    timeoutMs = 10000
  ): Promise<{ verified: boolean; messageRef?: string }> {
    this.isSendingOrTyping = false;
    if (!this.page) return { verified: false };

    const startTime = Date.now();
    const normalizedExpected = expectedText.trim();

    while (Date.now() - startTime < timeoutMs) {
      const bubbles = await this.page.locator('div[role="row"], div[data-scope="messages_table"]').allInnerTexts();
      for (const b of bubbles) {
        if (b.includes(normalizedExpected)) {
          const generatedRef = `msg-${createHash("sha256").update(normalizedExpected + Date.now()).digest("hex").slice(0, 16)}`;
          return { verified: true, messageRef: generatedRef };
        }
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 500);
      await promise;
    }

    return { verified: false };
  }

  async health(): Promise<ChannelHealthReport> {
    if (!this.page) {
      return {
        healthy: false,
        status: "SUSPENDED",
        domOk: false,
        sessionActive: false,
        checkpointDetected: false,
        rateLimitDetected: false,
        errorMessage: "Browser page not initialized",
        timestamp: new Date(),
      };
    }

    const currentUrl = this.page.url();
    const isLoginWall = currentUrl.includes("/login") || currentUrl.includes("checkpoint");
    const isCheckpoint = currentUrl.includes("checkpoint") || currentUrl.includes("two_factor");

    let domOk = false;
    try {
      const composerCount = await this.page.locator('div[role="textbox"][contenteditable="true"]').count();
      domOk = composerCount > 0 || currentUrl.includes("/messages");
    } catch {
      domOk = false;
    }

    const healthy = !isLoginWall && !isCheckpoint && domOk;
    return {
      healthy,
      status: healthy ? "RUNNING" : "SUSPENDED",
      domOk,
      sessionActive: !isLoginWall,
      checkpointDetected: isCheckpoint,
      rateLimitDetected: false,
      errorMessage: healthy ? null : isCheckpoint ? "Account checkpoint detected" : isLoginWall ? "Session expired / login wall" : "DOM locator failure",
      timestamp: new Date(),
    };
  }

  isAlive(): boolean {
    return Boolean(this.context && this.page && !this.page.isClosed() && this.isObserving);
  }

  async close(): Promise<void> {
    this.isObserving = false;
    if (this.observeTimer) {
      clearTimeout(this.observeTimer);
      this.observeTimer = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }
}
