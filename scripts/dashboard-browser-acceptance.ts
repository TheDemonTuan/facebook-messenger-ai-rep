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
      return json({
        items: [
          {
            conversation: { id: conversationId, status: "WAITING", manualMode, inboundVersion: 1, updatedAt: now },
            customer: { name: "Khách thử nghiệm", externalCustomerId: "customer-1" },
          },
        ],
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
    if (path === "/api/settings") {
      return json({
        settings: {
          debounceSeconds: 3,
          wpm: 45,
          maxReplyChars: 1000,
          contextMessageCount: 20,
          businessName: "Shop thử nghiệm",
          systemPrompt: "Trả lời ngắn gọn",
          aiModel: "grok-4.5",
        },
        revision: 1,
        aiHealth: { configured: true, healthy: true, model: "grok-4.5" },
      });
    }
    if (path === "/api/audit") return json({ items: [], hasMore: false, nextCursor: null });
    if (path === "/api/channel/pause" || path === "/api/channel/resume") return json({ success: true });
    return json({});
  });
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
    await page.locator("main").waitFor();
  }

  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  assert(!bodyText.includes("novnc"), `${name}: public noVNC control is visible`);
  assert(!(await page.locator('input[name*="apiKey" i], input[placeholder*="API Key" i]').count()), `${name}: xAI secret input is visible`);

  await page.goto(`${baseURL}/inbox/${conversationId}`);
  await page.getByText("Khách thử nghiệm").first().waitFor();
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
