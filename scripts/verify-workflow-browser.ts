import { spawn } from "node:child_process";
import { chromium, type Browser, type Page } from "../apps/browser-agent/node_modules/playwright/index.mjs";

const baseURL = process.env.DASHBOARD_URL || "http://127.0.0.1:4173";
const now = new Date().toISOString();
const identity = { id: "user-1", email: "admin@example.com", name: "Owner", role: "OWNER" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const demoRecords: Record<string, any> = {
  "conv-mai-anh": {
    conversation: {
      id: "conv-mai-anh",
      channelAccountId: "demo-shop",
      inboundVersion: 18,
      status: "TYPING",
      lastInboundAt: now,
      lastOutboundAt: null,
      isBlocked: false,
      manualMode: false,
      unreadCount: 1,
      title: "Mai Anh",
    },
    customer: { id: "customer-mai-anh", name: "Mai Anh", avatarUrl: null },
    messages: [
      {
        id: "msg-mai-anh",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Shop còn mẫu váy này màu kem, size M không ạ?",
        inboundVersion: 18,
        responseIndex: 0,
        timestamp: now,
        skipReason: {
          decision: "ELIGIBLE",
          eligible: true,
          reasonCode: "ELIGIBLE",
          humanReadableReason: "Được phép trả lời tự động",
          reason: "",
          precedenceStep: "ELIGIBLE",
        },
      },
    ],
    events: [
      { id: "e1", type: "INBOUND_RECEIVED", inboundVersion: 18, actor: "CUSTOMER", payload: {}, createdAt: now },
      { id: "e2", type: "DEBOUNCE_STARTED", inboundVersion: 18, actor: "BROWSER_AGENT", payload: {}, createdAt: now },
      { id: "e3", type: "AI_STARTED", inboundVersion: 18, actor: "AI_WORKER", payload: {}, createdAt: now },
      { id: "e4", type: "DRAFT_CREATED", inboundVersion: 18, actor: "AI_WORKER", payload: {}, createdAt: now },
      { id: "e5", type: "TYPING_STARTED", inboundVersion: 18, actor: "AI", payload: {}, createdAt: now },
    ],
    aiRuns: [
      {
        id: "run-mai-anh-12345678",
        channelAccountId: "demo-shop",
        conversationId: "conv-mai-anh",
        inboundVersion: 18,
        model: "shop-assistant",
        promptTokens: 1128,
        completionTokens: 186,
        totalTokens: 1314,
        latencyMs: 1840,
        status: "SUCCESS",
        createdAt: now,
        requestSnapshot: { contextManifest: { selectedCount: 8, estimatedTokens: 1100 } },
        usedResult: {
          messages: [
            "Dạ, shop kiểm tra đúng mẫu và màu kem giúp mình nhé.",
            "Bạn gửi shop hình hoặc mã mẫu váy mình đang xem được không ạ?",
          ],
          needsClarification: true,
        },
        parsedOutput: { messageCount: 2 },
        errorMessage: null,
      },
    ],
    outboundActions: [
      {
        id: "act-1",
        actionId: "action-mai-anh-1",
        inboundVersion: 18,
        responseIndex: 0,
        text: "Dạ, shop kiểm tra đúng mẫu và màu kem giúp mình nhé.",
        actor: "AI",
        status: "TYPING",
        unconfirmedReason: null,
        errorMessage: null,
        createdAt: now,
      },
      {
        id: "act-2",
        actionId: "action-mai-anh-2",
        inboundVersion: 18,
        responseIndex: 1,
        text: "Bạn gửi shop hình hoặc mã mẫu váy mình đang xem được không ạ?",
        actor: "AI",
        status: "PENDING",
        unconfirmedReason: null,
        errorMessage: null,
        createdAt: now,
      },
    ],
  },
  "conv-hoang-nam": {
    conversation: {
      id: "conv-hoang-nam",
      channelAccountId: "demo-shop",
      inboundVersion: 12,
      status: "ERROR",
      lastInboundAt: now,
      lastOutboundAt: null,
      isBlocked: false,
      manualMode: false,
      unreadCount: 1,
      title: "Hoàng Nam",
    },
    customer: { id: "customer-hoang-nam", name: "Hoàng Nam", avatarUrl: null },
    messages: [
      {
        id: "msg-hoang-nam",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Shop kiểm tra giúp mình đơn hôm qua với nhé.",
        inboundVersion: 12,
        responseIndex: 0,
        timestamp: now,
        skipReason: {
          decision: "ELIGIBLE",
          eligible: true,
          reasonCode: "ELIGIBLE",
          humanReadableReason: "Được phép trả lời tự động",
          reason: "",
          precedenceStep: "ELIGIBLE",
        },
      },
    ],
    events: [
      { id: "e-hn-1", type: "INBOUND_RECEIVED", inboundVersion: 12, actor: "CUSTOMER", payload: {}, createdAt: now },
      { id: "e-hn-2", type: "SEND_UNCERTAIN", inboundVersion: 12, actor: "BROWSER_AGENT", payload: {}, createdAt: now },
    ],
    aiRuns: [],
    outboundActions: [
      {
        id: "act-hn-1",
        actionId: "action-hn-1",
        inboundVersion: 12,
        responseIndex: 0,
        text: "Dạ vâng, shop đang kiểm tra đơn của anh ạ.",
        actor: "AI",
        status: "SEND_UNCERTAIN",
        unconfirmedReason: "Không chắc tin đã vào chat box",
        errorMessage: null,
        createdAt: now,
      },
    ],
  },
};

async function setupMockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me") return json({ user: identity });
    if (path === "/api/overview") {
      return json({
        channelStatus: "RUNNING",
        channelIsPaused: false,
        channelIsSuspended: false,
        queueLength: 1,
        openIncidentsCount: 0,
        todayConversationsCount: 5,
        todayMessagesCount: 12,
        businessTimeZone: "Asia/Ho_Chi_Minh",
      });
    }

    if (path === "/api/inbox") {
      const items = [
        {
          conversation: demoRecords["conv-mai-anh"].conversation,
          customer: demoRecords["conv-mai-anh"].customer,
          latestInboundMessage: { text: "Shop còn mẫu váy này màu kem, size M không ạ?", timestamp: now },
        },
        {
          conversation: demoRecords["conv-hoang-nam"].conversation,
          customer: demoRecords["conv-hoang-nam"].customer,
          latestInboundMessage: { text: "Shop kiểm tra giúp mình đơn hôm qua với nhé.", timestamp: now },
        },
      ];
      return json({
        conversations: items,
        total: items.length,
        limit: 50,
        offset: 0,
        hasMore: false,
        nextCursor: null,
      });
    }

    if (path.startsWith("/api/inbox/")) {
      const convId = decodeURIComponent(path.replace("/api/inbox/", ""));
      const record = demoRecords[convId] || demoRecords["conv-mai-anh"];
      return json(record);
    }

    return json({ ok: true });
  });

  await page.route("**/events", async (route) => {
    return route.abort();
  });
}

