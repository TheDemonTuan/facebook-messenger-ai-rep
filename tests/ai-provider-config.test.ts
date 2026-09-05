import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiCompletion } from "../packages/ai/src/client.js";
import { AiConfigRepository } from "../packages/db/src/repository/ai-config-repo.js";
import { resetEnvCache } from "../packages/config/src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  resetEnvCache();
  vi.restoreAllMocks();
});

describe("AI provider configuration", () => {
  it("preserves the server API key when only the model is changed", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("XAI_API_KEY", "server-api-key");
    vi.stubEnv("AI_CONFIG_ENCRYPTION_KEY", "test-encryption-key-at-least-32-chars");
    resetEnvCache();

    let inserted: Record<string, unknown> | undefined;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          inserted = value;
          return {
            onConflictDoUpdate: async () => undefined,
          };
        },
      }),
    };

    const repository = new AiConfigRepository(db as never);
    const result = await repository.saveConfig(
      "personal-messenger",
      {
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4.6",
      },
      "owner@example.com"
    );

    expect(result).toEqual({
      apiFormat: "OPENAI_COMPATIBLE",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.6",
      apiKeyConfigured: true,
    });
    expect(inserted?.encryptedApiKey).toEqual(expect.any(String));
    expect(inserted?.encryptedApiKey).not.toContain("server-api-key");
  });

  it("calls an Anthropic-compatible messages endpoint with Claude headers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"messages":["Xin chào"],"needsClarification":false}' }],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createAiCompletion(
      {
        apiFormat: "ANTHROPIC_COMPATIBLE",
        baseUrl: "https://api.anthropic.example/v1/",
        apiKey: "anthropic-test-key",
        model: "claude-sonnet-test",
      },
      [
        { role: "system", content: "Return JSON" },
        { role: "user", content: "Xin chào" },
      ]
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.example/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "anthropic-test-key",
          "anthropic-version": "2023-06-01",
        }),
      })
    );
    expect(result.content).toContain("Xin chào");
    expect(result.totalTokens).toBe(19);
  });
});
