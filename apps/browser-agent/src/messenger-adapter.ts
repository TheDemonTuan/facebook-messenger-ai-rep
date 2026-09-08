import { chromium, type BrowserContext, type Page } from "playwright";
import type { ChannelAdapter, PreSendMarker, BubbleParseResult, ParsedSidebarThread } from "@messenger/channel";
import {
  TypingEngine,
  parseMessengerBubblesFromHtml,
  parseSidebarThreadsFromHtml,
  isSnippetOutgoing,
} from "@messenger/channel";
import type {
  InboundMessagePayload,
  ChannelHealthReport,
  ActiveConversationRef,
} from "@messenger/contracts";
import {
  isValidTimeZone,
  resolveBusinessTimeZone,
  DEFAULT_BUSINESS_TIMEZONE,
} from "@messenger/contracts";
import path from "node:path";
import { createHash } from "node:crypto";

export interface PlaywrightAdapterOptions {
  profileDir: string;
  headless?: boolean;
  channelAccountId?: string;
  timeZone?: string;
  botParticipantId?: string;
  botProfileUrl?: string;
}

export type BrowserSessionIssueKind = "LOGIN_REQUIRED" | "CHECKPOINT" | "INBOX_UNAVAILABLE" | "RATE_LIMITED";

export interface BrowserSessionIssue {
  kind: BrowserSessionIssueKind;
  message: string;
}

