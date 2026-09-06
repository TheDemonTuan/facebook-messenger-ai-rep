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

export interface PlaywrightAdapterOptions {
  profileDir: string;
  headless?: boolean;
  channelAccountId?: string;
  timeZone?: string;
  botParticipantId?: string;
  botProfileUrl?: string;
}

export type BrowserSessionIssueKind = "LOGIN_REQUIRED" | "CHECKPOINT" | "INBOX_UNAVAILABLE";

export interface BrowserSessionIssue {
  kind: BrowserSessionIssueKind;
  message: string;
}

const MESSENGER_INBOX_URL = "https://www.facebook.com/messages/t/";
const MESSENGER_THREAD_PATH = /\/messages\/(?:e2ee\/)?t\/([^/?#]+)/i;
const OBSERVER_POLL_INTERVAL_MS = 2500;
const OBSERVER_STALE_AFTER_MS = 30000;

export function extractMessengerThreadId(value: string): string | null {
  return value.match(MESSENGER_THREAD_PATH)?.[1] ?? null;
}

export function shouldInspectMessengerThread(
  currentThreadId: string | null,
  threadId: string,
  isUnread: boolean,
  previousSnippet: string | undefined,
  snippet: string
): boolean {
  return (
    currentThreadId === threadId ||
    isUnread ||
    previousSnippet === undefined ||
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
    if (this.context && this.observerPage && !this.observerPage.isClosed()) return;

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

    const pages = this.context.pages();
    this.observerPage =
      pages.find((page) => page.url().includes("facebook.com/messages")) ||
      pages[0] ||
      (await this.context.newPage());

    this.senderPage = null;

    // Close any extraneous blank or extra tabs, keeping only observerPage
    for (const page of pages) {
      if (page !== this.observerPage) {
        await page.close().catch(() => undefined);
      }
    }

    await this.ensureObserverPage();
    await this.observerPage.bringToFront().catch(() => undefined);
  }

  private async ensureSenderPage(): Promise<Page> {
    if (!this.context) {
      await this.init();
    }
    if (!this.context) throw new Error("Browser context is not initialized");
    if (!this.senderPage || this.senderPage.isClosed()) {
      console.log("[BrowserAdapter] Creating dedicated sender page on demand...");
      this.senderPage = await this.context.newPage();
    }
    return this.senderPage;
  }

  private async ensureObserverPage(): Promise<Page> {
    if (!this.context) throw new Error("Browser context is not initialized");

    const messengerPage = this.context
      .pages()
      .find((page) => page !== this.senderPage && !page.isClosed() && page.url().includes("facebook.com/messages"));

    if ((!this.observerPage || this.observerPage.isClosed() || !this.observerPage.url().includes("facebook.com/messages")) && messengerPage) {
      if (this.observerPage !== messengerPage) {
        this.observerPage = messengerPage;
        this.isInitializedBaseline = false;
        this.consecutiveEmptyInboxPolls = 0;
      }
    }

    if (!this.observerPage || this.observerPage.isClosed()) {
      this.observerPage = await this.context.newPage();
      this.isInitializedBaseline = false;
      this.consecutiveEmptyInboxPolls = 0;
    }

    const url = this.observerPage.url();
    if (!url.includes("facebook.com/messages") && !/facebook\.com\/(?:login|recover)|checkpoint/i.test(url)) {
      console.log("[BrowserAdapter] Restoring dedicated observer page to Messenger inbox...");
      await this.observerPage.goto(MESSENGER_INBOX_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }

    return this.observerPage;
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
      if (!this.isObserving) return;
      if (this.isDomDegraded) return;

      try {
        const observerPage = await this.ensureObserverPage();
        await this.dismissOverlays(observerPage);

        const sessionIssue = await this.inspectSessionState(observerPage);
        if (sessionIssue) {
          await this.setSessionIssue(sessionIssue);
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
            const participantId =
              href.match(/[?&](?:id|participant_id)=([0-9]+)/i)?.[1] ||
              a.querySelector('img[src*="fbid="]')?.getAttribute("src")?.match(/[?&]fbid=([0-9]+)/i)?.[1] ||
              (/^[0-9]+$/.test(threadId) && !/\b(?:\d+\s*(?:members|thành viên)|chat members|group options)\b/i.test(rawText)
                ? threadId
                : null);

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
              participantId,
              snippet: rawText.replace(/\s+/g, " ").trim(),
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

        // First valid poll captures baseline so startup doesn't ingest historical messages
        if (!this.isInitializedBaseline) {
          for (const t of threadElements) {
            if (t.threadId && t.snippet) {
              this.lastSeenSnippets.set(t.threadId, t.snippet);
            }
          }

          // Also capture baseline message bubbles if a conversation is open.
          if (extractMessengerThreadId(observerPage.url())) {
            const baselineBubbles = await this.readBubblesFromPage(observerPage);
            if (baselineBubbles.isDegraded) {
              await this.triggerDegradedDom(baselineBubbles.degradedReason || "Missing stable identity during baseline");
              return;
            }
            for (const b of baselineBubbles.bubbles) {
              this.lastSeenMessageIds.add(b.id);
            }
          }

          this.isInitializedBaseline = true;
          console.log(`[BrowserAdapter] Baseline snapshot captured for ${threadElements.length} threads and ${this.lastSeenMessageIds.size} visible messages.`);
          this.observeTimer = setTimeout(poll, OBSERVER_POLL_INTERVAL_MS);
          return;
        }

        // 2. Check each thread where sidebar triggered a change
        for (const t of threadElements) {
          if (!t.threadId || !t.snippet) continue;

          const prevSnippet = this.lastSeenSnippets.get(t.threadId);
          const currentThreadId = extractMessengerThreadId(observerPage.url());
          const hasTrigger = shouldInspectMessengerThread(
            currentThreadId,
            t.threadId,
            t.isUnread,
            prevSnippet,
            t.snippet
          );

          if (!hasTrigger) continue;

          // Inspect the current conversation or one whose sidebar state changed.
          if (currentThreadId !== t.threadId) {
            const clicked = await observerPage
              .locator('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')
              .evaluateAll((links, threadId) => {
                const link = links.find((candidate) => {
                  const href = candidate.getAttribute("href") || "";
                  return href.match(/\/messages\/(?:e2ee\/)?t\/([^/?#]+)/i)?.[1] === threadId;
                }) as HTMLElement | undefined;
                link?.click();
                return Boolean(link);
              }, t.threadId);

            const opened = clicked
              ? await observerPage
                  .waitForURL((url) => extractMessengerThreadId(url.toString()) === t.threadId, { timeout: 5000 })
                  .then(() => true)
                  .catch(() => false)
              : false;

            if (!opened) {
              const routePrefix = t.href.includes("/messages/e2ee/t/")
                ? "/messages/e2ee/t/"
                : "/messages/t/";
              await observerPage.goto(`https://www.facebook.com${routePrefix}${encodeURIComponent(t.threadId)}`, {
                waitUntil: "domcontentloaded",
                timeout: 45000,
              });
            }
            if (extractMessengerThreadId(observerPage.url()) !== t.threadId) {
              throw new Error(`Messenger did not open expected thread ${t.threadId}`);
            }
            await this.dismissOverlays(observerPage);
          }

          // Read real message bubbles from DOM
          const bubbleResult = await this.readBubblesFromPage(observerPage, {
            threadTitle: t.customerName,
            participantId: t.participantId,
          });

          if (bubbleResult.isDegraded) {
            await this.triggerDegradedDom(
              bubbleResult.degradedReason || "DOM bubble missing stable message id - suspending channel"
            );
            return;
          }

          if (bubbleResult.bubbles.length === 0 && (t.isUnread || prevSnippet !== t.snippet)) {
            console.warn(`[BrowserAdapter] No stable message bubbles found for changed thread ${t.threadId}.`);
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
              const routePrefix = t.href.includes("/messages/e2ee/t/")
                ? "/messages/e2ee/t/"
                : "/messages/t/";
              const fullThreadRef = `https://www.facebook.com${routePrefix}${encodeURIComponent(t.threadId)}`;

              const isVerifiedSender = Boolean(bubble.senderId && bubble.senderReliability === "VERIFIED");

              await this.inboundCallback({
                channelAccountId: this.channelAccountId,
                externalThreadId: t.threadId,
                externalThreadRef: fullThreadRef,
                // Never conflate externalThreadId with actual sender identity
                externalCustomerId: bubble.senderId ?? null,
                customerName:
                  bubbleResult.threadClassification?.kind === "GROUP"
                    ? t.customerName || null
                    : bubble.senderName || t.customerName || null,
                externalMessageId: bubble.id,
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
                senderDisplayName: bubble.senderName ?? null,
                participantIdentity: isVerifiedSender
                  ? {
                      channelAccountId: this.channelAccountId,
                      participantId: bubble.senderId!,
                      senderKind: bubble.senderKind ?? "PERSON",
                      isVerified: true,
                      profileUrl: bubble.senderProfileUrl ?? null,
                      displayName: bubble.senderName ?? null,
                      verifiedAt: new Date(),
                      metadata: {},
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

          this.lastSeenSnippets.set(t.threadId, t.snippet);
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
          this.observeTimer = setTimeout(poll, OBSERVER_POLL_INTERVAL_MS);
        }
      }
    };

    this.observeTimer = setTimeout(poll, 1000);
  }

  /**
   * Reads message bubbles from a page, extracting stable identity, sender, thread type, mentions, and timestamps.
   */
  private async readBubblesFromPage(
    page: Page,
    hints?: { threadTitle?: string; participantId?: string | null }
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

          for (let index = 0; index < sourceElements.length; index++) {
            const source = sourceElements[index] as HTMLElement;
            const target = clonedElements[index] as HTMLElement | undefined;
            if (!target) continue;

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
                    break;
                  }
                  continue;
                }

                if (!item.value || typeof item.value !== "object" || item.depth >= 4) continue;
                if (visited.has(item.value)) continue;
                visited.add(item.value);

                for (const child of Object.values(item.value as Record<string, unknown>)) {
                  pending.push({ value: child, depth: item.depth + 1 });
                }
              }

              if (target.hasAttribute("data-message-id")) break;
            }
          }

          return clone.outerHTML;
        });
        return parseMessengerBubblesFromHtml(html, {
          observedAt: new Date(),
          timeZone: this.activeContextTimeZone,
          botChannelAccountId: this.channelAccountId,
          botParticipantId: this.botParticipantId,
          botProfileUrl: this.botProfileUrl,
          threadTitleHint: hints?.threadTitle,
          senderParticipantIdHint: hints?.participantId ?? undefined,
        });
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
    const senderPage = await this.ensureSenderPage();
    const threadId = extractMessengerThreadId(threadRef) || threadRef;

    const currentUrl = senderPage.url();
    if (!currentUrl.includes(threadId)) {
      const targetUrl = threadRef.startsWith("http")
        ? new URL(threadRef, "https://www.facebook.com").toString()
        : `https://www.facebook.com/messages/t/${threadId}`;

      console.log(`[BrowserAdapter] Sender opening conversation: ${targetUrl}`);
      try {
        await senderPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (err) {
        console.warn(`[BrowserAdapter] Sender navigation failed for ${targetUrl}:`, err);
        return false;
      }
    }

    await this.dismissOverlays(senderPage);

    // Wait for composer textbox to be visible
    try {
      await senderPage.waitForSelector('div[role="textbox"][contenteditable="true"]', {
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
    const isContextAlive = Boolean(
      this.context &&
      this.observerPage &&
      !this.observerPage.isClosed()
    );
    const isObserverFresh = Boolean(
      this.lastSuccessfulPollAt && Date.now() - this.lastSuccessfulPollAt.getTime() <= OBSERVER_STALE_AFTER_MS
    );
    const healthy = isContextAlive && isObserverFresh && !this.isDomDegraded && !this.sessionIssue;

    return {
      healthy,
      status: this.isDomDegraded || this.sessionIssue ? "DEGRADED" : healthy ? "RUNNING" : "SUSPENDED",
      domOk: !this.isDomDegraded && this.sessionIssue?.kind !== "INBOX_UNAVAILABLE",
      sessionActive: isContextAlive && !this.sessionIssue,
      checkpointDetected: this.sessionIssue?.kind === "CHECKPOINT",
      rateLimitDetected: false,
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
