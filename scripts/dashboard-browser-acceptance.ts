import { spawn } from "node:child_process";
import { chromium, devices, type Browser, type Page } from "../apps/browser-agent/node_modules/playwright/index.mjs";

const baseURL = process.env.DASHBOARD_URL || "http://127.0.0.1:4173";
const now = new Date().toISOString();
const conversationId = "11111111-1111-4111-8111-111111111111";
const identity = { id: "user-1", email: "admin@example.com", name: "Owner", role: "OWNER" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function mockApi(page: Page): Promise<void> {
  let manualMode = false;
  let currentProvider = {
    apiFormat: "OPENAI_COMPATIBLE",
    baseUrl: "https://gateway.example/v1",
    model: "auto/best-chat",
    apiKeyConfigured: true,
  };
  let currentSettings = {
    debounceMs: 3000,
    stickyWindowMs: 45000,
    stickyMaxTurns: 3,
    stickyMaxDurationMs: 120000,
    aiModel: "auto/best-chat",
    aiTimeoutMs: 20000,
    aiMaxResponseCount: 3,
    aiTotalMaxChars: 480,
    aiSystemPersona: "Nhân viên chăm sóc khách hàng",
    businessProfile: "Shop trực tuyến",
    typingTargetWpmMin: 55,
    typingTargetWpmMax: 65,
    busyMode: false,
    autoReplyEnabled: true,
    pauseIntakeProcessing: false,
  };
  let revision = 2;
  let channelPaused = false;
  await page.route("**/events", async (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/auth/me") return json({ user: identity });
    if (path === "/api/auth/login") return json({ success: true, user: identity });
    if (path === "/api/auth/logout") return json({ ok: true });
    if (path === "/api/events") return route.abort();
    if (path === "/api/overview") {
      if (channelPaused) {
        return json({
          channelStatus: "RUNNING",
          channelStatusReason: null,
          channelIsPaused: true,
          channelIsSuspended: false,
          channelLastHealthCheckAt: now,
          channelLastSeenActiveAt: now,
          queueLength: 1,
          openIncidentsCount: 0,
          todayConversationsCount: 3,
          todayMessagesCount: 5,
          messagesToday: 3,
          aiRepliesToday: 2,
          averageLatencyMs: 420,
          activeConversation: null,
        });
      }
      return json({
        channelStatus: "DEGRADED",
        channelStatusReason: "LOGIN_REQUIRED: Phiên Facebook đã hết hạn",
        channelIsPaused: false,
        channelIsSuspended: true,
        channelLastHealthCheckAt: now,
        channelLastSeenActiveAt: now,
        queueLength: 1,
        openIncidentsCount: 1,
        todayConversationsCount: 3,
        todayMessagesCount: 5,
        messagesToday: 3,
        aiRepliesToday: 2,
        averageLatencyMs: 420,
        activeConversation: null,
      });
    }
    if (path === "/api/inbox") {
      const items = [
        {
          conversation: { id: conversationId, status: "WAITING", manualMode, inboundVersion: 1, updatedAt: now },
          customer: { name: "Khách thử nghiệm", externalCustomerId: "customer-1" },
          latestInboundMessage: {
            text: "Cần tư vấn mẫu áo",
            parts: [{ type: "IMAGE", media: { mediaId: "m-1" } }],
            timestamp: now,
          },
        },
      ];
      return json({
        items,
        conversations: items,
        hasMore: false,
        nextCursor: null,
      });
    }
    if (path === `/api/inbox/${conversationId}`) {
      return json({
        conversation: { id: conversationId, status: "WAITING", manualMode, inboundVersion: 1 },
        customer: { name: "Khách thử nghiệm" },
        messages: [
          {
            id: "message-1",
            direction: "INBOUND",
            text: "Xin chào shop, mình muốn hỏi sản phẩm này",
            parts: [
              { type: "TEXT", text: "Xin chào shop, mình muốn hỏi sản phẩm này" },
              { type: "IMAGE", altText: "Sin Sin", media: { mediaId: "img-1" } },
              { type: "IMAGE", media: { mediaId: "img-2", sourceUrl: "https://example.com/test.jpg" } },
              { type: "VOICE", media: { mediaId: "v-1", durationMs: 12000 }, transcriptRef: "tr-1" },
            ],
            contentStatus: "READY",
            contentRevision: 1,
            time: {
              source: "FACEBOOK_EVENT",
              precision: "MINUTE",
              eventAt: now,
            },
            replyDecision: {
              action: "GENERATE",
              reasonCode: "ELIGIBLE",
              displayLabel: "AI tạo phản hồi",
            },
            createdAt: now,
            timestamp: now,
          },
        ],
        aiRuns: [],
        outboundActions: [],
        events: [
          { id: "event-takeover", type: "MANUAL_TAKEOVER", actor: "HUMAN_MESSENGER", createdAt: new Date(Date.parse(now) - 2000).toISOString() },
          { id: "event-human-activity", type: "MANUAL_TAKEOVER", actor: "HUMAN_MESSENGER", createdAt: new Date(Date.parse(now) - 1000).toISOString() },
        ],
        hasMoreMessages: false,
        nextMessageCursor: null,
      });
    }
    if (path.endsWith("/takeover")) {
      manualMode = true;
      return json({ success: true, cancelAck: true, manualMode: true });
    }
    if (path.endsWith("/release")) {
      manualMode = false;
      return json({ success: true });
    }
    if (path.endsWith("/send")) return json({ success: true, outboundActionId: "action-1" });
    if (path === "/api/queue") return json({ items: [], hasMore: false, nextCursor: null });
    if (path === "/api/incidents") return json({ items: [], hasMore: false, nextCursor: null });
    if (path === "/api/ai-runs") return json({ items: [], hasMore: false, nextCursor: null });
    if (path === "/api/ai-runs/test") return json({ success: true, response: "ok" });
    if (path === "/api/settings/test-ai") return json({ healthy: true, status: "healthy", model: "auto/best-chat", latencyMs: 120 });
    if (path === "/api/settings/ai-provider") {
      if (request.method() === "PUT") {
        const body = (request.postDataJSON() || {}) as { apiFormat?: string; baseUrl?: string; model?: string };
        currentProvider = {
          ...currentProvider,
          ...body,
          apiKeyConfigured: true,
        };
      }
      return json({ aiProvider: currentProvider });
    }
    if (path === "/api/settings") {
      if (request.method() === "POST") {
        const body = (request.postDataJSON() || {}) as Record<string, unknown>;
        revision += 1;
        currentSettings = { ...currentSettings, ...body };
        return json({
          settings: currentSettings,
          revision,
        });
      }
      return json({
        settings: currentSettings,
        aiProvider: currentProvider,
        revision,
      });
    }
    if (path === "/api/audit") return json({ items: [], hasMore: false, nextCursor: null });
    if (path === "/api/people") {
      const q = new URL(request.url()).searchParams.get("q") || "";
      if (q.includes("notfound")) {
        return json({ people: [] });
      }
      return json({
        people: [
          {
            id: "ppl_test123",
            name: "Nguyễn Văn A",
            type: "USER",
            avatarUrl: null,
            conversationContext: "Hội thoại thử nghiệm",
          },
        ],
      });
    }
    if (path === "/api/channel/pause") {
      const headers = request.headers();
      if (headers["content-type"] && headers["content-type"].includes("application/json")) {
        return json({ error: "FST_ERR_CTP_EMPTY_JSON_BODY: Body cannot be empty when content-type is set to 'application/json'" }, 400);
      }
      channelPaused = true;
      return json({ success: true });
    }
    if (path === "/api/channel/resume") {
      const headers = request.headers();
      if (headers["content-type"] && headers["content-type"].includes("application/json")) {
        return json({ error: "FST_ERR_CTP_EMPTY_JSON_BODY: Body cannot be empty when content-type is set to 'application/json'" }, 400);
      }
      channelPaused = false;
      return json({ success: true });
    }
    return json({});
  });
}

async function waitForRoute(page: Page, route: string, isPaused = false): Promise<void> {
  await page.locator("main").waitFor();
  switch (route) {
    case "overview":
      await page.getByRole("heading", { name: "Tổng quan hệ thống" }).waitFor();
      await page.getByText("Hội thoại hôm nay").waitFor();
      if (isPaused) {
        await page.locator('[data-testid="channel-paused-banner"]').waitFor();
      } else {
        await page.getByRole("alert").getByText("Messenger đang không nhận tin nhắn").waitFor();
        await page.getByRole("link", { name: "Xem cách xử lý" }).waitFor();
      }
      break;
    case "inbox":
      await page.getByRole("heading", { name: "Hộp thư khách hàng" }).waitFor();
      await page.getByText("Khách thử nghiệm").first().waitFor();
      break;
    case "queue":
      await page.getByRole("heading", { name: "Quản lý hàng đợi xử lý" }).waitFor();
      await page.getByText("Không có tác vụ nào theo bộ lọc đã chọn!").waitFor();
      break;
    case "incidents":
      await page.getByRole("heading", { name: "Quản lý sự cố & Giám sát an toàn" }).waitFor();
      await page.getByText("Không có sự cố nào cần xử lý").waitFor();
      break;
    case "ai-logs":
      await page.getByRole("heading", { name: "Nhật ký hoạt động AI" }).waitFor();
      await page.getByText("Không tìm thấy lượt xử lý AI nào phù hợp bộ lọc.").waitFor();
      break;
    case "settings":
      await page.getByRole("heading", { name: "Cài đặt hệ thống & Chính sách phản hồi" }).waitFor();
      await page.getByText("Loại dịch vụ AI").waitFor();
      await page.getByText(/Phiên bản cấu hình:\s*v2/).waitFor();
      break;
    case "audit":
      await page.getByRole("heading", { name: "Nhật ký hoạt động" }).waitFor();
      await page.getByText("Không có sự kiện kiểm toán nào").waitFor();
      break;
  }
}

async function exercise(browser: Browser, name: string, viewport: { width: number; height: number }): Promise<void> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await mockApi(page);

  for (const route of ["overview", "inbox", "queue", "incidents", "ai-logs", "settings", "audit"]) {
    const response = await page.goto(`${baseURL}/${route}`);
    assert(response?.ok(), `${name}: ${route} returned ${response?.status()}`);
    await waitForRoute(page, route);
  }

  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  assert(!bodyText.includes("novnc"), `${name}: public noVNC control is visible`);

  await page.goto(`${baseURL}/overview`);
  await waitForRoute(page, "overview");
  const overviewText = await page.locator("main").innerText();
  assert(overviewText.includes("Tổng quan hệ thống"), `${name}: missing overview title`);
  assert(overviewText.includes("Hội thoại hôm nay"), `${name}: missing friendly conversation metric`);

  const pauseResponsePromise = page.waitForResponse((res) => res.url().includes("/api/channel/pause"));
  await page.getByRole("button", { name: "Tạm dừng" }).click();
  const pauseResponse = await pauseResponsePromise;
  assert(pauseResponse.status() === 200, `${name}: pause action returned ${pauseResponse.status()} instead of 200`);

  // Verify derived channel status consistency in Layout header while paused
  await page.getByRole("button", { name: "Tiếp tục" }).waitFor();
  await page.getByText("Kênh: Tạm dừng").waitFor();

  // Reload/navigate to overview to test reload / container restart persistence
  await page.goto(`${baseURL}/overview`);
  await waitForRoute(page, "overview", true);
  assert(await page.getByRole("button", { name: "Tiếp tục" }).isVisible(), `${name}: resume button not visible after reload`);
  assert(await page.getByText("Kênh: Tạm dừng").isVisible(), `${name}: derived paused status not visible after reload`);

  await page.goto(`${baseURL}/settings`);
  await waitForRoute(page, "settings");

  // Verify people search waiting feedback & empty state UX
  const searchInput = page.locator('input[placeholder*="Tìm kiếm người dùng"]');
  assert(await searchInput.isVisible(), `${name}: people search input not visible in settings`);
  await searchInput.fill("notfound");
  await page.getByRole("button", { name: "Tìm" }).click();
  await page.locator('[data-testid="people-search-empty"]').waitFor();
  assert(
    (await page.locator('[data-testid="people-search-empty"]').innerText()).includes('Không tìm thấy người dùng phù hợp với "notfound"'),
    `${name}: missing empty search feedback`
  );

  await searchInput.fill("Nguyễn");
  await page.getByRole("button", { name: "Tìm" }).click();
  await page.locator('[data-testid="people-search-results"]').waitFor();
  assert(
    (await page.locator('[data-testid="people-search-results"]').innerText()).includes("Nguyễn Văn A"),
    `${name}: missing search results list`
  );

  // Resume channel and verify consistent active state
  const resumeResponsePromise = page.waitForResponse((res) => res.url().includes("/api/channel/resume"));
  await page.getByRole("button", { name: "Tiếp tục" }).click();
  const resumeResponse = await resumeResponsePromise;
  assert(resumeResponse.status() === 200, `${name}: resume action returned ${resumeResponse.status()} instead of 200`);
  await page.getByRole("button", { name: "Tạm dừng" }).waitFor();
  const settingsText = await page.locator("main").innerText();
  assert(settingsText.includes("Loại dịch vụ AI"), `${name}: missing customer-friendly AI provider format label`);
  assert(settingsText.includes("Địa chỉ dịch vụ"), `${name}: missing customer-friendly address label`);
  assert(settingsText.includes("Tên mô hình"), `${name}: missing customer-friendly model label`);
  assert(settingsText.includes("API key"), `${name}: missing API key label`);
  assert(!settingsText.includes("Base URL"), `${name}: raw 'Base URL' exposed in Settings view`);

  await page.locator("select").filter({ has: page.locator('option[value="OPENAI_COMPATIBLE"]') }).selectOption("ANTHROPIC_COMPATIBLE");
  await page.locator('input[type="url"]').fill("https://api.anthropic.example/v1");
  await page.locator('input[placeholder*="claude-sonnet"]').fill("claude-sonnet-test");
  await page.locator('input[type="password"]').fill("test-secret-key");
  await page.getByRole("button", { name: "Kiểm tra kết nối AI" }).click();
  await page.getByText("Sẵn sàng (Healthy)").waitFor();
  await page.getByRole("button", { name: "Lưu cấu hình" }).click();
  await page.getByText(/Đã lưu cấu hình mới thành công/).waitFor();
  assert(await page.getByText("Loại dịch vụ AI").isVisible(), `${name}: provider controls not visible after save`);
  assert(await page.locator('input[type="url"]').isVisible(), `${name}: provider baseUrl not visible after save`);
  assert(errors.length === 0, `${name}: errors after saving settings: ${errors.join("; ")}`);
  await page.goto(`${baseURL}/incidents`);
  await waitForRoute(page, "incidents");
  const incidentsText = await page.locator("main").innerText();
  assert(incidentsText.includes("Quản lý sự cố & Giám sát an toàn"), `${name}: missing customer-friendly incident title`);
  assert(!incidentsText.includes("fail-closed"), `${name}: raw internal jargon 'fail-closed' exposed`);
  assert(!incidentsText.includes("Circuit Breakers"), `${name}: raw 'Circuit Breakers' jargon exposed`);

  await page.goto(`${baseURL}/queue`);
  await waitForRoute(page, "queue");
  const queueText = await page.locator("main").innerText();
  assert(!queueText.includes("fencingEpoch"), `${name}: raw technical token 'fencingEpoch' visible in normal queue view`);

  await page.goto(`${baseURL}/audit`);
  await waitForRoute(page, "audit");
  const auditText = await page.locator("main").innerText();
  assert(auditText.includes("Nhật ký hoạt động"), `${name}: missing friendly audit title`);
  assert(!auditText.includes("Audit Trail"), `${name}: raw 'Audit Trail' jargon exposed`);

  await page.goto(`${baseURL}/inbox/${conversationId}`);
  await page.getByText("Khách thử nghiệm").first().waitFor();
  await page.getByText("Chi tiết kỹ thuật").waitFor();
  const convDetailText = await page.locator("main").innerText();
  assert(convDetailText.includes("Chi tiết kỹ thuật"), `${name}: missing collapsible technical details block`);
  assert(!convDetailText.includes("Inbound Version:"), `${name}: raw 'Inbound Version:' exposed in default detail view`);
  assert(convDetailText.includes("Tin nhắn thoại"), `${name}: missing rich voice component in conversation detail`);
  assert(convDetailText.includes("AI tạo phản hồi"), `${name}: missing decision badge in conversation detail`);
  assert(convDetailText.includes("Nhân viên bắt đầu hỗ trợ — bot tạm dừng"), `${name}: missing manual-support state marker`);
  assert(!convDetailText.includes("HUMAN_MESSENGER"), `${name}: technical Messenger actor is visible`);
  assert((convDetailText.match(/Nhân viên bắt đầu hỗ trợ — bot tạm dừng/g) || []).length === 1, `${name}: repeated manual-support state marker`);
  assert(convDetailText.includes("Không thể tải hình ảnh"), `${name}: missing explicit unavailable-image state`);
  assert(!convDetailText.includes("Quyết định: Bỏ qua (Hội thoại đang ở chế độ nhân viên hỗ trợ trực tiếp.)"), `${name}: repeated manual-support skip is still visible`);

  await page.getByRole("button", { name: /tiếp quản thủ công/i }).click();
  const composer = page.locator('input[placeholder*="Nhập tin nhắn"]').first();
  await composer.fill("Phản hồi thủ công đã kiểm tra");
  await page.getByRole("button", { name: /^Gửi$/i }).click();

  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(dimensions.scrollWidth <= dimensions.width + 1, `${name}: horizontal overflow ${dimensions.scrollWidth}/${dimensions.width}`);
  assert(errors.length === 0, `${name}: page errors: ${errors.join("; ")}`);
  await context.close();
  console.log(`${name}: passed`);
}

async function waitForDashboard(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch {
      // Preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Dashboard preview did not start at ${baseURL}`);
}

async function main(): Promise<void> {
  const preview = spawn(
    process.execPath,
    ["run", "--filter=@messenger/dashboard", "preview", "--", "--host", "127.0.0.1", "--port", "4173"],
    { stdio: "inherit", shell: process.platform === "win32" }
  );

  let browser: Browser | undefined;
  try {
    await waitForDashboard();
    browser = await chromium.launch({ headless: true });
    await exercise(browser, "desktop", devices["Desktop Chrome"].viewport!);
    await exercise(browser, "mobile", devices["Pixel 7"].viewport!);
  } finally {
    await browser?.close();
    preview.kill();
    if (process.platform === "win32" && preview.pid) {
      try {
        spawn("taskkill", ["/pid", preview.pid.toString(), "/t", "/f"]);
      } catch {
        // Ignored
      }
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