const MESSENGER_INBOX_URL = "https://www.facebook.com/messages/t/";
const MESSENGER_THREAD_PATH = /\/messages\/(?:e2ee\/)?t\/([^/?#]+)/i;
const OBSERVER_POLL_INTERVAL_MS = 4500;
const OBSERVER_STALE_AFTER_MS = 30000;

export function getObserverPollDelay(): number {
  return OBSERVER_POLL_INTERVAL_MS + Math.floor(Math.random() * 1500);
}

export function extractMessengerThreadId(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  return value.match(MESSENGER_THREAD_PATH)?.[1] ?? null;
}

export interface SidebarThreadSnapshot {
  snippet: string;
  isUnread: boolean;
}

export function shouldInspectMessengerThread(
  currentThreadId: string | null,
  thread: Pick<ParsedSidebarThread, "threadId" | "snippet" | "isUnread" | "isOutgoing">,
  previous: SidebarThreadSnapshot | undefined
): boolean {
  // 1. Active thread is always polled separately via its open chat DOM
  if (currentThreadId && thread.threadId === currentThreadId) {
    return false;
  }

  // 2. Outgoing snippet never triggers thread inspection
  if (thread.isOutgoing || isSnippetOutgoing(thread.snippet)) {
    return false;
  }

  // 3. Thread appearing after baseline triggers once
  if (previous === undefined) {
    return true;
  }

  // 4. Snippet change triggers inspection
  if (thread.snippet !== previous.snippet) {
    return true;
  }

  // 5. Unread transition false -> true triggers even if snippet text is identical
  if (!previous.isUnread && thread.isUnread) {
    return true;
  }

  // 6. Otherwise unchanged state does not trigger
  return false;
}

export class PlaywrightMessengerAdapter implements ChannelAdapter {
  readonly channelAccountId: string;
  timeZone: string;
  private activeContextTimeZone: string;
  private targetTimeZone: string;
  private reinitPromise: Promise<void> | null = null;
  readonly botParticipantId?: string;
  readonly botProfileUrl?: string;
  private profileDir: string;
  private headless: boolean;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private observerPage: Page | null = null;
  private senderPage: Page | null = null;
  private sendLock = false;
  private observerBusy = false;
  private isObserving = false;
  private observeTimer: NodeJS.Timeout | null = null;
  private lastSeenMessageIds = new Set<string>();
  private confirmedOutboundMessageIds = new Set<string>();
  private lastSeenActiveSignatures = new Map<string, number>();
  private lastSeenSidebarThreads = new Map<string, SidebarThreadSnapshot>();
  private isInitializedBaseline = false;
  private typingEngine = new TypingEngine();
  private inboundCallback: ((inbound: InboundMessagePayload) => Promise<void>) | null = null;
  private degradedCallback: ((reason: string) => Promise<void>) | null = null;
  private sessionIssueCallback: ((issue: BrowserSessionIssue) => Promise<void>) | null = null;
  private sessionRecoveredCallback: (() => Promise<void>) | null = null;
  private isDomDegraded = false;
  private degradedReason: string | null = null;
  private sessionIssue: BrowserSessionIssue | null = null;
  private hasReportedHealthySession = false;
  private lastSuccessfulPollAt: Date | null = null;
  private consecutiveEmptyInboxPolls = 0;
  private recentBotSentTexts: Array<{ text: string; sentAt: number }> = [];
  private seenOutgoingBubbleIds = new Set<string>();
  private threadBaselinesEstablished = new Set<string>();
  private isDurableBotOutboundChecker: ((info: { threadId: string; bubbleId?: string; text?: string }) => Promise<boolean>) | null = null;
  private externalOutboundCallback: ((outbound: {
    threadId: string;
    text: string;
    timestamp: number;
    hasMedia?: boolean;
    parts?: unknown[];
    bubbleId?: string;
  }) => Promise<void>) | null = null;

  constructor(options: PlaywrightAdapterOptions) {
    this.channelAccountId = options.channelAccountId || "personal-messenger";
    this.profileDir = path.resolve(options.profileDir);
    this.headless = options.headless ?? true;
    const resolved = options.timeZone ? resolveBusinessTimeZone(options.timeZone) : DEFAULT_BUSINESS_TIMEZONE;
    this.timeZone = resolved;
    this.targetTimeZone = resolved;
    this.activeContextTimeZone = resolved;
    this.botParticipantId = options.botParticipantId;
    this.botProfileUrl = options.botProfileUrl;
  }

  /**
   * Sets desired business timezone.
   * Returns true if context recreation is required because the BrowserContext is
   * currently running with an immutable timezoneId that differs from the new timezone.
   */
  setTimeZone(timeZone: string): boolean {
    if (!isValidTimeZone(timeZone)) {
      return false;
    }
    const normalized = resolveBusinessTimeZone(timeZone);
    this.targetTimeZone = normalized;
    this.timeZone = normalized;

    // If context is running and active timezone differs from target, recreation is required
    if (this.context && this.activeContextTimeZone !== normalized) {
      return true;
    }

    // If context not initialized yet, target becomes active when initialized without recreation
    if (!this.context) {
      this.activeContextTimeZone = normalized;
    }

    return false;
  }

  /**
   * Gets the active browser context timezone currently emulated by Chromium.
   */
  getActiveContextTimeZone(): string {
    return this.activeContextTimeZone;
  }

  /**
   * Controlled browser/context reinitialization.
   * Safely closes existing pages and context, flushing session state to disk,
   * then relaunches persistent context with timezoneId matching target timezone.
   */
  async reinitializeContext(targetTimeZone?: string): Promise<void> {
    if (targetTimeZone) {
      this.setTimeZone(targetTimeZone);
    }
    if (this.reinitPromise) {
      return this.reinitPromise;
    }
    this.reinitPromise = this.performReinitializeContext();
    try {
      await this.reinitPromise;
    } finally {
      this.reinitPromise = null;
    }
  }

  private async performReinitializeContext(): Promise<void> {
    const wasObserving = this.isObserving;
    const savedCallback = this.inboundCallback;
    this.isInitializedBaseline = false;
    this.lastSeenMessageIds.clear();
    this.lastSeenSidebarThreads.clear();
    this.consecutiveEmptyInboxPolls = 0;
    this.lastSuccessfulPollAt = null;
    this.hasReportedHealthySession = false;

    console.log(`[BrowserAdapter] Controlled context reinitialization starting: aligning timezone to ${this.targetTimeZone}...`);

    // 1. Pause polling observer cleanly
    if (this.observeTimer) {
      clearTimeout(this.observeTimer);
      this.observeTimer = null;
    }
    this.isObserving = false;

    // 2. Safely close sender and observer pages first
    if (this.senderPage) {
      try {
        await this.senderPage.close();
      } catch (err) {
        console.warn("[BrowserAdapter] Warning closing senderPage during context reinitialization:", err);
      } finally {
        this.senderPage = null;
      }
    }

    if (this.observerPage) {
      try {
        await this.observerPage.close();
      } catch (err) {
        console.warn("[BrowserAdapter] Warning closing observerPage during context reinitialization:", err);
      } finally {
        this.observerPage = null;
      }
    }
    this.page = null;

    // 3. Safely close persistent context (Playwright flushes session cookies/storage to profileDir)
    if (this.context) {
      try {
        await this.context.close();
      } catch (err) {
        console.warn("[BrowserAdapter] Warning closing context during reinitialization:", err);
      } finally {
        this.context = null;
      }
    }

    // 4. Update activeContextTimeZone to match target timezone
    this.activeContextTimeZone = this.targetTimeZone;
    this.timeZone = this.targetTimeZone;

    // 5. Reinitialize browser context with the new timezoneId
    await this.init();

    // 6. Resume observation if it was active before reinitialization
    if (wasObserving && savedCallback) {
      await this.observeInbound(savedCallback);
    }
    console.log(`[BrowserAdapter] Controlled context reinitialization complete (activeContextTimeZone=${this.activeContextTimeZone}).`);
  }

  onDegradedDom(callback: (reason: string) => Promise<void>): void {
    this.degradedCallback = callback;
  }

  onSessionIssue(callback: (issue: BrowserSessionIssue) => Promise<void>): void {
    this.sessionIssueCallback = callback;
  }

  onSessionRecovered(callback: () => Promise<void>): void {
    this.sessionRecoveredCallback = callback;
  }

  onExternalOutbound(
    callback: (outbound: {
      threadId: string;
      text: string;
      timestamp: number;
      hasMedia?: boolean;
      parts?: unknown[];
      bubbleId?: string;
    }) => Promise<void>
  ): void {
    this.externalOutboundCallback = callback;
  }

  setDurableBotOutboundChecker(
    checker: (info: { threadId: string; bubbleId?: string; text?: string }) => Promise<boolean>
  ): void {
    this.isDurableBotOutboundChecker = checker;
  }

  rememberBotSentText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.recentBotSentTexts.push({ text: trimmed, sentAt: Date.now() });
    if (this.recentBotSentTexts.length > 50) {
      this.recentBotSentTexts.shift();
    }
  }

  async checkLastBubbleIsExternalOutbound(threadId: string): Promise<boolean> {
    if (!this.senderPage) return false;
    try {
      const bubbleResult = await this.readBubblesFromPage(this.senderPage, { threadId });
      if (bubbleResult.bubbles.length === 0) return false;
      const lastBubble = bubbleResult.bubbles[bubbleResult.bubbles.length - 1];
      if (!lastBubble || !lastBubble.isOutgoing) return false;

      const outText = lastBubble.text.trim();
      const hasMedia = Boolean(lastBubble.hasMedia || (lastBubble.parts && lastBubble.parts.length > 0));
      if (!outText && !hasMedia) return false;

      if (this.isDurableBotOutboundChecker) {
        const isBot = await this.isDurableBotOutboundChecker({
          threadId,
          bubbleId: lastBubble.id,
          text: outText,
        });
        if (isBot) return false;
      }

      const isBotSent = this.recentBotSentTexts.some((botMsg) => {
        return (
          botMsg.text === outText ||
          (outText.length > 5 && (botMsg.text.includes(outText) || outText.includes(botMsg.text)))
        );
      });
      return !isBotSent;
    } catch {
      return false;
    }
  }

  private async setSessionIssue(issue: BrowserSessionIssue): Promise<void> {
    if (this.sessionIssue?.kind === issue.kind && this.sessionIssue.message === issue.message) return;
    this.sessionIssue = issue;
    this.hasReportedHealthySession = false;
    console.error(`[BrowserAdapter] ${issue.kind}: ${issue.message}`);
    await this.sessionIssueCallback?.(issue);
  }

  private async clearSessionIssue(): Promise<void> {
    if (!this.sessionIssue && this.hasReportedHealthySession) return;
    this.sessionIssue = null;
    this.hasReportedHealthySession = true;
    await this.sessionRecoveredCallback?.();
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
    if (this.context && this.page && !this.page.isClosed()) return;

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
      timezoneId: this.activeContextTimeZone,
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

    // Neutralize popups and target="_blank" before any script or page executes
    await this.context.addInitScript(() => {
      try {
        window.open = () => null;
      } catch {
        // Browser pages can lock this property.
      }
      try {
        document.addEventListener(
          "click",
          (e) => {
            const target = (e.target as HTMLElement | null)?.closest?.("a");
            if (target && target.target === "_blank") {
              target.removeAttribute("target");
            }
          },
          true
        );
      } catch {
        // Ignore document access failures during early navigation.
      }
    });

    const pages = this.context.pages();
    this.page =
      pages.find((page) => page.url().includes("facebook.com/messages")) ||
      pages[0] ||
      (await this.context.newPage());

    // Strictly enforce single tab: close any extra tabs immediately
    for (const page of pages) {
      if (page !== this.page) {
        await page.close().catch(() => undefined);
      }
    }

    // Auto-close any popup or extra tab opened by Facebook/links
    this.context.on("page", async (extraPage) => {
      if (extraPage !== this.page) {
        console.log(`[BrowserAdapter] Intercepted and closing unexpected extra tab: ${extraPage.url()}`);
        await extraPage.close().catch(() => undefined);
      }
    });

    await this.ensurePage();
    await this.page.bringToFront().catch(() => undefined);
  }

  async acquireSendLock(): Promise<void> {
    this.sendLock = true;
  }

  releaseSendLock(): void {
    this.sendLock = false;
  }

  isSendLocked(): boolean {
    return this.sendLock;
  }

  private async ensureSenderPage(): Promise<Page> {
    return this.ensurePage();
  }

  private async ensureObserverPage(): Promise<Page> {
    return this.ensurePage();
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) {
      await this.init();
    }
    if (!this.context) throw new Error("Browser context is not initialized");

    if (!this.page || this.page.isClosed()) {
      const activePages = this.context.pages().filter((p) => !p.isClosed());
      this.page = activePages[0] || (await this.context.newPage());
      this.observerPage = this.page;
      this.senderPage = this.page;
      this.isInitializedBaseline = false;
      this.consecutiveEmptyInboxPolls = 0;
    }

    this.observerPage = this.page;
    this.senderPage = this.page;

    // Strictly enforce single tab: close any stray pages
    const allPages = this.context.pages();
    for (const p of allPages) {
      if (p !== this.page && !p.isClosed()) {
        await p.close().catch(() => undefined);
      }
    }

    const url = this.page.url();
    if (!url.includes("facebook.com/messages") && !/facebook\.com\/(?:login|recover)|checkpoint/i.test(url)) {
      console.log("[BrowserAdapter] Restoring single tab to Messenger inbox...");
      await this.page.goto(MESSENGER_INBOX_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }

    return this.page;
  }

  private async inspectSessionState(page: Page): Promise<BrowserSessionIssue | null> {
    const url = page.url();
    if (/facebook\.com\/(?:login|recover)|checkpoint/i.test(url)) {
      return {
        kind: /checkpoint/i.test(url) ? "CHECKPOINT" : "LOGIN_REQUIRED",
        message: /checkpoint/i.test(url)
          ? "Facebook đang yêu cầu xác minh tài khoản. Mở phiên Messenger để hoàn tất xác minh."
          : "Phiên Facebook đã hết hạn. Mở phiên Messenger và đăng nhập lại.",
      };
    }

    return await page.evaluate(() => {
      const bodyText = (document.body?.innerText || "").toLowerCase();
      if (
        bodyText.includes("tạm thời bị chặn") ||
        bodyText.includes("temporarily blocked") ||
        bodyText.includes("lạm dụng tính năng này do dùng quá nhanh") ||
        bodyText.includes("misusing this feature by going too fast")
      ) {
        return {
          kind: "RATE_LIMITED" as const,
          message: "Facebook tạm thời chặn do thao tác quá nhanh. Hệ thống tạm dừng để phiên nghỉ ngơi.",
        };
      }
      const hasLoginForm = Boolean(
        document.querySelector('input[name="email"], input[name="pass"], form[action*="login"]')
      );
      if (hasLoginForm || bodyText.includes("đăng nhập facebook") || bodyText.includes("log into facebook")) {
        return {
          kind: "LOGIN_REQUIRED" as const,
          message: "Phiên Facebook đã hết hạn. Mở phiên Messenger và đăng nhập lại.",
        };
      }
      if (
        bodyText.includes("checkpoint") ||
        bodyText.includes("security check") ||
        bodyText.includes("xác minh danh tính") ||
        bodyText.includes("confirm your identity")
      ) {
        return {
          kind: "CHECKPOINT" as const,
          message: "Facebook đang yêu cầu xác minh tài khoản. Mở phiên Messenger để hoàn tất xác minh.",
        };
      }
      return null;
    });
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
            text === "lúc khác" ||
            text === "ok" ||
            text === "đồng ý"
          ) {
            (btn as HTMLElement).click();
          }
        }
      });
    } catch {
      // Ignore evaluation errors during page transitions
    }
  }

  private async waitForObserverIdle(timeoutMs = 45000): Promise<boolean> {
    const startTime = Date.now();
    while (this.observerBusy) {
      if (Date.now() - startTime > timeoutMs) {
        return false;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
    return true;
  }

  private async readSidebarThreadsFromPage(page: Page): Promise<ParsedSidebarThread[]> {
    const evaluated = await page.evaluate(() => {
      const allLinks = Array.from(
        document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')
      );
      const sidebarLinks = allLinks.filter((a) => {
        if (a.closest('div[role="main"]')) return false;
        const rect = (a as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const container = document.createElement("div");
      for (const a of sidebarLinks) {
        const clone = a.cloneNode(true) as HTMLElement;
        const href = a.getAttribute("href") || "";
        const match = href.match(/\/messages\/(?:e2ee\/)?t\/([^/?#]+)/i);
        const threadId = match?.[1] || "";
        const rawText = (a as HTMLElement).innerText || "";
        const nameMatch = (a as HTMLElement).querySelector('span[dir="auto"]');
        const customerName = nameMatch?.textContent?.trim() || threadId || "Customer";

        const avatarImg = (a as HTMLElement).querySelector('img[src*="scontent"], img[src*="fbcdn"], img');
        const avatarUrl =
          avatarImg?.getAttribute("src") ||
          (a as HTMLElement).querySelector("image")?.getAttribute("xlink:href") ||
          (a as HTMLElement).querySelector("image")?.getAttribute("href") ||
          null;

        const participantId =
          href.match(/[?&](?:id|participant_id)=([0-9]+)/i)?.[1] ||
          a.querySelector('img[src*="fbid="]')?.getAttribute("src")?.match(/[?&]fbid=([0-9]+)/i)?.[1] ||
          null;

        let snippet = "";
        const autoSpans = Array.from((a as HTMLElement).querySelectorAll('span[dir="auto"]'));
        if (autoSpans.length >= 2) {
          snippet = autoSpans.slice(1).map((s) => s.textContent?.trim()).filter(Boolean).join(" ");
        }
        if (!snippet) {
          const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
          const nonNameLines = lines.filter((l) => l !== customerName && !l.includes("chưa đọc") && !l.includes("unread"));
          snippet = nonNameLines.join(" ");
        }
        if (!snippet) {
          snippet = rawText;
        }

        const fullAria = [
          a.getAttribute("aria-label") || "",
          ...Array.from(a.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label") || ""),
          rawText,
        ].join(" ");

        const markAsReadAction =
          /đánh dấu là đã đọc/iu.test(fullAria) ||
          /mark as read/iu.test(fullAria);

        const sanitizedAria = fullAria
          .replace(/đánh dấu là chưa đọc/giu, "")
          .replace(/mark as unread/giu, "");

        const unreadMention =
          /chưa đọc/iu.test(sanitizedAria) ||
          /unread/iu.test(sanitizedAria);

        let hasBoldStyle = false;
        try {
          const elementsToCheck = [nameMatch, ...autoSpans].filter(Boolean) as HTMLElement[];
          for (const el of elementsToCheck) {
            const fw = window.getComputedStyle(el).fontWeight;
            const numFw = parseInt(fw, 10);
            if (fw === "bold" || (!isNaN(numFw) && numFw >= 600)) {
              hasBoldStyle = true;
              break;
            }
          }
        } catch {
          // Ignore style computation errors
        }

        const isUnread = markAsReadAction || unreadMention || hasBoldStyle;

        clone.setAttribute("data-messenger-customer-name", customerName);
        clone.setAttribute("data-messenger-snippet", snippet);
        clone.setAttribute("data-messenger-unread", isUnread ? "true" : "false");
        if (participantId) {
          clone.setAttribute("data-messenger-participant-id", participantId);
        }
        if (avatarUrl) {
          clone.setAttribute("data-messenger-avatar-url", avatarUrl);
        }

        container.appendChild(clone);
      }
      return container.innerHTML;
    });

    if (typeof evaluated === "string") {
      return parseSidebarThreadsFromHtml(evaluated);
    }
    if (Array.isArray(evaluated)) {
      return evaluated as ParsedSidebarThread[];
    }
    return [];
  }

  private async inspectTriggeredThreads(
    page: Page,
    candidates: Array<{
      thread: ParsedSidebarThread;
      reason: "BASELINE_UNREAD" | "NEW_THREAD" | "SNIPPET_CHANGED" | "BECAME_UNREAD";
    }>
  ): Promise<void> {
    for (const candidate of candidates) {
      const { thread: t, reason } = candidate;

      if (this.sendLock) {
        console.log(
          `[BrowserAdapter] Send lock acquired by sender; pausing inspection queue at thread ${t.threadId}`
        );
        break;
      }

      const threadRef = t.threadRef || `https://www.facebook.com/messages/t/${t.threadId}`;
      const navigated = await this.navigateToMessengerThread(page, threadRef, false);
      if (!navigated) {
        console.warn(
          `[BrowserAdapter] Failed to navigate to triggered thread ${t.threadId}, retaining previous state for next poll retry`
        );
        continue;
      }

      const bubbleResult = await this.readBubblesFromPage(page, {
        threadTitle: t.customerName,
        participantId: t.participantId,
        threadId: t.threadId,
      });

      if (bubbleResult.isDegraded) {
        await this.triggerDegradedDom(
          bubbleResult.degradedReason || "DOM bubble missing stable message id - suspending channel"
        );
        return;
      }

      const emittedCount = await this.processInboundBubbles(
        bubbleResult,
        t,
        false
      );
      this.rememberActiveBubbleSequence(t.threadId, bubbleResult);

      this.lastSeenSidebarThreads.set(t.threadId, {
        snippet: t.snippet,
        isUnread: t.isUnread,
      });

      console.log(
        `[BrowserAdapter] Thread ${t.threadId} inspected (reason=${reason}, emitted=${emittedCount} inbounds).`
      );
    }
  }

  async observeInbound(callback: (inbound: InboundMessagePayload) => Promise<void>): Promise<void> {
    this.inboundCallback = callback;
    if (!this.observerPage) await this.init();
    if (this.isObserving) return;
    this.isObserving = true;

    console.log("[BrowserAdapter] Inbound polling observer started on single tab.");

    const poll = async () => {
      if (!this.isObserving) return;
      if (this.isDomDegraded) return;

      if (this.sendLock) {
        this.observeTimer = setTimeout(poll, getObserverPollDelay());
        return;
      }

      this.observerBusy = true;
      if (this.sendLock) {
        this.observerBusy = false;
        this.observeTimer = setTimeout(poll, getObserverPollDelay());
        return;
      }

      let nextDelayMs = getObserverPollDelay();
      try {
        const observerPage = await this.ensureObserverPage();

        const sessionIssue = await this.inspectSessionState(observerPage);
        if (sessionIssue) {
          await this.dismissOverlays(observerPage);
          await this.setSessionIssue(sessionIssue);
          nextDelayMs = sessionIssue.kind === "RATE_LIMITED" ? 15 * 60 * 1000 : getObserverPollDelay();
          return;
        }

        await observerPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);

        const threadElements = await this.readSidebarThreadsFromPage(observerPage);

        if (threadElements.length === 0) {
          this.consecutiveEmptyInboxPolls += 1;
          if (this.consecutiveEmptyInboxPolls >= 3) {
            await this.setSessionIssue({
              kind: "INBOX_UNAVAILABLE",
              message: "Messenger không hiển thị danh sách hội thoại. Hệ thống đã dừng nhận và gửi để tránh bỏ sót tin nhắn.",
            });
          }
          return;
        }

        this.consecutiveEmptyInboxPolls = 0;
        this.lastSuccessfulPollAt = new Date();
        await this.clearSessionIssue();
        if (!this.isInitializedBaseline) {
          await this.dismissOverlays(observerPage);
          const baselineCandidates: Array<{
            thread: ParsedSidebarThread;
            reason: "BASELINE_UNREAD";
          }> = [];

          for (const t of threadElements) {
            if (!t.threadId) continue;
            this.lastSeenSidebarThreads.set(t.threadId, {
              snippet: t.snippet,
              isUnread: t.isUnread,
            });
            if (t.isUnread && !t.isOutgoing && !isSnippetOutgoing(t.snippet)) {
              baselineCandidates.push({ thread: t, reason: "BASELINE_UNREAD" });
            }
          }

          const currentThreadId = extractMessengerThreadId(observerPage.url());
          const currentIsBaselineCandidate = baselineCandidates.some((c) => c.thread.threadId === currentThreadId);
          if (currentThreadId && !currentIsBaselineCandidate) {
            const currentBubbles = await this.readBubblesFromPage(observerPage, { threadId: currentThreadId });
            for (const bubble of currentBubbles.bubbles) {
              this.lastSeenMessageIds.add(bubble.id);
              if (bubble.isOutgoing) {
                this.seenOutgoingBubbleIds.add(bubble.id || `out:${currentThreadId}:${bubble.text.trim()}`);
              }
            }
            this.rememberActiveBubbleSequence(currentThreadId, currentBubbles);
            this.threadBaselinesEstablished.add(currentThreadId);
          }

          this.isInitializedBaseline = true;
          console.log(
            `[BrowserAdapter] Baseline snapshot captured for ${threadElements.length} threads in 1 tab (${baselineCandidates.length} unread pending).`
          );

          if (baselineCandidates.length > 0) {
            await this.inspectTriggeredThreads(observerPage, baselineCandidates);
          }

          return;
        }

        const currentThreadId = extractMessengerThreadId(observerPage.url());

        if (currentThreadId) {
          const currentElem = threadElements.find((t) => t.threadId === currentThreadId);

          if (currentElem) {
            this.lastSeenSidebarThreads.set(currentThreadId, {
              snippet: currentElem.snippet,
              isUnread: currentElem.isUnread,
            });
          }

          const bubbleResult = await this.readBubblesFromPage(observerPage, {
            threadTitle: currentElem?.customerName,
            participantId: currentElem?.participantId,
            threadId: currentThreadId,
          });

          if (bubbleResult.isDegraded) {
            await this.triggerDegradedDom(
              bubbleResult.degradedReason || "DOM bubble missing stable message id - suspending channel"
            );
            return;
          }

          await this.processInboundBubbles(
            bubbleResult,
            currentElem || {
              threadId: currentThreadId,
              customerName: "Customer",
              avatarUrl: null,
              href: observerPage.url(),
            },
            true
          );
        }

        const candidates: Array<{
          thread: ParsedSidebarThread;
          reason: "NEW_THREAD" | "SNIPPET_CHANGED" | "BECAME_UNREAD";
        }> = [];

        for (const t of threadElements) {
          if (!t.threadId) continue;
          const previous = this.lastSeenSidebarThreads.get(t.threadId);

          const hasTrigger = shouldInspectMessengerThread(currentThreadId, t, previous);
          if (!hasTrigger) {
            this.lastSeenSidebarThreads.set(t.threadId, {
              snippet: t.snippet,
              isUnread: t.isUnread,
            });
            continue;
          }
          let reason: "NEW_THREAD" | "SNIPPET_CHANGED" | "BECAME_UNREAD" = "SNIPPET_CHANGED";
          if (previous === undefined) {
            reason = "NEW_THREAD";
          } else if (t.snippet !== previous.snippet) {
            reason = "SNIPPET_CHANGED";
          } else if (!previous.isUnread && t.isUnread) {
            reason = "BECAME_UNREAD";
          }

          candidates.push({ thread: t, reason });
        }

        if (candidates.length > 0) {
          await this.inspectTriggeredThreads(observerPage, candidates);
        }
      } catch (err) {
        console.warn("[BrowserAdapter] Error during observer poll:", err);
        await this.setSessionIssue({
          kind: "INBOX_UNAVAILABLE",
          message: "Không thể kiểm tra hộp thư Messenger. Hệ thống đã dừng nhận và gửi cho đến khi kết nối phục hồi.",
        }).catch((callbackError) => {
          console.error("[BrowserAdapter] Failed to report observer failure:", callbackError);
        });
      } finally {
        this.observerBusy = false;
        if (this.isObserving && !this.isDomDegraded) {
          this.observeTimer = setTimeout(poll, nextDelayMs);
        }
      }
    };

    this.observeTimer = setTimeout(poll, 1000);
  }

  private async processInboundBubbles(
    bubbleResult: BubbleParseResult,
    threadInfo: {
      threadId: string;
      customerName: string;
      avatarUrl?: string | null;
      href?: string;
    },
    useActiveSequenceFallback = false
  ): Promise<number> {
    if (bubbleResult.bubbles.length === 0) return 0;

    // 1. Identify last outgoing bubble in current DOM view
    let lastOutgoingIdx = -1;
    for (let i = bubbleResult.bubbles.length - 1; i >= 0; i--) {
      if (bubbleResult.bubbles[i]?.isOutgoing) {
        lastOutgoingIdx = i;
        break;
      }
    }

    const isThreadFirstBaseline = !this.threadBaselinesEstablished.has(threadInfo.threadId);
    if (isThreadFirstBaseline) {
      this.threadBaselinesEstablished.add(threadInfo.threadId);
      for (let i = 0; i <= lastOutgoingIdx; i++) {
        const b = bubbleResult.bubbles[i];
        if (b && b.isOutgoing) {
          const bId = b.id || `out:${threadInfo.threadId}:${b.text.trim()}`;
          this.seenOutgoingBubbleIds.add(bId);
        }
      }
    }

    // 1.5 Detect external human outgoing bubbles (including media-only)
    if (lastOutgoingIdx >= 0 && this.externalOutboundCallback) {
      const lastOutBubble = bubbleResult.bubbles[lastOutgoingIdx];
      if (lastOutBubble) {
        const outBubbleId = lastOutBubble.id || `out:${threadInfo.threadId}:${lastOutBubble.text.trim()}`;
        if (!isThreadFirstBaseline && !this.seenOutgoingBubbleIds.has(outBubbleId)) {
          this.seenOutgoingBubbleIds.add(outBubbleId);
          if (this.seenOutgoingBubbleIds.size > 1000) {
            const firstKey = this.seenOutgoingBubbleIds.values().next().value;
            if (firstKey) this.seenOutgoingBubbleIds.delete(firstKey);
          }

          const outText = lastOutBubble.text.trim();
          const hasMedia = Boolean(lastOutBubble.hasMedia || (lastOutBubble.parts && lastOutBubble.parts.length > 0));
          const now = Date.now();

          // Check durable bot checker first (e.g. against DB outbound actions / bot messages across process restart)
          let isDurableBot = false;
          if (this.isDurableBotOutboundChecker) {
            try {
              isDurableBot = await this.isDurableBotOutboundChecker({
                threadId: threadInfo.threadId,
                bubbleId: lastOutBubble.id,
                text: outText,
              });
            } catch {
              // Ignore
            }
          }

          this.recentBotSentTexts = this.recentBotSentTexts.filter((item) => now - item.sentAt < 180000);
          const isRecentBotSent = this.recentBotSentTexts.some((botMsg) => {
            return (
              botMsg.text === outText ||
              (outText.length > 5 && (botMsg.text.includes(outText) || outText.includes(botMsg.text)))
            );
          });

          const isBot = isDurableBot || isRecentBotSent;

          if (!isBot && (outText.length > 0 || hasMedia)) {
            console.log(
              `[BrowserAdapter] Detected external human outbound in thread ${threadInfo.threadId} (text="${outText.slice(0, 40)}...", hasMedia=${hasMedia})`
            );
            try {
              await this.externalOutboundCallback({
                threadId: threadInfo.threadId,
                text: outText,
                timestamp: now,
                hasMedia,
                parts: lastOutBubble.parts,
                bubbleId: lastOutBubble.id,
              });
            } catch (err) {
              console.error("[BrowserAdapter] Error in externalOutboundCallback:", err);
            }
          }
        }
      }
    }

    // 2. Mark all bubbles up to and including lastOutgoingIdx as already handled/seen
    for (let i = 0; i <= lastOutgoingIdx; i++) {
      const b = bubbleResult.bubbles[i];
      if (b) {
        this.lastSeenMessageIds.add(b.id);
      }
    }

    // 3. If the newest visible bubble is outgoing, there are no pending customer inbounds
    if (lastOutgoingIdx === bubbleResult.bubbles.length - 1) {
      if (useActiveSequenceFallback) {
        this.rememberActiveBubbleSequence(threadInfo.threadId, bubbleResult);
      }
      return 0;
    }

    // 4. Process only unreplied inbound bubbles strictly after lastOutgoingIdx
    let processedCount = 0;
    const startIdx = lastOutgoingIdx >= 0 ? lastOutgoingIdx + 1 : 0;
    for (let i = startIdx; i < bubbleResult.bubbles.length; i++) {
      const bubble = bubbleResult.bubbles[i];
      if (!bubble || bubble.isOutgoing) continue;

      const mediaSignature = Array.isArray(bubble.parts) && bubble.parts.length > 0
        ? bubble.parts.filter((p) => p.type !== "TEXT").map((p) => ("media" in p && p.media ? `${p.type}:${p.media.mediaId}` : p.type)).join(",")
        : "";
      const baseSignature = `${bubble.isOutgoing ? "out" : "in"}:${bubble.text.trim()}`;
      const activeSignature = mediaSignature ? `${baseSignature}|${mediaSignature}` : baseSignature;
      const activeOccurrence = useActiveSequenceFallback
        ? (bubbleResult.bubbles.slice(0, i + 1).filter((candidate) => {
            const candMediaSig = Array.isArray(candidate.parts) && candidate.parts.length > 0
              ? candidate.parts.filter((p) => p.type !== "TEXT").map((p) => ("media" in p && p.media ? `${p.type}:${p.media.mediaId}` : p.type)).join(",")
              : "";
            const candBaseSig = `${candidate.isOutgoing ? "out" : "in"}:${candidate.text.trim()}`;
            const candSig = candMediaSig ? `${candBaseSig}|${candMediaSig}` : candBaseSig;
            return candSig === activeSignature;
          }).length)
        : 0;
      const activeSequenceKey = useActiveSequenceFallback
        ? `${threadInfo.threadId}:${activeSignature}`
        : "";
      const seenActiveOccurrences = useActiveSequenceFallback
        ? (this.lastSeenActiveSignatures.get(activeSequenceKey) ?? 0)
        : 0;
      const hasStableMessageId = /^mid[.$:]/i.test(bubble.id);
      const hasNewActiveOccurrence =
        useActiveSequenceFallback && !hasStableMessageId && activeOccurrence > seenActiveOccurrences;

      if (this.lastSeenMessageIds.has(bubble.id) && !hasNewActiveOccurrence) {
        continue; // Dedupe
      }
      const externalMessageId = hasNewActiveOccurrence
        ? `active.$${threadInfo.threadId}.${createHash("sha256")
            .update(`${activeSignature}:${activeOccurrence}`)
            .digest("hex")
            .slice(0, 24)}`
        : bubble.id;

      // An outgoing bubble can be briefly misclassified by Facebook's virtualized DOM.
      // Never emit a message id already confirmed by verifySent as customer inbound.
      if (useActiveSequenceFallback && !bubble.isOutgoing && this.confirmedOutboundMessageIds.has(bubble.id)) {
        continue;
      }

      if (this.inboundCallback) {
        const href = threadInfo.href || "";
        const routePrefix = href.includes("/messages/e2ee/t/")
          ? "/messages/e2ee/t/"
          : "/messages/t/";
        const fullThreadRef = `https://www.facebook.com${routePrefix}${encodeURIComponent(threadInfo.threadId)}`;

        const isVerifiedSender = Boolean(bubble.senderId && bubble.senderReliability === "VERIFIED");

        const resolvedName =
          (threadInfo.customerName && threadInfo.customerName !== "Customer" ? threadInfo.customerName : null) ||
          bubbleResult.headerTitle ||
          bubble.senderName ||
          threadInfo.customerName ||
          null;

        const resolvedAvatar = bubbleResult.avatarUrl || threadInfo.avatarUrl || null;

        await this.inboundCallback({
          channelAccountId: this.channelAccountId,
          externalThreadId: threadInfo.threadId,
          externalThreadRef: fullThreadRef,
          externalCustomerId: bubble.senderId ?? null,
          customerName: resolvedName,
          avatarUrl: resolvedAvatar,
          externalMessageId,
          text: bubble.text,
          timestamp: bubble.facebookEventTimestamp ?? bubble.observedTimestamp ?? new Date(),
          parts: bubble.parts,
          contentStatus: bubble.contentStatus ?? "READY",
          eventKind: bubble.eventKind ?? "MESSAGE_CREATED",
          contentQuality: bubble.contentQuality ?? bubble.quality ?? "TRUSTED",
          quality: bubble.quality ?? bubble.contentQuality ?? "TRUSTED",
          threadKind: bubble.threadKind ?? bubbleResult.threadClassification?.kind ?? "UNKNOWN",
          threadReliability: bubble.threadReliability ?? bubbleResult.threadClassification?.reliability ?? "UNVERIFIED",
          threadEvidence: bubble.threadEvidence ?? bubbleResult.threadClassification?.evidence ?? [],
          senderKind: bubble.senderKind ?? "UNKNOWN",
          senderReliability: bubble.senderReliability ?? "UNVERIFIED",
          senderEvidence: bubble.senderEvidence ?? [],
          senderExternalId: bubble.senderId ?? null,
          senderParticipantId: bubble.senderId ?? null,
          senderDisplayName: resolvedName,
          participantIdentity: isVerifiedSender
            ? {
                channelAccountId: this.channelAccountId,
                participantId: bubble.senderId!,
                senderKind: bubble.senderKind ?? "PERSON",
                isVerified: true,
                profileUrl: bubble.senderProfileUrl ?? null,
                displayName: resolvedName,
                verifiedAt: new Date(),
                metadata: {
                  ...(resolvedAvatar ? { avatarUrl: resolvedAvatar } : {}),
                },
              }
            : null,
          mentions: bubble.mentions ?? [],
          timestamps: bubble.timestamps,
          observedTimestamp: bubble.observedTimestamp,
          timestampProvenance: bubble.timestampProvenance,
          timestampPrecision: bubble.timestampPrecision,
        });
      }

      this.lastSeenMessageIds.add(bubble.id);
      if (useActiveSequenceFallback) {
        this.lastSeenActiveSignatures.set(activeSequenceKey, activeOccurrence);
      }
      processedCount++;
    }
    if (useActiveSequenceFallback) {
      this.rememberActiveBubbleSequence(threadInfo.threadId, bubbleResult);
    }
    return processedCount;
  }

  private rememberActiveBubbleSequence(threadId: string, bubbleResult: BubbleParseResult): void {
    const occurrences = new Map<string, number>();
    for (const bubble of bubbleResult.bubbles) {
      const signature = `${bubble.isOutgoing ? "out" : "in"}:${bubble.text.trim()}`;
      occurrences.set(signature, (occurrences.get(signature) ?? 0) + 1);
    }
    for (const [signature, count] of occurrences) {
      const key = `${threadId}:${signature}`;
      this.lastSeenActiveSignatures.set(key, Math.max(this.lastSeenActiveSignatures.get(key) ?? 0, count));
    }
  }

  /**
   * Reads message bubbles from a page, extracting stable identity, sender, thread type, mentions, and timestamps.
   */
  private async readBubblesFromPage(
    page: Page,
    hints?: { threadTitle?: string; participantId?: string | null; threadId?: string }
  ): Promise<BubbleParseResult> {
    if (!extractMessengerThreadId(page.url())) {
      return { ok: false, bubbles: [], isDegraded: false };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const html = await page.evaluate(() => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return "";

          const clone = main.cloneNode(true) as HTMLElement;
          const sourceElements = [main, ...Array.from(main.querySelectorAll("*"))];
          const clonedElements = [clone, ...Array.from(clone.querySelectorAll("*"))];
          const mainRect = main.getBoundingClientRect();

          for (let index = 0; index < sourceElements.length; index++) {
            const source = sourceElements[index] as HTMLElement;
            const target = clonedElements[index] as HTMLElement | undefined;
            if (!target) continue;

            // Mark only the message row itself. Marking arbitrary right-aligned descendants
            // leaks the outgoing flag into later sibling rows in serialized HTML.
            const isMessageRow =
              source.getAttribute("aria-roledescription")?.toLowerCase() === "message" ||
              source.getAttribute("data-testid") === "mw_message_row" ||
              source.getAttribute("data-testid") === "message_row" ||
              source.getAttribute("role") === "row";
            if (isMessageRow) {
              const textElements = Array.from(source.querySelectorAll('[dir="auto"], [role="none"], div')) as HTMLElement[];
              const textElement = textElements
                .filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 15 && rect.height > 10 && Boolean(element.innerText?.trim());
                })
                .at(-1);
              const rect = (textElement || source).getBoundingClientRect();
              const mainCenter = mainRect.left + mainRect.width / 2;
              const distFromRight = Math.abs(mainRect.right - rect.right);
              const distFromLeft = Math.abs(rect.left - mainRect.left);
              if (
                rect.width > 0 &&
                rect.height > 0 &&
                ((distFromRight < distFromLeft && rect.right > mainCenter) || rect.left + rect.width / 2 > mainCenter)
              ) {
                target.setAttribute("data-outgoing", "true");
              }
            }

            if (isMessageRow) {
              for (const key of Object.keys(source)) {
                if (!key.startsWith("__reactProps") && !key.startsWith("__reactFiber")) continue;

                const pending: Array<{ value: unknown; depth: number }> = [
                  { value: (source as unknown as Record<string, unknown>)[key], depth: 0 },
                ];
                const visited = new Set<object>();
                let inspected = 0;

                while (pending.length > 0 && inspected < 300) {
                  const item = pending.shift()!;
                  inspected += 1;

                  if (typeof item.value === "string") {
                    const id = item.value.match(/mid\.[A-Za-z0-9_$.-]+/)?.[0];
                    if (id) {
                      target.setAttribute("data-message-id", id);
                    }
                    continue;
                  }

                  if (!item.value || typeof item.value !== "object" || item.depth >= 4) continue;
                  if (visited.has(item.value)) continue;
                  visited.add(item.value);

                  const rec = item.value as Record<string, unknown>;
                  if (
                    rec.isOutgoing === true ||
                    rec.is_outgoing === true ||
                    rec.isViewer === true ||
                    rec.fromViewer === true ||
                    rec.isSender === true
                  ) {
                    target.setAttribute("data-outgoing", "true");
                    target.setAttribute("data-testid", "outgoing_message");
                  }

                  for (const child of Object.values(rec)) {
                    pending.push({ value: child, depth: item.depth + 1 });
                  }
                }
              }
            }
          }

          return clone.outerHTML;
        });
        const urlThreadId = extractMessengerThreadId(page.url()) || "";
        if (!urlThreadId) {
          return { ok: false, bubbles: [], isDegraded: false };
        }
        // Avoid hints overriding route mismatch
        const hintsMatchRoute = !hints?.threadId || hints.threadId === urlThreadId;
        const currentThreadId = urlThreadId;
        const effectiveHints = hintsMatchRoute ? hints : undefined;

        const isGroup = await page.evaluate(() => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return false;

          // 1. Group heading or aria-label in main
          const headings = Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"], [aria-label]'));
          for (const el of headings) {
            const text = el.textContent || "";
            const aria = el.getAttribute("aria-label") || "";
            if (
              /^(?:Conversation titled|Đoạn chat được đặt tên là)\b/i.test(text) ||
              /^(?:Conversation titled|Đoạn chat được đặt tên là)\b/i.test(aria)
            ) {
              return true;
            }
          }

          // 2. Group controls / options in main or side panel
          const groupSelector = `
            [aria-label*="Group options" i],
            [aria-label*="Tùy chọn nhóm" i],
            [aria-label*="Chat members" i],
            [aria-label*="Thành viên trong đoạn chat" i],
            [aria-label*="Thành viên" i],
            [aria-label*="Add people" i],
            [aria-label*="Thêm người" i],
            [aria-label*="Change group" i],
            [aria-label*="Đổi tên nhóm" i],
            [aria-label*="Đổi tên đoạn chat" i],
            [data-testid*="group_chat_header"],
            [data-thread-type="GROUP"]
          `;
          if (main.querySelector(groupSelector) !== null) return true;

          // 3. Member count in main (exclude active ago)
          const text = (main as HTMLElement).innerText || main.textContent || "";
          return /\b(\d+)\s*(?:thành viên|members)\b/i.test(text) && !/active\s*\d+\s*(?:m|min|h|d)\s*ago/i.test(text);
        }).catch(() => false);

        const directProfileId = isGroup
          ? null
          : await page.evaluate(() => {
              const main = document.querySelector('div[role="main"]');
              if (!main) return null;
              // Look strictly inside main header or side panel links
              const links = Array.from(main.querySelectorAll('a[href*="facebook.com/"], a[href^="/"]'));
              for (const a of links) {
                const href = a.getAttribute("href") || "";
                if (href.includes("/messages/") || href.includes("/messenger_media/")) continue;
                const match = href.match(/(?:profile\.php\?id=|facebook\.com\/|^\/)([0-9]{5,})/i);
                if (match?.[1]) return match[1];
              }
              return null;
            }).catch(() => null);

        const directParticipantId = isGroup
          ? null
          : (directProfileId || (effectiveHints?.participantId && effectiveHints.participantId !== this.botParticipantId ? effectiveHints.participantId : null));

        const mainHeaderInfo = await page.evaluate(() => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return { title: null, avatarUrl: null };
          const avatarImg = main.querySelector('img[src*="scontent"], img[src*="fbcdn"], img[src*="avatar"]');
          const avatarUrl = avatarImg?.getAttribute("src") || null;

          // 1. Conversation titled / Conversation with
          const convEl = Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"], [aria-label]')).find((el) => {
            const text = el.textContent?.trim() || "";
            const aria = el.getAttribute("aria-label")?.trim() || "";
            return /^(?:Conversation (?:with|titled)|Cuộc trò chuyện với|Đoạn chat được đặt tên là)\s+(.+)$/i.test(text) ||
                   /^(?:Conversation (?:with|titled)|Cuộc trò chuyện với|Đoạn chat được đặt tên là)\s+(.+)$/i.test(aria);
          });
          if (convEl) {
            const raw = convEl.textContent?.trim() || convEl.getAttribute("aria-label")?.trim() || "";
            const m = raw ? raw.match(/^(?:Conversation (?:with|titled)|Cuộc trò chuyện với|Đoạn chat được đặt tên là)\s+(.+)$/i) : null;
            if (m?.[1]?.trim()) return { title: m[1].trim(), avatarUrl };
          }

          // 2. Header pagelet
          const headerPagelet = main.querySelector('[data-pagelet="MWInboxDetail_MessageList_Header"]');
          if (headerPagelet) {
            const heading = headerPagelet.querySelector('h1, h2, h3, [role="heading"]');
            if (heading?.textContent?.trim()) return { title: heading.textContent.trim(), avatarUrl };
            const link = headerPagelet.querySelector('a[href*="/"]');
            if (link?.textContent?.trim()) {
              const cleaned = link.textContent.trim().replace(/\s*(?:Active|Đang hoạt động).*$/i, "").trim();
              if (cleaned) return { title: cleaned, avatarUrl };
            }
          }

          // 3. Side detail pagelet
          const sidePagelet = main.querySelector('[data-pagelet="MWInboxDetail_ThreadDetail"]');
          if (sidePagelet) {
            const heading = sidePagelet.querySelector('h1, h2, h3, [role="heading"]');
            if (heading?.textContent?.trim()) return { title: heading.textContent.trim(), avatarUrl };
          }

          // 4. Any heading in main
          const headings = Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"]'));
          for (const h of headings) {
            const text = h.textContent?.trim() || "";
            if (!text || /^(?:Messages|Tin nhắn|Compose|Soạn tin nhắn)$/i.test(text)) continue;
            if (text.length <= 100) return { title: text, avatarUrl };
          }

          return { title: null, avatarUrl };
        }).catch(() => ({ title: null, avatarUrl: null }));

        const mainHeaderTitle = mainHeaderInfo?.title ?? null;
        const mainHeaderAvatar = mainHeaderInfo?.avatarUrl ?? null;

        const parsed = parseMessengerBubblesFromHtml(html, {
          threadKindHint: isGroup ? "GROUP" : "DIRECT",
          threadReliabilityHint: "VERIFIED",
          observedAt: new Date(),
          timeZone: this.activeContextTimeZone,
          botChannelAccountId: this.channelAccountId,
          botParticipantId: this.botParticipantId,
          botProfileUrl: this.botProfileUrl,
          threadTitleHint: effectiveHints?.threadTitle || mainHeaderTitle || undefined,
          senderParticipantIdHint: directParticipantId || undefined,
        });

        parsed.headerTitle = mainHeaderTitle || parsed.headerTitle || effectiveHints?.threadTitle || null;
        parsed.avatarUrl = mainHeaderAvatar || parsed.avatarUrl || null;

        if (isGroup) {
          parsed.threadClassification = {
            kind: "GROUP",
            reliability: "VERIFIED",
            evidence: [{
              source: "DOM_SELECTOR",
              signal: "verified_group_conversation",
              confidence: 1,
              details: { threadId: currentThreadId },
            }],
          };
          for (const bubble of parsed.bubbles) {
            bubble.threadKind = "GROUP";
            bubble.threadReliability = "VERIFIED";
            if (bubble.isOutgoing) continue;
            // Group: never gets global self UID or direct participant ID
            if (bubble.senderId === this.botParticipantId) {
              bubble.senderId = null;
              bubble.senderReliability = "UNVERIFIED";
            }
          }
        } else {
          parsed.threadClassification = {
            kind: "DIRECT",
            reliability: "VERIFIED",
            evidence: [{
              source: "THREAD_METADATA",
              signal: "verified_direct_conversation",
              confidence: 1,
              details: { threadId: currentThreadId, directParticipantId },
            }],
          };
          const senderId = directParticipantId;
          for (const bubble of parsed.bubbles) {
            bubble.threadKind = "DIRECT";
            bubble.threadReliability = "VERIFIED";
            if (bubble.isOutgoing || bubble.senderReliability === "VERIFIED") continue;
            if (senderId && senderId !== this.botParticipantId) {
              bubble.senderId = senderId;
              bubble.senderKind = "PERSON";
              bubble.senderReliability = "VERIFIED";
              bubble.senderEvidence = [{
                source: "THREAD_METADATA",
                signal: "verified_direct_thread_participant",
                confidence: 1,
                details: { threadId: currentThreadId, senderId },
              }];
            }
          }
        }

        return parsed;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        const isNav =
          message.includes("Execution context was destroyed") ||
          message.includes("navigation") ||
          message.includes("Target closed");
        if (isNav && attempt < 3) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        console.warn(`[BrowserAdapter] Error reading bubbles from page (attempt ${attempt}):`, message);
        return {
          ok: false,
          bubbles: [],
          isDegraded: false,
        };
      }
    }
    return {
      ok: false,
      bubbles: [],
      isDegraded: false,
    };
  }

  async stopObserving(): Promise<void> {
    this.isObserving = false;
    if (this.observeTimer) {
      clearTimeout(this.observeTimer);
      this.observeTimer = null;
    }
    this.observerBusy = false;
  }

  // --- Sender Page Operations ---

  private async navigateToMessengerThread(
    page: Page,
    threadRef: string,
    requireComposer: boolean
  ): Promise<boolean> {
    const threadId = extractMessengerThreadId(threadRef) || threadRef;
    const currentUrl = page.url();
    const currentThreadId = extractMessengerThreadId(currentUrl);

    // 1. If already viewing this conversation and composer is visible, avoid navigating
    if (
      currentThreadId === threadId ||
      currentUrl.includes(`/messages/t/${threadId}`) ||
      currentUrl.includes(`/messages/e2ee/t/${threadId}`)
    ) {
      if (!requireComposer) {
        return true;
      }
      const composer = page.locator('div[role="textbox"][contenteditable="true"]').first();
      if (await composer.isVisible().catch(() => false)) {
        return true;
      }
      await this.dismissOverlays(page);
      if (await composer.isVisible().catch(() => false)) {
        return true;
      }
    }

    // 2. Client-side DOM switch: click sidebar link in DOM to avoid full page reload
    let switchedViaDom = false;
    try {
      const linkLocator = page
        .locator(`a[href*="/messages/t/${threadId}"], a[href*="/messages/e2ee/t/${threadId}"]`)
        .first();
      if (await linkLocator.isVisible().catch(() => false)) {
        await linkLocator.click({ timeout: 3000 }).catch(() => undefined);
        switchedViaDom = true;
      } else {
        switchedViaDom = await page.evaluate((targetId) => {
          const links = Array.from(
            document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')
          );
          const match = links.find((candidate) => {
            const href = candidate.getAttribute("href") || "";
            return href.includes(`/messages/t/${targetId}`) || href.includes(`/messages/e2ee/t/${targetId}`);
          }) as HTMLElement | undefined;
          if (match) {
            match.scrollIntoView?.({ block: "center" });
            match.click();
            return true;
          }
          return false;
        }, threadId);
      }
    } catch {
      switchedViaDom = false;
    }

    if (switchedViaDom) {
      await page
        .waitForURL(
          (url) => {
            const u = url.toString();
            return u.includes(`/messages/t/${threadId}`) || u.includes(`/messages/e2ee/t/${threadId}`);
          },
          { timeout: 5000 }
        )
        .catch(() => undefined);
    }

    // 3. Fallback to goto only if URL does not include threadId
    const afterDomUrl = page.url();
    if (!afterDomUrl.includes(threadId)) {
      const targetUrl = threadRef.startsWith("http")
        ? threadRef
        : threadRef.startsWith("/")
          ? new URL(threadRef, "https://www.facebook.com").toString()
          : `https://www.facebook.com/messages/t/${threadId}`;

      console.log(`[BrowserAdapter] Opening conversation via URL: ${targetUrl}`);
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (err) {
        console.warn(`[BrowserAdapter] Navigation failed for ${targetUrl}:`, err);
        return false;
      }
    }

    await this.dismissOverlays(page);

    const finalThreadId = extractMessengerThreadId(page.url());
    if (finalThreadId !== threadId && !page.url().includes(threadId)) {
      console.warn(`[BrowserAdapter] Thread navigation URL mismatch: expected ${threadId}, got ${page.url()}`);
      return false;
    }

    // Wait for conversation DOM to update for the new conversation
    if (typeof page.waitForFunction === "function") {
      await page.waitForFunction(
        (_tid) => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return false;
          const hasComposer = !!main.querySelector('div[role="textbox"][contenteditable="true"]');
          const hasHeader = !!main.querySelector('[data-pagelet="MWInboxDetail_MessageList_Header"], h3');
          const hasRows = !!main.querySelector('[aria-roledescription="message"], [role="row"], [data-pagelet="MWMessageRow"]');
          return hasHeader || hasComposer || hasRows;
        },
        threadId,
        { timeout: 5000 }
      ).catch(() => undefined);
    }

    if (!requireComposer) {
      return true;
    }

    // Wait for composer textbox to be visible
    try {
      const composerLocator = page.locator('div[role="textbox"][contenteditable="true"]').first();
      if (await composerLocator.isVisible().catch(() => false)) {
        return true;
      }
      await this.dismissOverlays(page);
      await page.waitForSelector('div[role="textbox"][contenteditable="true"]', {
        state: "visible",
        timeout: 10000,
      });
      return true;
    } catch {
      console.warn("[BrowserAdapter] Composer textbox not found in opened thread");
      return false;
    }
  }

  async openConversation(threadRef: string): Promise<boolean> {
    this.sendLock = true;
    const isIdle = await this.waitForObserverIdle(45000);
    if (!isIdle) {
      console.warn("[BrowserAdapter] Timed out waiting for observer to become idle before sender navigation");
      this.sendLock = false;
      return false;
    }

    try {
      const senderPage = await this.ensureSenderPage();
      const success = await this.navigateToMessengerThread(senderPage, threadRef, true);
      if (!success) {
        this.sendLock = false;
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[BrowserAdapter] Error in openConversation for ${threadRef}:`, err);
      this.sendLock = false;
      return false;
    }
  }

  async getOpenConversationRef(): Promise<ActiveConversationRef | null> {
    if (!this.senderPage) return null;
    const url = this.senderPage.url();
    const threadId = extractMessengerThreadId(url);
    if (!threadId) return null;
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
    const knownMessageTexts = Object.fromEntries(bubbles.map((b) => [b.id, b.text.trim()]));
    const outgoingIds = bubbles.filter((b) => b.isOutgoing).map((b) => b.id);
    const lastId = outgoingIds.length > 0 ? outgoingIds[outgoingIds.length - 1]! : null;

    return {
      threadRef: ref,
      knownMessageIds: allIds,
      knownMessageTexts,
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

    this.rememberBotSentText(text);

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
          if (char.length > 1 || char.codePointAt(0)! > 0xffff) {
            await this.senderPage.keyboard.insertText(char);
          } else {
            await this.senderPage.keyboard.type(char);
          }
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
    this.sendLock = false;
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
      const composer = this.senderPage.locator('div[role="textbox"][contenteditable="true"]').first();
      const composerFound = await composer.isVisible().catch(() => false);
      if (composerFound) {
        await composer.focus();
        await composer.press("Enter");
      } else {
        await this.senderPage.keyboard.press("Enter");
      }

      // Check if draft text remains in composer or if Send button should be clicked
      await this.senderPage.waitForTimeout(400);
      let textRemaining = false;
      if (composerFound) {
        textRemaining = await composer.evaluate((el) => {
          const t = (el as HTMLElement).innerText || el.textContent || "";
          return t.trim().length > 0;
        }).catch(() => false);
      }

      if (textRemaining) {
        console.log("[BrowserAdapter] Draft text remains in composer after Enter; triggering send button fallback...");
        const sendButtons = [
          'div[role="button"][aria-label*="gửi" i]',
          'div[role="button"][aria-label*="send" i]',
          'div[role="button"][aria-label*="Nhấn Enter để gửi" i]',
          'div[role="button"][aria-label*="Press Enter to send" i]',
          '[aria-label*="Nhấn Enter để gửi" i]',
          '[aria-label*="Press Enter to send" i]',
          'button[aria-label*="gửi" i]',
          'button[aria-label*="send" i]',
        ];

        for (const selector of sendButtons) {
          const btn = this.senderPage.locator(selector).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 2000 }).catch(() => undefined);
            await this.senderPage.waitForTimeout(300);
            break;
          }
        }
      }

      return { sent: true };
    } catch (err) {
      console.error("[BrowserAdapter] Failed to send draft:", err);
      return { sent: false };
    }
  }

  async verifySent(
    expectedText: string,
    _expectedHash: string,
    marker?: PreSendMarker | string,
    timeoutMs = 15000
  ): Promise<{ verified: boolean; messageRef?: string }> {
    try {
      if (!this.senderPage) return { verified: false };

      const startTime = Date.now();
      const normalizedExpected = expectedText.trim();
      const normExp = normalizedExpected.toLowerCase();
      const knownIds =
        marker && typeof marker === "object" && marker.knownMessageIds
          ? new Set(marker.knownMessageIds)
          : new Set<string>();

      while (Date.now() - startTime < timeoutMs) {
        const { bubbles } = await this.readBubblesFromPage(this.senderPage);

        // Verify that an outgoing bubble appeared strictly AFTER marker matching expectedText.
        // Messenger virtualizes rows and can reuse an old DOM id, so a matching newest
        // outgoing bubble is also valid when the composer has been cleared after Enter.
        for (let index = bubbles.length - 1; index >= 0; index--) {
          const b = bubbles[index];
          if (!b) continue;

          const bubbleText = b.text.trim();
          const normBubble = bubbleText.toLowerCase();
          const textMatches =
            normBubble === normExp ||
            normBubble.includes(normExp) ||
            normExp.includes(normBubble) ||
            (normBubble.length > 15 && normExp.slice(0, 20) === normBubble.slice(0, 20));
          if (!textMatches) continue;

          const composer = this.senderPage.locator('div[role="textbox"][contenteditable="true"]').first();
          const composerIsEmpty = await composer.evaluate((el) => {
            const text = (el as HTMLElement).innerText || el.textContent || "";
            return text.trim().length === 0;
          }).catch(() => false);

          if (!composerIsEmpty) continue;

          const previousText = marker && typeof marker === "object"
            ? marker.knownMessageTexts?.[b.id]?.trim().toLowerCase()
            : undefined;
          const isReusedIdWithNewText =
            knownIds.has(b.id) &&
            previousText !== undefined &&
            previousText !== normBubble;
          const isBrandNewId = !knownIds.has(b.id);
          const isAfterLastOutgoing =
            Boolean(marker && typeof marker === "object" && marker.lastMessageId && b.id !== marker.lastMessageId && b.isOutgoing);

          // Allow match if it is within the last 4 bubbles (Facebook often appends delivery ticks, seen receipts or timestamps below the bubble)
          const isNearBottom = index >= Math.max(0, bubbles.length - 4);

          if ((isBrandNewId || isReusedIdWithNewText || isAfterLastOutgoing) && isNearBottom) {
            b.isOutgoing = true;
            this.lastSeenMessageIds.add(b.id);
            this.confirmedOutboundMessageIds.add(b.id);
            const currentUrl = typeof this.senderPage.url === "function"
              ? this.senderPage.url()
              : (this.senderPage as unknown as { url?: string }).url || "";
            this.rememberActiveBubbleSequence(
              extractMessengerThreadId(currentUrl) || "unknown",
              { ok: true, bubbles: [b], isDegraded: false }
            );
            return { verified: true, messageRef: b.id };
          }
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      return { verified: false };
    } finally {
      this.sendLock = false;
    }
  }

  async searchRecipients(
    query: string
  ): Promise<Array<{ id: string; name: string; avatarUrl?: string; kind: "PERSON" | "GROUP" }>> {
    if (!query || !query.trim()) return [];
    await this.acquireSendLock();
    try {
      if (!this.page || this.page.isClosed()) {
        await this.init();
      }
      const page = this.page;
      if (!page) return [];

      const priorUrl = page.url();
      const composeLink = page.getByRole("link", { name: /tin nhắn mới|new message/i }).first();
      const composeBtn = page.getByRole("button", { name: /tin nhắn mới|new message/i }).first();

      if (await composeLink.count()) {
        await composeLink.click({ timeout: 5000 }).catch(() => undefined);
      } else if (await composeBtn.count()) {
        await composeBtn.click({ timeout: 5000 }).catch(() => undefined);
      } else if (!page.url().includes("/messages/new")) {
        await page.goto("https://www.facebook.com/messages/new", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
      }

      await page.waitForTimeout(500);

      const input = page.getByRole("combobox", { name: /send message to|tìm kiếm trên messenger|search messenger/i }).first();
      if (!(await input.count())) {
        return [];
      }

      await input.fill(query.trim());
      await page.waitForTimeout(1200);

      const results = await page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('[role="option"]'));
        const candidates: Array<{ id: string; name: string; avatarUrl?: string; kind: "PERSON" | "GROUP" }> = [];
        const seenIds = new Set<string>();

        for (const opt of options) {
          const ariaLabel = opt.getAttribute("aria-label")?.trim();
          const id = opt.getAttribute("id")?.trim();
          const text = (opt as HTMLElement).innerText || "";
          const img = opt.querySelector("img[src]");
          const avatarUrl = img?.getAttribute("src") || undefined;

          if (!id || /suggested|gợi ý/i.test(ariaLabel || text)) {
            continue;
          }

          if (!/^\d+$/.test(id)) {
            continue;
          }

          if (seenIds.has(id)) continue;
          seenIds.add(id);

          const name = ariaLabel || text.split("\n")[0]?.trim() || id;
          const isGroup = /others|thành viên|nhóm|and \d+/i.test(text);

          candidates.push({
            id,
            name,
            avatarUrl,
            kind: isGroup ? "GROUP" : "PERSON",
          });
        }
        return candidates;
      });

      await input.fill("").catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);

      if (priorUrl && priorUrl !== page.url() && !priorUrl.includes("/messages/new")) {
        await page.goto(priorUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => undefined);
      }

      return results;
    } catch (err) {
      console.error("[BrowserAdapter] Error in searchRecipients:", err);
      return [];
    } finally {
      this.releaseSendLock();
    }
  }

  async health(): Promise<ChannelHealthReport> {
    const isContextAlive = Boolean(
      this.context &&
      this.page &&
      !this.page.isClosed()
    );
    // When sendLock is true, observer is intentionally paused for single-tab mutual exclusion
    const isObserverFresh = Boolean(
      this.sendLock ||
      (this.lastSuccessfulPollAt && Date.now() - this.lastSuccessfulPollAt.getTime() <= OBSERVER_STALE_AFTER_MS)
    );
    const healthy = isContextAlive && isObserverFresh && !this.isDomDegraded && !this.sessionIssue;

    return {
      healthy,
      status: this.isDomDegraded || this.sessionIssue ? "DEGRADED" : healthy ? "RUNNING" : "SUSPENDED",
      domOk: !this.isDomDegraded && this.sessionIssue?.kind !== "INBOX_UNAVAILABLE",
      sessionActive: isContextAlive && !this.sessionIssue,
      checkpointDetected: this.sessionIssue?.kind === "CHECKPOINT",
      rateLimitDetected: this.sessionIssue?.kind === "RATE_LIMITED",
      errorMessage:
        this.degradedReason ||
        this.sessionIssue?.message ||
        (!isObserverFresh ? "Messenger observer has not completed a valid inbox poll recently" : null),
      timestamp: new Date(),
    };
  }

  async close(): Promise<void> {
    await this.stopObserving();
    try {
      if (this.page) await this.page.close().catch(() => undefined);
      if (this.context) await this.context.close().catch(() => undefined);
    } catch {
      // Ignore errors on closing
    } finally {
      this.page = null;
      this.context = null;
    }
  }
}
