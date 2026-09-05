import { chromium, type BrowserContext, type Page } from "playwright";
import type { ChannelAdapter, PreSendMarker } from "@messenger/channel";
import { TypingEngine } from "@messenger/channel";
import type {
  InboundMessagePayload,
  ChannelHealthReport,
  ActiveConversationRef,
} from "@messenger/contracts";
import path from "node:path";

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
  private observerPage: Page | null = null;
  private senderPage: Page | null = null;
  private isObserving = false;
  private observeTimer: NodeJS.Timeout | null = null;
  private lastSeenMessageIds = new Set<string>();
  private lastSeenSnippets = new Map<string, string>();
  private isInitializedBaseline = false;
  private typingEngine = new TypingEngine();
  private inboundCallback: ((inbound: InboundMessagePayload) => Promise<void>) | null = null;
  private degradedCallback: ((reason: string) => Promise<void>) | null = null;
  private isDomDegraded = false;
  private degradedReason: string | null = null;

  constructor(options: PlaywrightAdapterOptions) {
    this.channelAccountId = options.channelAccountId || "personal-messenger";
    this.profileDir = path.resolve(options.profileDir);
    this.headless = options.headless ?? true;
  }

  onDegradedDom(callback: (reason: string) => Promise<void>): void {
    this.degradedCallback = callback;
  }

  private async triggerDegradedDom(reason: string): Promise<void> {
    this.isDomDegraded = true;
    this.degradedReason = reason;
    console.error(`[BrowserAdapter] DOM_DEGRADED: ${reason}`);
    if (this.degradedCallback) {
      await this.degradedCallback(reason);
    }
  }

  async init(): Promise<void> {
    if (this.context && this.observerPage && this.senderPage) return;

    console.log(`[BrowserAdapter] Launching Chromium persistent context from ${this.profileDir} (headless=${this.headless})...`);

    // Prepare DISPLAY / NoVNC support
    const envDisplay = process.env.DISPLAY;
    if (envDisplay) {
      console.log(`[BrowserAdapter] Attaching to display: ${envDisplay}`);
    }

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
      permissions: ["notifications"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--window-size=1280,800",
      ],
    });

    const pages = this.context.pages();
    this.observerPage = pages[0] || (await this.context.newPage());
    this.senderPage = await this.context.newPage();

    // Initialize observer page navigation to Messenger inbox
    const observerUrl = this.observerPage.url();
    if (!observerUrl.includes("/messages")) {
      console.log("[BrowserAdapter] Navigating observer page to Messenger inbox...");
      try {
        await this.observerPage.goto("https://www.facebook.com/messages/t/", {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      } catch (err) {
        console.warn("[BrowserAdapter] Observer page initial navigation warning:", err);
      }
    }
  }

  private async dismissOverlays(page: Page | null): Promise<void> {
    if (!page) return;
    try {
      await page.evaluate(() => {
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
    if (!this.observerPage) await this.init();
    if (this.isObserving) return;
    this.isObserving = true;

    console.log("[BrowserAdapter] Inbound polling observer started on dedicated observer page.");

    const poll = async () => {
      if (!this.isObserving || !this.observerPage) return;
      if (this.isDomDegraded) {
        // Suspend polling when DOM is degraded
        return;
      }

      try {
        await this.dismissOverlays(this.observerPage);

        // 1. Sidebar is ONLY a trigger: query sidebar thread rows
        const threadElements = await this.observerPage.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/messages/t/"]'));
          return links.map((a) => {
            const href = a.getAttribute("href") || "";
            const match = href.match(/\/messages\/t\/([^/?#]+)/);
            const threadId = match ? match[1] : "";
            const rawText = (a as HTMLElement).innerText || "";
            const nameMatch = (a as HTMLElement).querySelector('span[dir="auto"]');
            const customerName = nameMatch?.textContent?.trim() || threadId || "Customer";

            // Check if thread has unread indicator
            const isUnread =
              rawText.includes("chưa đọc") ||
              rawText.includes("unread") ||
              a.querySelector('div[aria-label*="chưa đọc"], div[aria-label*="unread"]') !== null ||
              a.querySelector('span[class*="x1lliihq"][style*="font-weight: bold"], span[style*="font-weight: bold"], span[style*="font-weight: 700"]') !== null;

            return {
              href,
              threadId,
              customerName,
              snippet: rawText.replace(/\s+/g, " ").trim(),
              isUnread,
            };
          });
        });

        // First poll captures baseline so startup doesn't ingest historical messages
        if (!this.isInitializedBaseline) {
          for (const t of threadElements) {
            if (t.threadId && t.snippet) {
              this.lastSeenSnippets.set(t.threadId, t.snippet);
            }
          }

          // Also capture baseline message bubbles if thread is open
          const baselineBubbles = await this.readBubblesFromPage(this.observerPage);
          if (baselineBubbles.isDegraded) {
            await this.triggerDegradedDom(baselineBubbles.degradedReason || "Missing stable identity during baseline");
            return;
          }
          for (const b of baselineBubbles.bubbles) {
            this.lastSeenMessageIds.add(b.id);
          }

          this.isInitializedBaseline = true;
          console.log(`[BrowserAdapter] Baseline snapshot captured for ${threadElements.length} threads and ${this.lastSeenMessageIds.size} visible messages.`);
          this.observeTimer = setTimeout(poll, 2500);
          return;
        }

        // 2. Check each thread where sidebar triggered a change
        for (const t of threadElements) {
          if (!t.threadId || !t.snippet) continue;

          // Skip group chats
          const isGroupChat =
            t.customerName.toLowerCase().includes("group") ||
            t.customerName.toLowerCase().includes("club") ||
            t.snippet.includes("left the group") ||
            t.snippet.includes("đã rời khỏi");

          if (isGroupChat) {
            this.lastSeenSnippets.set(t.threadId, t.snippet);
            continue;
          }

          const prevSnippet = this.lastSeenSnippets.get(t.threadId);
          const hasTrigger = t.isUnread || (prevSnippet !== undefined && prevSnippet !== t.snippet);

          if (!hasTrigger) continue;

          // Sidebar triggered: inspect the real message bubbles in observer page
          const currentObserverUrl = this.observerPage.url();
          if (!currentObserverUrl.includes(t.threadId)) {
            // Switch observer page to this thread
            const targetUrl = t.href.startsWith("http")
              ? t.href
              : `https://www.facebook.com/messages/t/${t.threadId}`;
            await this.observerPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
            await this.dismissOverlays(this.observerPage);
          }

          // Read real message bubbles from DOM
          const bubbleResult = await this.readBubblesFromPage(this.observerPage);

          if (bubbleResult.isDegraded) {
            await this.triggerDegradedDom(
              bubbleResult.degradedReason || "DOM bubble missing stable message id - suspending channel"
            );
            return;
          }

          // Process incoming bubbles
          for (const bubble of bubbleResult.bubbles) {
            if (bubble.isOutgoing) {
              this.lastSeenMessageIds.add(bubble.id);
              continue;
            }

            if (this.lastSeenMessageIds.has(bubble.id)) {
              continue; // Dedupe
            }

            // Confirmed new inbound message with stable identity!
            this.lastSeenMessageIds.add(bubble.id);
            this.lastSeenSnippets.set(t.threadId, t.snippet);

            if (this.inboundCallback) {
              const fullThreadRef = t.href.startsWith("http")
                ? t.href
                : `https://www.facebook.com/messages/t/${t.threadId}`;

              await this.inboundCallback({
                channelAccountId: this.channelAccountId,
                externalThreadId: t.threadId,
                externalThreadRef: fullThreadRef,
                externalCustomerId: t.threadId,
                customerName: t.customerName,
                externalMessageId: bubble.id,
                text: bubble.text,
                timestamp: new Date(),
              });
            }
          }

          this.lastSeenSnippets.set(t.threadId, t.snippet);
        }
      } catch (err) {
        console.warn("[BrowserAdapter] Error during observer poll:", err);
      } finally {
        if (this.isObserving && !this.isDomDegraded) {
          this.observeTimer = setTimeout(poll, 2500);
        }
      }
    };

    this.observeTimer = setTimeout(poll, 1000);
  }

  /**
   * Reads message bubbles from a page, extracting stable identity.
   * If any message bubble has text but no stable ID attribute, returns isDegraded = true.
   */
  private async readBubblesFromPage(page: Page): Promise<{
    bubbles: Array<{ id: string; text: string; isOutgoing: boolean }>;
    isDegraded: boolean;
    degradedReason?: string;
  }> {
    try {
      return await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('div[role="row"], div[data-scope="messages_table"], div[data-testid="mw_message_row"]')
        );

        const bubbles: Array<{ id: string; text: string; isOutgoing: boolean }> = [];
        let isDegraded = false;
        let degradedReason: string | undefined;

        for (const row of rows) {
          // Extract message text
          const textEl =
            row.querySelector('div[dir="auto"], span[dir="auto"], div[data-scope="message_bubble"]') ||
            row.querySelector('span');

          const rawText = textEl?.textContent?.trim() || "";
          if (!rawText) continue;

          // Stable ID extraction (mid.$..., data-message-id, data-mid, id, data-id)
          const midMatch = row.querySelector('[id^="mid."]')?.getAttribute("id");
          const rowId = row.getAttribute("id");
          const idAttr =
            midMatch ||
            (rowId && rowId.startsWith("mid.") ? rowId : null) ||
            row.getAttribute("data-message-id") ||
            row.querySelector('[data-message-id]')?.getAttribute("data-message-id") ||
            row.getAttribute("data-mid") ||
            row.querySelector('[data-mid]')?.getAttribute("data-mid") ||
            row.getAttribute("data-id") ||
            (rowId && !rowId.startsWith(":") && !rowId.startsWith("js_") ? rowId : null);

          if (!idAttr) {
            isDegraded = true;
            degradedReason = `Message row with text "${rawText.slice(0, 30)}" lacks stable mid identifier`;
            continue;
          }

          // Direction extraction
          const ariaLabel = (row.getAttribute("aria-label") || "").toLowerCase();
          const isOutgoing =
            ariaLabel.includes("bạn đã gửi") ||
            ariaLabel.includes("bạn:") ||
            ariaLabel.includes("you sent") ||
            ariaLabel.includes("you:") ||
            row.querySelector('[data-testid="outgoing_message"]') !== null;

          bubbles.push({
            id: idAttr,
            text: rawText,
            isOutgoing,
          });
        }

        return { bubbles, isDegraded, degradedReason };
      });
    } catch (_err) {
      return {
        bubbles: [],
        isDegraded: false,
      };
    }
  }

  async stopObserving(): Promise<void> {
    this.isObserving = false;
    if (this.observeTimer) {
      clearTimeout(this.observeTimer);
      this.observeTimer = null;
    }
    this.inboundCallback = null;
  }

  // --- Sender Page Operations ---

  async openConversation(threadRef: string): Promise<boolean> {
    if (!this.senderPage) await this.init();
    if (!this.senderPage) return false;

    const threadMatch = threadRef.match(/\/messages\/t\/([^/?#]+)/);
    const threadId = threadMatch && threadMatch[1] ? threadMatch[1] : threadRef;

    const currentUrl = this.senderPage.url();
    if (!currentUrl.includes(threadId)) {
      const targetUrl = threadRef.startsWith("http")
        ? threadRef
        : `https://www.facebook.com/messages/t/${threadId}`;

      console.log(`[BrowserAdapter] Sender opening conversation: ${targetUrl}`);
      try {
        await this.senderPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (err) {
        console.warn(`[BrowserAdapter] Sender navigation failed for ${targetUrl}:`, err);
        return false;
      }
    }

    await this.dismissOverlays(this.senderPage);

    // Wait for composer textbox to be visible
    try {
      await this.senderPage.waitForSelector('div[role="textbox"][contenteditable="true"]', {
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
    if (!this.senderPage) return null;
    const url = this.senderPage.url();
    const match = url.match(/\/messages\/t\/([^/?#]+)/);
    if (!match || !match[1]) return null;

    const threadId = match[1];
    return {
      externalThreadId: threadId,
      externalThreadRef: url,
      externalCustomerId: threadId,
      customerName: null,
    };
  }

  /**
   * Captures pre-send marker on sender page before typing/sending.
   */
  async capturePreSendMarker(threadRef?: string): Promise<PreSendMarker> {
    const ref = threadRef || this.senderPage?.url() || "";
    if (!this.senderPage) {
      return {
        threadRef: ref,
        knownMessageIds: [],
        lastMessageId: null,
        messageCount: 0,
        capturedAt: new Date(),
      };
    }

    const { bubbles } = await this.readBubblesFromPage(this.senderPage);
    const allIds = bubbles.map((b) => b.id);
    const outgoingIds = bubbles.filter((b) => b.isOutgoing).map((b) => b.id);
    const lastId = outgoingIds.length > 0 ? outgoingIds[outgoingIds.length - 1]! : null;

    return {
      threadRef: ref,
      knownMessageIds: allIds,
      lastMessageId: lastId,
      messageCount: bubbles.length,
      capturedAt: new Date(),
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
    if (!this.senderPage) return { completed: false, aborted: true };

    const composer = this.senderPage.locator('div[role="textbox"][contenteditable="true"]').first();
    try {
      await composer.click({ timeout: 5000 });
    } catch (err) {
      console.warn("[BrowserAdapter] Failed to click composer textbox:", err);
      return { completed: false };
    }

    const typingEngine =
      options?.targetWpmMin || options?.targetWpmMax
        ? new TypingEngine({ targetWpmMin: options.targetWpmMin, targetWpmMax: options.targetWpmMax })
        : this.typingEngine;

    const result = await typingEngine.typeWithPacing(
      text,
      async (char) => {
        if (this.senderPage) {
          await this.senderPage.keyboard.type(char);
        }
      },
      options?.signal
    );

    if (result.aborted) {
      await this.clearComposer();
    }

    return result;
  }

  async clearComposer(): Promise<void> {
    if (!this.senderPage) return;
    try {
      const composer = this.senderPage.locator('div[role="textbox"][contenteditable="true"]').first();
      await composer.focus();
      await this.senderPage.keyboard.press("ControlOrMeta+A");
      await this.senderPage.keyboard.press("Backspace");
    } catch (err) {
      console.warn("[BrowserAdapter] Error clearing composer:", err);
    }
  }

  async sendDraft(_actionId: string): Promise<{ sent: boolean }> {
    if (!this.senderPage) return { sent: false };
    try {
      await this.senderPage.keyboard.press("Enter");
      return { sent: true };
    } catch (err) {
      console.error("[BrowserAdapter] Failed to press Enter to send draft:", err);
      return { sent: false };
    }
  }

  async verifySent(
    expectedText: string,
    _expectedHash: string,
    marker?: PreSendMarker | string,
    timeoutMs = 10000
  ): Promise<{ verified: boolean; messageRef?: string }> {
    if (!this.senderPage) return { verified: false };

    const startTime = Date.now();
    const normalizedExpected = expectedText.trim();
    const knownIds =
      marker && typeof marker === "object" && marker.knownMessageIds
        ? new Set(marker.knownMessageIds)
        : new Set<string>();

    while (Date.now() - startTime < timeoutMs) {
      const { bubbles } = await this.readBubblesFromPage(this.senderPage);

      // Verify that an outgoing bubble appeared strictly AFTER marker matching expectedText
      for (const b of bubbles) {
        if (!b.isOutgoing) continue;
        if (knownIds.has(b.id)) continue; // Pre-existing historical bubble

        const bubbleText = b.text.trim();
        if (bubbleText === normalizedExpected || bubbleText.includes(normalizedExpected)) {
          // Confirmed with real Facebook message ID!
          return { verified: true, messageRef: b.id };
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return { verified: false };
  }

  async health(): Promise<ChannelHealthReport> {
    const isContextAlive = Boolean(this.context && this.observerPage && this.senderPage);
    const healthy = isContextAlive && !this.isDomDegraded;

    return {
      healthy,
      status: this.isDomDegraded ? "DEGRADED" : healthy ? "RUNNING" : "SUSPENDED",
      domOk: !this.isDomDegraded,
      sessionActive: isContextAlive,
      checkpointDetected: false,
      rateLimitDetected: false,
      errorMessage: this.degradedReason,
      timestamp: new Date(),
    };
  }

  async close(): Promise<void> {
    await this.stopObserving();
    try {
      if (this.observerPage) await this.observerPage.close();
      if (this.senderPage) await this.senderPage.close();
      if (this.context) await this.context.close();
    } catch {
      // Ignore errors on closing
    } finally {
      this.observerPage = null;
      this.senderPage = null;
      this.context = null;
    }
  }
}
