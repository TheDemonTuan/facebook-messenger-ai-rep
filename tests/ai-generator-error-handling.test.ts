import { describe, it, expect, vi } from "vitest";
import { AiReplyGenerator } from "../packages/ai/src/generator.js";
import { SystemSettingsSchema } from "../packages/contracts/src/settings.js";
import * as clientModule from "../packages/ai/src/client.js";
import Fastify from "../apps/control-plane/node_modules/fastify";
import { createAdminRoutes } from "../apps/control-plane/src/routes/admin.js";

describe("AI Generator & Proxy Error Handling & Logs", () => {
  const settings = SystemSettingsSchema.parse({
    aiBaseUrl: "http://127.0.0.1:8000/v1",
    aiApiKey: "test-key",
    aiModel: "test-model",
  });

  const dummyContext = {
    customerName: "Nguyễn Văn A",
    recentMessages: [{ direction: "INBOUND", text: "Chào shop, áo này còn size M không?" }],
    settings,
  };

  it("handles missing completion.choices gracefully without throwing TypeError (evaluating completion.choices[0])", async () => {
    // Simulate proxy returning an error object with no choices
    const mockOpenAiClient = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            return {
              error: {
                message: "Model 'gemini-3.7-flash-low' not found on upstream proxy",
                code: 404,
              },
            } as any;
          }),
        },
      },
    };

    vi.spyOn(clientModule, "getAiClient").mockReturnValue(mockOpenAiClient as any);

    const generator = new AiReplyGenerator();
    const result = await generator.generateReply(dummyContext);

    // Must NOT throw TypeError: undefined is not an object (evaluating 'completion.choices[0]')
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("AI Proxy returned error: Model 'gemini-3.7-flash-low' not found");
    expect(result.requestMessages).toBeDefined();
    expect(result.requestMessages!.length).toBeGreaterThan(0);
    expect(result.rawResponse).toContain("gemini-3.7-flash-low");
  });

  it("handles empty choices array gracefully without throwing", async () => {
    const mockOpenAiClient = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            return {
              choices: [],
            } as any;
          }),
        },
      },
    };

    vi.spyOn(clientModule, "getAiClient").mockReturnValue(mockOpenAiClient as any);

    const generator = new AiReplyGenerator();
    const result = await generator.generateReply(dummyContext);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("AI Proxy returned unexpected format");
    expect(result.requestMessages).toBeDefined();
  });

  it("returns request messages and parsed output on successful completion", async () => {
    const validJson = JSON.stringify({
      messages: ["Dạ shop vẫn còn size M ạ, bạn cao và nặng bao nhiêu để shop tư vấn chuẩn hơn nha!"],
      needsClarification: false,
    });

    const mockOpenAiClient = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            return {
              choices: [
                {
                  message: {
                    content: validJson,
                  },
                },
              ],
              usage: {
                prompt_tokens: 150,
                completion_tokens: 45,
                total_tokens: 195,
              },
            } as any;
          }),
        },
      },
    };

    vi.spyOn(clientModule, "getAiClient").mockReturnValue(mockOpenAiClient as any);

    const generator = new AiReplyGenerator();
    const result = await generator.generateReply(dummyContext);

    expect(result.success).toBe(true);
    expect(result.data?.messages[0]).toContain("Dạ shop vẫn còn size M");
    expect(result.promptTokens).toBe(150);
    expect(result.totalTokens).toBe(195);
    expect(result.requestMessages).toBeDefined();
    expect(result.requestMessages!.length).toBeGreaterThan(0);
  });

  it("accepts plain text customer response starting with 'D' on first attempt without triggering retry", async () => {
    const plainTextResponse = "Dạ shop em chào anh ạ! Áo này bên em vẫn còn size M nha anh.";

    const mockCreate = vi.fn(async () => {
      return {
        choices: [
          {
            message: {
              content: plainTextResponse,
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 25,
          total_tokens: 145,
        },
      } as any;
    });

    const mockOpenAiClient = {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    };

    vi.spyOn(clientModule, "getAiClient").mockReturnValue(mockOpenAiClient as any);

    const generator = new AiReplyGenerator();
    const result = await generator.generateReply(dummyContext);

    expect(result.success).toBe(true);
    expect(result.data?.messages[0]).toBe(plainTextResponse);
    // Verified that only 1 call was made (no retry needed!)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("admin routes provide GET /api/ai-runs to retrieve runs list", async () => {
    const mockRuns = [
      {
        id: "run-1",
        channelAccountId: "personal-messenger",
        conversationId: "conv-1",
        inboundVersion: 1,
        model: "gemini-3.7-flash-low",
        promptTokens: 100,
        completionTokens: 30,
        totalTokens: 130,
        latencyMs: 1200,
        status: "SUCCESS",
        rawResponse: '{"messages":["Chào bạn"]}',
        parsedOutput: { messages: ["Chào bạn"] },
        errorMessage: null,
        createdAt: new Date(),
      },
    ];

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => mockRuns),
            })),
          })),
        })),
      })),
    };

    const fastify = Fastify();
    await fastify.register(
      createAdminRoutes({
        db: mockDb as any,
        queueRepo: {} as any,
        settingsRepo: { getSettings: vi.fn(async () => ({ settings })) } as any,
        incidentRepo: {} as any,
        eventRepo: {} as any,
        broadcaster: { broadcast: vi.fn() } as any,
        requireAuth: async () => ({
          id: "u-1",
          email: "owner@example.com",
          role: "OWNER",
          sessionId: "s-1",
        }),
        channelAccountId: "personal-messenger",
      })
    );

    const res = await fastify.inject({
      method: "GET",
      url: "/api/ai-runs",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.length).toBe(1);
    expect(body.items[0].model).toBe("gemini-3.7-flash-low");
  });
});
