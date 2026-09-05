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
      return json({
        channelStatus: "RUNNING",
        channelIsPaused: false,
        channelIsSuspended: false,
        queueLength: 1,
        openIncidentsCount: 1,
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
        messages: [{ id: "message-1", direction: "INBOUND", text: "Xin chào shop", createdAt: now }],
        aiRuns: [],
        outboundActions: [],
        events: [],
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
      return json({
        aiProvider: {
          apiFormat: "ANTHROPIC_COMPATIBLE",
          baseUrl: "https://api.anthropic.example/v1",
          model: "claude-sonnet-test",
          apiKeyConfigured: true,
        },
      });
    }
    if (path === "/api/settings") {
      return json({
        settings: {
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
        },
        aiProvider: {
          apiFormat: "OPENAI_COMPATIBLE",
          baseUrl: "https://gateway.example/v1",
          model: "auto/best-chat",
          apiKeyConfigured: true,
        },
        revision: 2,
      });
    }
    if (path === "/api/audit") return json({ items: [], hasMore: false, nextCursor: null });
    if (path === "/api/channel/pause" || path === "/api/channel/resume") return json({ success: true });
    return json({});
  });
}

async function waitForRoute(page: Page, route: string): Promise<void> {
  await page.locator("main").waitFor();
  switch (route) {
    case "overview":
      await page.getByRole("heading", { name: "Tổng quan hệ thống" }).waitFor();
      await page.getByText("Hội thoại hôm nay").waitFor();
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

  await page.goto(`${baseURL}/settings`);
  await waitForRoute(page, "settings");
  const settingsText = await page.locator("main").innerText();
  assert(settingsText.includes("Loại dịch vụ AI"), `${name}: missing customer-friendly AI provider format label`);
  assert(settingsText.includes("Địa chỉ dịch vụ"), `${name}: missing customer-friendly address label`);
  assert(settingsText.includes("Tên mô hình"), `${name}: missing customer-friendly model label`);
  assert(settingsText.includes("Mật khẩu kết nối"), `${name}: missing customer-friendly write-only credential label`);
  assert(!settingsText.includes("Base URL"), `${name}: raw 'Base URL' exposed in Settings view`);

  await page.locator("select").filter({ has: page.locator('option[value="OPENAI_COMPATIBLE"]') }).selectOption("ANTHROPIC_COMPATIBLE");
  await page.locator('input[type="url"]').fill("https://api.anthropic.example/v1");
  await page.locator('input[placeholder*="claude-sonnet"]').fill("claude-sonnet-test");
  await page.locator('input[type="password"]').fill("test-secret-key");
  await page.getByRole("button", { name: "Kiểm tra kết nối AI" }).click();
  await page.getByText("Sẵn sàng (Healthy)").waitFor();
  await page.getByRole("button", { name: "Lưu cấu hình" }).click();
  await page.getByText(/Đã lưu cấu hình mới thành công/).waitFor();

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
    { stdio: "ignore", shell: process.platform === "win32" }
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
