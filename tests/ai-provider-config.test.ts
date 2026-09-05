import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiCompletion } from "../packages/ai/src/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("AI provider configuration", () => {
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