async function waitForDashboard(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch {
      // Still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Dashboard preview did not start at ${baseURL}`);
}

async function main() {
  const preview = spawn(
    process.execPath,
    ["run", "--filter=@messenger/dashboard", "preview", "--", "--host", "127.0.0.1", "--port", "4173"],
    { stdio: "ignore", shell: process.platform === "win32" }
  );

  let browser: Browser | undefined;

  try {
    await waitForDashboard();
    browser = await chromium.launch({ headless: true });

    // 1. Test Desktop (1440x900)
    console.log("[Test] Running Desktop verification (1440x900)...");
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktopPage = await desktopContext.newPage();
    const consoleErrors: string[] = [];
    desktopPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await setupMockApi(desktopPage);
    await desktopPage.goto(`${baseURL}/workflow`, { waitUntil: "networkidle" });

    // Assert Header
    const heading = await desktopPage.textContent(".wf-heading h1");
    assert(heading?.includes("Theo dõi trả lời"), "Workflow heading must be 'Theo dõi trả lời'");

    // Assert 3 Stats cards
    const statsCount = await desktopPage.locator(".wf-stat").count();
    assert(statsCount === 3, `Expected 3 stat cards, got ${statsCount}`);

    // Assert Conversations in sidebar
    await desktopPage.waitForSelector(".wf-person");
    const personCount = await desktopPage.locator(".wf-person").count();
    assert(personCount >= 2, `Expected at least 2 conversations, got ${personCount}`);

    // Assert 6 stages
    const stageCount = await desktopPage.locator(".wf-stage").count();
    assert(stageCount === 6, `Expected 6 stages, got ${stageCount}`);

    // Test clicking stage "ai"
    await desktopPage.click('.wf-stage:has-text("AI trả lời")');
    const inspectorTitle = await desktopPage.textContent(".wf-inspector h2");
    assert(inspectorTitle?.includes("AI trả lời"), "Inspector title should show 'AI trả lời'");

    // Test clicking stage "typing"
    await desktopPage.click('.wf-stage:has-text("Soạn tin")');
    const inspectorTitleTyping = await desktopPage.textContent(".wf-inspector h2");
    assert(inspectorTitleTyping?.includes("Soạn tin"), "Inspector title should show 'Soạn tin'");

    // Test switching tabs: "Nhật ký theo thời gian"
    await desktopPage.click('.wf-tab:has-text("Nhật ký theo thời gian")');
    const timelineItems = await desktopPage.locator(".wf-timeline li").count();
    assert(timelineItems >= 3, `Expected at least 3 timeline items, got ${timelineItems}`);

    // Test switching tabs back to "Tin nhắn & câu trả lời"
    await desktopPage.click('.wf-tab:has-text("Tin nhắn & câu trả lời")');
    const messageBubbles = await desktopPage.locator(".wf-bubble").count();
    assert(messageBubbles >= 2, `Expected at least 2 message bubbles, got ${messageBubbles}`);

    // Test search filter
    await desktopPage.fill('.wf-search input', "Hoàng Nam");
    const filteredCount = await desktopPage.locator(".wf-person").count();
    assert(filteredCount === 1, `Expected 1 person for search 'Hoàng Nam', got ${filteredCount}`);
    await desktopPage.fill('.wf-search input', "");

    // Test clicking on Hoàng Nam (uncertain send)
    await desktopPage.click('.wf-person:has-text("Hoàng Nam")');
    await desktopPage.waitForSelector('.wf-current-title:has-text("Cần xác nhận kết quả gửi")');
    const uncertainTitle = await desktopPage.textContent(".wf-current-title");
    assert(uncertainTitle?.includes("Cần xác nhận kết quả gửi"), "Hoàng Nam view should show 'Cần xác nhận kết quả gửi'");

    // Test pause button
    const pauseBtnTextBefore = await desktopPage.textContent('.wf-toolbar button:has-text("Dừng cập nhật")');
    assert(pauseBtnTextBefore?.includes("Dừng cập nhật"), "Should have 'Dừng cập nhật' button");
    await desktopPage.click('.wf-toolbar button:has-text("Dừng cập nhật")');
    const resumeBtnText = await desktopPage.textContent('.wf-toolbar button:has-text("Tiếp tục cập nhật")');
    assert(resumeBtnText?.includes("Tiếp tục cập nhật"), "Should toggle to 'Tiếp tục cập nhật'");

    // Take desktop screenshot
    await desktopPage.screenshot({ path: "workflow-desktop-verified.png", fullPage: true });
    console.log("✓ Desktop verification passed! Screenshot saved to workflow-desktop-verified.png");
    await desktopContext.close();

    // 2. Test Mobile (390x844) matching workflow-mobile.png
    console.log("[Test] Running Mobile verification (390x844)...");
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    await setupMockApi(mobilePage);
    await mobilePage.goto(`${baseURL}/workflow`, { waitUntil: "networkidle" });

    // Verify 1-column layout
    await mobilePage.waitForSelector(".wf-workspace");
    const mobileStageCount = await mobilePage.locator(".wf-stage").count();
    assert(mobileStageCount === 6, `Expected 6 stages in mobile, got ${mobileStageCount}`);

    // Verify stage text visible in vertical stack
    const firstStageLabel = await mobilePage.textContent(".wf-stage strong");
    assert(firstStageLabel?.includes("Nhận tin"), "First stage label should be 'Nhận tin'");

    // Verify no horizontal overflow
    const hasHorizontalOverflow = await mobilePage.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    assert(!hasHorizontalOverflow, "Mobile view must not have horizontal scrollbar overflow");

    // Take mobile screenshot
    await mobilePage.screenshot({ path: "workflow-mobile-verified.png", fullPage: true });
    console.log("✓ Mobile verification passed! Screenshot saved to workflow-mobile-verified.png");
    await mobileContext.close();

    console.log("ALL WORKFLOW BROWSER VERIFICATIONS PASSED 100%!");
  } finally {
    await browser?.close();
    preview.kill();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
