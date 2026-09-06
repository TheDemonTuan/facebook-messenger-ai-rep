import { chromium, type BrowserContext, type Page } from "playwright";
import type { ChannelAdapter, PreSendMarker, BubbleParseResult } from "@messenger/channel";
import { TypingEngine, parseMessengerBubblesFromHtml } from "@messenger/channel";
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

export function extractMessengerThreadId(value: string): string | null {
  return value.match(MESSENGER_THREAD_PATH)?.[1] ?? null;
}

export function isSnippetOutgoing(snippet: string): boolean {
  return (
    /\b(?:bạn|you)\s*:/i.test(snippet) ||
    /\b(?:bạn đã gửi|you sent)\b/i.test(snippet)
  );
}

export function extractCleanSnippetText(rawSnippet: string, customerName?: string | null): string {
  if (!rawSnippet) return "";
  let text = rawSnippet.replace(/\s+/g, " ").trim();

  // Strip customer name prefix if present
  if (customerName && customerName.trim()) {
    const name = customerName.trim();
    if (text.toLowerCase().startsWith(name.toLowerCase())) {
      text = text.slice(name.length).trim();
      text = text.replace(/^[:\-\s]+/, "").trim();
    }
  }

  // Remove middle dot / bullet separator and anything following it (always timestamp in Messenger sidebar)
  text = text.replace(/\s*[·•].*$/, "").trim();

  // Remove standalone timestamp suffixes at the end of line
  text = text.replace(/\s+\d+\s*(?:phút|giờ|ngày|tuần|tháng|giây|năm|m|h|d|w|s)\s*$/iu, "").trim();

  // Remove action labels
  text = text.replace(/\b(?:đánh dấu là chưa đọc|đánh dấu là đã đọc|mark as unread|mark as read)\b/giu, "").trim();

  // Clean any leftover trailing punctuation from separators
  text = text.replace(/[\s:·•-]+$/, "").trim();

  return text;
}

