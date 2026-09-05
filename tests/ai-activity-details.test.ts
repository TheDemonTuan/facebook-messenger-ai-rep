import { describe, it, expect, vi, afterEach } from "vitest";
import { AiReplyGenerator } from "../packages/ai/src/generator.js";
import * as clientModule from "../packages/ai/src/client.js";
import {
  formatProviderNameVi,
  formatEndpointDescriptionVi,
  formatDurationVi,
  formatUsageVi,
  formatRunStatusVi,
} from "../packages/contracts/src/ai.js";
import { SystemSettingsSchema } from "../packages/contracts/src/settings.js";
import {
  AiRunRepository,
  stripSensitiveData,
  sanitizeCustomerOutput,
  type Database,
  type QueueRepository,
  type SettingsRepository,
  type AiConfigRepository,
  type IncidentRepository,
  type EventRepository,
  type JobRepository,
} from "../packages/db/src/index.js";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";
import Fastify from "fastify";
import { createAdminRoutes } from "../apps/core/src/routes/admin.js";

describe("Safe & Understandable AI Activity Request/Response Details", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultSettings = SystemSettingsSchema.parse({
    aiModel: "grok-4.5",
    aiTimeoutMs: 15000,
  });

  const dummyContext = {
    customerName: "Khách test",
    customerSummary: "Khách quan tâm sản phẩm",
    recentMessages: [{ direction: "INBOUND" as const, text: "Shop có áo sơ mi trắng size L không?" }],
    settings: defaultSettings,
  };

  describe("AiReplyGenerator Request/Response Sanitized Snapshots", () => {
    it("captures sanitized snapshot for OPENAI_COMPATIBLE with POST {baseUrl}/chat/completions without credentials", async () => {
      const mockRawResponse = JSON.stringify({
        messages: ["Dạ shop còn áo sơ mi trắng size L bạn nhé!"],
        needsClarification: false,
        internalReasoning: "Customer asks about size L white shirt. Inventory has it in stock.",
      });

      vi.spyOn(clientModule, "createAiCompletion").mockResolvedValue({
        content: mockRawResponse,
        promptTokens: 120,
        completionTokens: 25,
        totalTokens: 145,
        rawResponse: {
          id: "chatcmpl-test-123",
          choices: [{ message: { role: "assistant", content: mockRawResponse } }],
        },
      });

      const generator = new AiReplyGenerator();
      const result = await generator.generateReply(dummyContext, {
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.example/v1",
        apiKey: "sk-supersecretkey1234567890",
        model: "gpt-4o",
        timeoutMs: 15000,
      });

      expect(result.success).toBe(true);

      // 1. Request snapshot inspection
      expect(result.requestSnapshot).toBeDefined();
      expect(result.requestSnapshot?.apiFormat).toBe("OPENAI_COMPATIBLE");
      expect(result.requestSnapshot?.endpoint).toBe("https://api.openai.example/v1/chat/completions");
      expect(result.requestSnapshot?.method).toBe("POST");
      expect(result.requestSnapshot?.model).toBe("gpt-4o");

      // Verify NO credentials or authorization headers are persisted/exposed
      const serializedReq = JSON.stringify(result.requestSnapshot);
      expect(serializedReq).not.toContain("sk-supersecretkey1234567890");
      expect(serializedReq).not.toContain("authorization");
      expect(serializedReq).not.toContain("apiKey");

      // Verify payload has structured messages
      const payload = result.requestSnapshot?.payload as { messages: Array<{ role: string; content: string }> };
      expect(payload).toBeDefined();
      expect(payload.messages.some((m) => m.content.includes("Shop có áo sơ mi trắng"))).toBe(true);

      // 2. Response snapshot inspection
      expect(result.responseSnapshot).toBeDefined();
      expect(result.responseSnapshot?.status).toBe(200);
      expect(result.responseSnapshot?.content).toContain("Dạ shop còn áo sơ mi trắng size L bạn nhé!");
      expect(JSON.stringify(result.responseSnapshot)).not.toContain("internalReasoning");
      expect(JSON.stringify(result.responseSnapshot)).not.toContain("Customer asks about size L");

      // 3. Customer output (usedResult) must NEVER expose internalReasoning
      expect(result.usedResult).toBeDefined();
      expect(result.usedResult?.messages).toEqual(["Dạ shop còn áo sơ mi trắng size L bạn nhé!"]);
      expect(result.usedResult?.needsClarification).toBe(false);
      expect((result.usedResult as Record<string, unknown>).internalReasoning).toBeUndefined();

      const serializedUsed = JSON.stringify(result.usedResult);
      expect(serializedUsed).not.toContain("Customer asks about size L");
      expect(serializedUsed).not.toContain("internalReasoning");
    });

    it("captures sanitized snapshot for ANTHROPIC_COMPATIBLE with POST {baseUrl}/messages without credentials", async () => {
      const mockRawResponse = JSON.stringify({
        messages: ["Dạ chào bạn! Áo sơ mi còn size L ạ."],
        needsClarification: false,
      });

      vi.spyOn(clientModule, "createAiCompletion").mockResolvedValue({
        content: mockRawResponse,
        promptTokens: 80,
        completionTokens: 20,
        totalTokens: 100,
        rawResponse: {
          id: "msg_test_anthropic_123",
          type: "message",
          content: [{ type: "text", text: mockRawResponse }],
        },
      });

      const generator = new AiReplyGenerator();
      const result = await generator.generateReply(dummyContext, {
        apiFormat: "ANTHROPIC_COMPATIBLE",
        baseUrl: "https://api.anthropic.example/v1/",
        apiKey: "sk-ant-api03-verysecretkey1234567890",
        model: "claude-3-5-sonnet",
        timeoutMs: 20000,
      });

      expect(result.success).toBe(true);

      // 1. Endpoint must be POST {baseUrl}/messages
      expect(result.requestSnapshot?.apiFormat).toBe("ANTHROPIC_COMPATIBLE");
      expect(result.requestSnapshot?.endpoint).toBe("https://api.anthropic.example/v1/messages");
      expect(result.requestSnapshot?.method).toBe("POST");
      expect(result.requestSnapshot?.model).toBe("claude-3-5-sonnet");

      // Verify no API keys in snapshot
      const serializedReq = JSON.stringify(result.requestSnapshot);
      expect(serializedReq).not.toContain("sk-ant-api03");
      expect(serializedReq).not.toContain("x-api-key");

      // Verify Anthropic payload has system and messages separated
      const payload = result.requestSnapshot?.payload as { system?: string; messages?: Array<{ role: string; content: string }> };
      expect(payload.system).toBeDefined();
      expect(payload.messages).toBeDefined();
      expect(payload.messages?.some((m) => m.content.includes("Shop có áo sơ mi trắng"))).toBe(true);

      // 2. Used result is clean
      expect(result.usedResult?.messages).toEqual(["Dạ chào bạn! Áo sơ mi còn size L ạ."]);
      expect(result.usedResult?.needsClarification).toBe(false);
    });

    it("strips hidden chain-of-thought <think> tags from customer output messages", async () => {
      const rawWithThinking = JSON.stringify({
        messages: ["<think>Thinking about pricing and stock status...</think>Dạ áo giá 250k bạn nhé!"],
        needsClarification: false,
        internalReasoning: "Private internal reasoning that must stay hidden",
      });

      vi.spyOn(clientModule, "createAiCompletion").mockResolvedValue({
        content: rawWithThinking,
        promptTokens: 50,
        completionTokens: 30,
        totalTokens: 80,
      });

      const generator = new AiReplyGenerator();
      const result = await generator.generateReply(dummyContext, {
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "dummy",
        model: "deepseek-r1",
      });

      expect(result.success).toBe(true);
      expect(result.usedResult?.messages).toEqual(["Dạ áo giá 250k bạn nhé!"]);
      expect(result.usedResult?.messages[0]).not.toContain("<think>");
      expect(result.usedResult?.messages[0]).not.toContain("Thinking about pricing");
      expect((result.usedResult as Record<string, unknown>).internalReasoning).toBeUndefined();
    });

    it("preserves request snapshot and sanitizes errors on failure without leaking credentials", async () => {
      vi.spyOn(clientModule, "createAiCompletion").mockRejectedValue(
        new Error("HTTP 401 Unauthorized: Invalid Bearer sk-supersecret-token-key-123456789")
      );

      const generator = new AiReplyGenerator();
      const result = await generator.generateReply(dummyContext, {
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-supersecret-token-key-123456789",
        model: "gpt-4o",
      });

      expect(result.success).toBe(false);
      expect(result.requestSnapshot).toBeDefined();
      expect(result.requestSnapshot?.endpoint).toBe("https://api.openai.com/v1/chat/completions");
      expect(result.usedResult).toBeNull();

      // Error message must have credentials redacted
      expect(result.errorMessage).not.toContain("sk-supersecret-token-key-123456789");
      expect(result.errorMessage).toContain("[REDACTED]");
    });
  });

  describe("AiRunRepository & Sanitization Utility", () => {
    it("stripSensitiveData removes credentials, api keys, and bearer tokens from snapshots", () => {
      const dirtySnapshot = {
        apiFormat: "OPENAI_COMPATIBLE",
        endpoint: "https://api.example.com/v1/chat/completions",
        apiKey: "secret-key-value-12345",
        headers: {
          authorization: "Bearer sk-1234567890abcdef",
          "x-api-key": "anthropic-key-abc",
          "content-type": "application/json",
        },
        payload: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
      };

      const cleaned = stripSensitiveData(dirtySnapshot);

      expect(cleaned.apiKey).toBe("[REDACTED]");
      expect(cleaned.headers.authorization).toBe("[REDACTED]");
      expect(cleaned.headers["x-api-key"]).toBe("[REDACTED]");
      expect(cleaned.headers["content-type"]).toBe("application/json");
      expect(cleaned.payload.model).toBe("gpt-4");
    });

    it("sanitizeCustomerOutput strips internalReasoning, thinking, and chainOfThought", () => {
      const output = {
        messages: ["<think>pondering...</think>Hello customer!"],
        needsClarification: false,
        internalReasoning: "Hidden CoT",
        thinking: "Hidden thinking",
        chainOfThought: "Hidden chain",
      };

      const cleaned = sanitizeCustomerOutput(output);
      expect(cleaned?.internalReasoning).toBeUndefined();
      expect(cleaned?.thinking).toBeUndefined();
      expect(cleaned?.chainOfThought).toBeUndefined();
      expect(cleaned?.messages).toEqual(["Hello customer!"]);
      expect(cleaned?.needsClarification).toBe(false);
    });

    it("AiRunRepository creates runs with sanitized snapshots and strips internalReasoning from customer output", async () => {
      let insertedValues: Record<string, unknown> | null = null;
      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn((val) => {
            insertedValues = val;
            return {
              returning: vi.fn(async () => [{ id: "run-uuid-1", ...val }]),
            };
          }),
        })),
      } as unknown as Database;

      const repo = new AiRunRepository(mockDb);
      const created = await repo.createRun({
        channelAccountId: "personal-messenger",
        conversationId: "00000000-0000-0000-0000-000000000001",
        inboundVersion: 1,
        model: "grok-4.5",
        status: "SUCCESS",
        requestSnapshot: {
          endpoint: "https://api.openai.com/v1/chat/completions",
          apiKey: "secret-leak-test-12345",
        },
        responseSnapshot: {
          status: 200,
          raw: { choices: [{ message: { content: "OK" } }] },
        },
        usedResult: {
          messages: ["Chào quý khách!"],
          needsClarification: false,
          internalReasoning: "Hidden reasoning must not persist in usedResult",
        },
      });

      expect(created.id).toBe("run-uuid-1");
      expect(insertedValues).toBeDefined();

      const req = insertedValues!.requestSnapshot as Record<string, unknown>;
      expect(req.apiKey).toBe("[REDACTED]");

      const used = insertedValues!.usedResult as Record<string, unknown>;
      expect(used.messages).toEqual(["Chào quý khách!"]);
      expect(used.internalReasoning).toBeUndefined();
    });
  });

  describe("Vietnamese Plain Language Formatting Helpers", () => {
    it("formats provider names in plain Vietnamese", () => {
      expect(formatProviderNameVi("OPENAI_COMPATIBLE")).toBe("Dịch vụ AI chuẩn OpenAI");
      expect(formatProviderNameVi("ANTHROPIC_COMPATIBLE")).toBe("Dịch vụ AI chuẩn Anthropic Claude");
      expect(formatProviderNameVi(undefined)).toBe("Dịch vụ AI chuẩn OpenAI");
    });

    it("formats endpoints in plain Vietnamese without technical jargon", () => {
      expect(formatEndpointDescriptionVi("OPENAI_COMPATIBLE", "https://api.openai.com/v1/chat/completions")).toBe(
        "Chuẩn OpenAI (https://api.openai.com/v1/chat/completions)"
      );
      expect(formatEndpointDescriptionVi("ANTHROPIC_COMPATIBLE", "https://api.anthropic.com/v1/messages")).toBe(
        "Chuẩn Anthropic Claude (https://api.anthropic.com/v1/messages)"
      );
      expect(formatEndpointDescriptionVi("OPENAI_COMPATIBLE", undefined)).toBe(
        "Chuẩn OpenAI (POST {baseUrl}/chat/completions)"
      );
    });

    it("formats duration in plain Vietnamese", () => {
      expect(formatDurationVi(450)).toBe("450 mili-giây");
      expect(formatDurationVi(1200)).toBe("1,2 giây");
      expect(formatDurationVi(3500)).toBe("3,5 giây");
      expect(formatDurationVi(undefined)).toBe("Chưa có thông tin");
    });

    it("formats token usage in plain language avoiding raw technical terms", () => {
      expect(formatUsageVi(130, 100, 30)).toBe("130 từ/token (Đầu vào: 100, Phản hồi: 30)");
      expect(formatUsageVi(0)).toBe("0 ký hiệu/token");
    });

    it("formats run statuses in Vietnamese with appropriate colors", () => {
      expect(formatRunStatusVi("SUCCESS").label).toBe("Thành công");
      expect(formatRunStatusVi("GUARD_REJECTED").label).toBe("Từ chối an toàn");
      expect(formatRunStatusVi("ERROR").label).toBe("Lỗi xử lý");
      expect(formatRunStatusVi("STALE_ABORTED").label).toBe("Đã hủy do tin nhắn mới");
    });
  });

  describe("Admin API Endpoints /api/ai-runs and /api/ai-runs/test", () => {
    it("GET /api/ai-runs returns sanitized items with requestSnapshot, responseSnapshot, and usedResult", async () => {
      const mockRuns = [
        {
          id: "00000000-0000-0000-0000-000000000001",
          channelAccountId: "personal-messenger",
          conversationId: "00000000-0000-0000-0000-000000000002",
          inboundVersion: 1,
          model: "grok-4.5",
          promptTokens: 100,
          completionTokens: 30,
          totalTokens: 130,
          latencyMs: 1200,
          status: "SUCCESS",
          promptHash: "a".repeat(64),
          responseHash: "b".repeat(64),
          requestSnapshot: {
            endpoint: "https://api.openai.com/v1/chat/completions",
            apiKey: "leak-key-12345",
          },
          responseSnapshot: {
            status: 200,
            content: '{"messages":["Chào bạn"],"needsClarification":false}',
          },
          usedResult: {
            messages: ["Chào bạn"],
            needsClarification: false,
            internalReasoning: "Leak check",
          },
          parsedOutput: { messages: ["Chào bạn"] },
          errorMessage: null,
          createdAt: new Date(),
        },
      ];

      const mockDb = {
        select: vi.fn((fields?: unknown) => ({
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (fields && typeof fields === "object" && "count" in fields) {
                return Promise.resolve([{ count: 1 }]);
              }
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    offset: vi.fn(async () => mockRuns),
                  })),
                })),
              };
            }),
          })),
        })),
      };

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: mockDb as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: { getSettings: vi.fn(async () => ({ settings: defaultSettings })) } as unknown as SettingsRepository,
          aiConfigRepo: {
            getConfig: vi.fn(async () => ({
              apiFormat: "OPENAI_COMPATIBLE",
              baseUrl: "https://api.x.ai/v1",
              apiKey: "test-key",
              model: defaultSettings.aiModel,
            })),
          } as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: {} as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-1",
            email: "admin@example.com",
            role: "ADMIN",
            channelAccountId: "personal-messenger",
          }),
          channelAccountId: "personal-messenger",
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/ai-runs",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.items).toHaveLength(1);

      const item = body.items[0];
      // Sanitized requestSnapshot
      expect(item.requestSnapshot.apiKey).toBe("[REDACTED]");
      // Sanitized usedResult without internalReasoning
      expect(item.usedResult.messages).toEqual(["Chào bạn"]);
      expect(item.usedResult.internalReasoning).toBeUndefined();
    });
  });
});