export function shouldInspectMessengerThread(
  currentThreadId: string | null,
  threadId: string,
  isUnread: boolean,
  previousSnippet: string | undefined,
  snippet: string
): boolean {
  // If already on this thread, always inspect its DOM directly (zero navigation cost)
  if (currentThreadId === threadId) {
    return true;
  }
  // If latest message was sent by us/bot, never switch to this thread!
  if (isSnippetOutgoing(snippet)) {
    return false;
  }
  // If actively viewing a thread, do not switch away to another thread if its snippet is unchanged!
  // Hopping away on unchanged unread snippets causes infinite switching loops.
  if (currentThreadId !== null && previousSnippet !== undefined && previousSnippet === snippet) {
    return false;
  }
  // If newly discovered thread in sidebar: only inspect if genuinely unread
  if (previousSnippet === undefined) {
    return isUnread;
  }
  return (
    isUnread ||
    previousSnippet !== snippet
  );
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
  private isObserving = false;
  private observeTimer: NodeJS.Timeout | null = null;
  private lastSeenMessageIds = new Set<string>();
  private confirmedOutboundMessageIds = new Set<string>();
  private lastSeenActiveSignatures = new Map<string, number>();
  private lastSeenSnippets = new Map<string, string>();
  private initializedThreadIds = new Set<string>();
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
    this.lastSeenSnippets.clear();
    this.initializedThreadIds.clear();
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

  async observeInbound(callback: (inbound: InboundMessagePayload) => Promise<void>): Promise<void> {
    this.inboundCallback = callback;
    if (!this.observerPage) await this.init();
    if (this.isObserving) return;
    this.isObserving = true;

    console.log("[BrowserAdapter] Inbound polling observer started on single tab.");

    const poll = async () => {
      if (!this.isObserving) return;
      if (this.isDomDegraded) return;

      // Single tab coordination: pause observer while sender is typing or sending
      if (this.sendLock) {
        this.observeTimer = setTimeout(poll, getObserverPollDelay());
        return;
      }

      try {
        const observerPage = await this.ensureObserverPage();

        const sessionIssue = await this.inspectSessionState(observerPage);
        if (sessionIssue) {
          await this.dismissOverlays(observerPage);
          await this.setSessionIssue(sessionIssue);
          const backoffDelay = sessionIssue.kind === "RATE_LIMITED" ? 15 * 60 * 1000 : getObserverPollDelay();
          this.observeTimer = setTimeout(poll, backoffDelay);
          return;
        }

        await observerPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);

        // 1. Sidebar is ONLY a trigger: query sidebar thread rows
        const threadElements = await observerPage.evaluate(() => {
          const links = Array.from(
            document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')
          );
          return links.map((a) => {
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
              (/^[0-9]+$/.test(threadId) && !/\b(?:\d+\s*(?:members|thành viên)|chat members|group options)\b/i.test(rawText)
                ? threadId
                : null);

            // Extract dedicated snippet text from inner spans or lines
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
              avatarUrl,
              participantId,
              snippet: snippet.replace(/\s+/g, " ").trim(),
              isUnread,
            };
          });
        });

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

        // First valid poll captures baseline in single tab without navigating to historical threads
        if (!this.isInitializedBaseline) {
          await this.dismissOverlays(observerPage);
          for (const t of threadElements) {
            if (t.threadId && t.snippet) {
              const cleanSnippet = extractCleanSnippetText(t.snippet, t.customerName);
              if (cleanSnippet) {
                this.lastSeenSnippets.set(t.threadId, cleanSnippet);
              }
              this.initializedThreadIds.add(t.threadId);
            }
          }

          const currentThreadId = extractMessengerThreadId(observerPage.url());
          if (currentThreadId) {
            const currentBubbles = await this.readBubblesFromPage(observerPage, { threadId: currentThreadId });
            for (const bubble of currentBubbles.bubbles) {
              this.lastSeenMessageIds.add(bubble.id);
            }
            this.rememberActiveBubbleSequence(currentThreadId, currentBubbles);
          }

          this.isInitializedBaseline = true;
          console.log(`[BrowserAdapter] Baseline snapshot captured for ${threadElements.length} threads in 1 tab without navigating.`);
          this.observeTimer = setTimeout(poll, getObserverPollDelay());
          return;
        }

        // 2. Check active thread first: read DOM in-place if viewing it
        const currentThreadId = extractMessengerThreadId(observerPage.url());

        if (currentThreadId) {
          const currentElem = threadElements.find((t) => t.threadId === currentThreadId);

          if (currentElem) {
            const cleanSnippet = extractCleanSnippetText(currentElem.snippet, currentElem.customerName);
            if (cleanSnippet) {
              this.lastSeenSnippets.set(currentThreadId, cleanSnippet);
            }
          }
          this.initializedThreadIds.add(currentThreadId);

          // Messenger marks an open conversation as read immediately and may update its
          // sidebar snippet late, so the active DOM must be checked on every poll.
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

        // 3. Zero chat loading for sidebar: extract new incoming messages directly without navigating/opening chat!
        for (const t of threadElements) {
          if (!t.threadId || !t.snippet) continue;
          if (t.threadId === currentThreadId) continue;

          const cleanText = extractCleanSnippetText(t.snippet, t.customerName);
          if (!cleanText) continue;

          const prevSnippet = this.lastSeenSnippets.get(t.threadId);
          // Compare canonical message text because Messenger's timestamp label changes
          // while the underlying sidebar message remains the same.
          if (prevSnippet !== undefined && prevSnippet === cleanText) {
            continue;
          }

          const hasTrigger = shouldInspectMessengerThread(
            currentThreadId,
            t.threadId,
            t.isUnread,
            prevSnippet,
            cleanText
          );

          if (!hasTrigger) continue;

          // Record before callback so the same message cannot be replayed on callback failure.
          this.lastSeenSnippets.set(t.threadId, cleanText);
          this.initializedThreadIds.add(t.threadId);

          if (isSnippetOutgoing(cleanText)) {
            continue;
          }

          const snippetHash = createHash("sha256")
            .update(`${t.threadId}:${cleanText}`)
            .digest("hex")
            .slice(0, 16);
          const externalMessageId = `snip.$${t.threadId}.${Date.now()}.${snippetHash}`;

          if (this.lastSeenMessageIds.has(externalMessageId)) {
            continue;
          }
          this.lastSeenMessageIds.add(externalMessageId);

          if (this.inboundCallback) {
            const href = t.href || "";
            const routePrefix = href.includes("/messages/e2ee/t/")
              ? "/messages/e2ee/t/"
              : "/messages/t/";
            const fullThreadRef = `https://www.facebook.com${routePrefix}${encodeURIComponent(t.threadId)}`;

            await this.inboundCallback({
              channelAccountId: this.channelAccountId,
              externalThreadId: t.threadId,
              externalThreadRef: fullThreadRef,
              externalCustomerId: t.participantId ?? null,
              customerName: t.customerName || null,
              avatarUrl: t.avatarUrl || null,
              externalMessageId,
              text: cleanText,
              timestamp: new Date(),
              threadKind: "DIRECT",
              threadReliability: "UNVERIFIED",
              senderReliability: "UNVERIFIED",
              observedTimestamp: new Date(),
              timestampProvenance: "OBSERVED",
            });
          }
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
        if (this.isObserving && !this.isDomDegraded) {
          this.observeTimer = setTimeout(poll, getObserverPollDelay());
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
      avatarUrl: string | null;
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

      const activeSignature = `${bubble.isOutgoing ? "out" : "in"}:${bubble.text.trim()}`;
      const activeOccurrence = useActiveSequenceFallback
        ? (bubbleResult.bubbles.slice(0, i + 1).filter((candidate) =>
            `${candidate.isOutgoing ? "out" : "in"}:${candidate.text.trim()}` === activeSignature
          ).length)
        : 0;
      const activeSequenceKey = useActiveSequenceFallback
        ? `${threadInfo.threadId}:${activeSignature}`
        : "";
      const seenActiveOccurrences = useActiveSequenceFallback
        ? (this.lastSeenActiveSignatures.get(activeSequenceKey) ?? 0)
        : 0;
      const hasNewActiveOccurrence = useActiveSequenceFallback && activeOccurrence > seenActiveOccurrences;

      if (this.lastSeenMessageIds.has(bubble.id) && !hasNewActiveOccurrence) {
        continue; // Dedupe
      }

      const externalMessageId = hasNewActiveOccurrence
        ? `active.$${threadInfo.threadId}.${createHash("sha256")
            .update(`${activeSignature}:${activeOccurrence}`)
            .digest("hex")
            .slice(0, 24)}`
        : bubble.id;

      this.lastSeenMessageIds.add(bubble.id);
      if (useActiveSequenceFallback) {
        this.lastSeenActiveSignatures.set(activeSequenceKey, activeOccurrence);
      }

      // An outgoing bubble can be briefly misclassified by Facebook's virtualized DOM.
      // Never emit a message id already confirmed by verifySent as customer inbound.
      if (useActiveSequenceFallback && !bubble.isOutgoing && this.confirmedOutboundMessageIds.has(bubble.id)) {
        continue;
      }

      processedCount++;

      if (this.inboundCallback) {
        const href = threadInfo.href || "";
        const routePrefix = href.includes("/messages/e2ee/t/")
          ? "/messages/e2ee/t/"
          : "/messages/t/";
        const fullThreadRef = `https://www.facebook.com${routePrefix}${encodeURIComponent(threadInfo.threadId)}`;

        const isVerifiedSender = Boolean(bubble.senderId && bubble.senderReliability === "VERIFIED");

        const resolvedName = threadInfo.customerName || bubble.senderName || bubbleResult.headerTitle || null;

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

          return clone.outerHTML;
        });
        const currentThreadId = hints?.threadId || extractMessengerThreadId(page.url()) || "";

        const isGroup = await page.evaluate(() => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return false;
          const groupSelector = `
            [aria-label*="Chat members" i],
            [aria-label*="Thành viên" i],
            [aria-label*="Group options" i],
            [aria-label*="Tùy chọn nhóm" i],
            [aria-label*="Group info" i],
            [aria-label*="Thông tin nhóm" i],
            [aria-label*="Add people" i],
            [aria-label*="Thêm người" i],
            [aria-label*="Change group" i],
            [aria-label*="Đổi tên nhóm" i],
            [aria-label*="Đổi tên đoạn chat" i]
          `;
          if (main.querySelector(groupSelector) !== null) return true;
          const text = (main as HTMLElement).innerText || main.textContent || "";
          return /\b(\d+)\s*(?:thành viên|members)\b/i.test(text);
        }).catch(() => false);

        const directProfileId = await page.evaluate(() => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return null;
          const links = Array.from(main.querySelectorAll('a[aria-label*="profile" i], a[aria-label*="trang cá nhân" i], a[href*="facebook.com/"], a[href^="/"]'));
          for (const a of links) {
            const href = a.getAttribute("href") || "";
            if (href.includes("/messages/")) continue;
            const match = href.match(/(?:profile\.php\?id=|facebook\.com\/|^\/)([0-9]{5,})/i);
            if (match?.[1]) return match[1];
          }
          return null;
        }).catch(() => null);

        const directParticipantId = isGroup
          ? null
          : (directProfileId || hints?.participantId || (/^[0-9]+$/.test(currentThreadId) ? currentThreadId : null));

        const parsed = parseMessengerBubblesFromHtml(html, {
          threadKindHint: isGroup ? "GROUP" : "DIRECT",
          threadReliabilityHint: "VERIFIED",
          observedAt: new Date(),
          timeZone: this.activeContextTimeZone,
          botChannelAccountId: this.channelAccountId,
          botParticipantId: this.botParticipantId,
          botProfileUrl: this.botProfileUrl,
          threadTitleHint: hints?.threadTitle,
          senderParticipantIdHint: directParticipantId || undefined,
        });

        if (!isGroup) {
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
          const senderId = directParticipantId || currentThreadId;
          for (const bubble of parsed.bubbles) {
            bubble.threadKind = "DIRECT";
            bubble.threadReliability = "VERIFIED";
            if (bubble.isOutgoing || bubble.senderReliability === "VERIFIED") continue;
            if (senderId) {
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

        const mainHeaderInfo = await page.evaluate(() => {
          const main = document.querySelector('div[role="main"]');
          if (!main) return { title: null, avatarUrl: null };
          const avatarImg = main.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
          const avatarUrl = avatarImg?.getAttribute("src") || null;
          const profileLink = main.querySelector('a[aria-label*="profile" i], a[aria-label*="trang cá nhân" i]');
          const heading = Array.from(main.querySelectorAll('h1, h2, [role="heading"]')).find((element) => {
            const rect = element.getBoundingClientRect();
            const text = element.textContent?.trim() || "";
            return rect.height > 0 && text.length > 0 && text.length <= 100;
          });
          const title = profileLink?.textContent?.trim() || heading?.textContent?.trim() || null;
          return { title, avatarUrl };
        }).catch(() => ({ title: null, avatarUrl: null }));

        parsed.headerTitle = mainHeaderInfo.title;
        parsed.avatarUrl = mainHeaderInfo.avatarUrl;

        return parsed;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
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
    this.inboundCallback = null;
  }

  // --- Sender Page Operations ---

  async openConversation(threadRef: string): Promise<boolean> {
    this.sendLock = true;
    const senderPage = await this.ensureSenderPage();
    const threadId = extractMessengerThreadId(threadRef) || threadRef;

    const currentUrl = senderPage.url();
    const currentThreadId = extractMessengerThreadId(currentUrl);

    // 1. If already viewing this conversation and composer is visible, avoid navigating
    if (
      currentThreadId === threadId ||
      currentUrl.includes(`/messages/t/${threadId}`) ||
      currentUrl.includes(`/messages/e2ee/t/${threadId}`)
    ) {
      const composer = senderPage.locator('div[role="textbox"][contenteditable="true"]').first();
      if (await composer.isVisible().catch(() => false)) {
        return true;
      }
      await this.dismissOverlays(senderPage);
      if (await composer.isVisible().catch(() => false)) {
        return true;
      }
    }

    // 2. Client-side DOM switch: click sidebar link in DOM to avoid full page reload
    let switchedViaDom = false;
    try {
      const linkLocator = senderPage
        .locator(`a[href*="/messages/t/${threadId}"], a[href*="/messages/e2ee/t/${threadId}"]`)
        .first();
      if (await linkLocator.isVisible().catch(() => false)) {
        await linkLocator.click({ timeout: 3000 }).catch(() => undefined);
        switchedViaDom = true;
      } else {
        switchedViaDom = await senderPage.evaluate((targetId) => {
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
      await senderPage
        .waitForURL(
          (url) => {
            const u = url.toString();
            return u.includes(`/messages/t/${threadId}`) || u.includes(`/messages/e2ee/t/${threadId}`);
          },
          { timeout: 4000 }
        )
        .catch(() => undefined);
    }

    // 3. Fallback to goto only if URL does not include threadId
    const afterDomUrl = senderPage.url();
    if (!afterDomUrl.includes(threadId)) {
      const targetUrl = threadRef.startsWith("http")
        ? new URL(threadRef, "https://www.facebook.com").toString()
        : `https://www.facebook.com/messages/t/${threadId}`;

      console.log(`[BrowserAdapter] Sender opening conversation via URL: ${targetUrl}`);
      try {
        await senderPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (err) {
        console.warn(`[BrowserAdapter] Sender navigation failed for ${targetUrl}:`, err);
        this.sendLock = false;
        return false;
      }
    }

    // Wait for composer textbox to be visible
    try {
      const composerLocator = senderPage.locator('div[role="textbox"][contenteditable="true"]').first();
      if (await composerLocator.isVisible().catch(() => false)) {
        return true;
      }
      await this.dismissOverlays(senderPage);
      await senderPage.waitForSelector('div[role="textbox"][contenteditable="true"]', {
        state: "visible",
        timeout: 10000,
      });
      return true;
    } catch {
      console.warn("[BrowserAdapter] Composer textbox not found in opened thread");
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
    timeoutMs = 10000
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

          if ((isBrandNewId || isReusedIdWithNewText) && index === bubbles.length - 1) {
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
