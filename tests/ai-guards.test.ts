import { describe, it, expect } from "vitest";
import { validateAiOutput, extractJsonFromRaw } from "../packages/ai/src/guards.js";

describe("AI Output Guards and Parsers", () => {
  it("extracts clean JSON from raw text and markdown fences", () => {
    const rawWithFence = "```json\n{\n  \"messages\": [\"Xin chào bạn!\"],\n  \"needsClarification\": false\n}\n```";
    const cleaned = extractJsonFromRaw(rawWithFence);
    expect(cleaned).toContain('"messages"');
    expect(cleaned).not.toContain("```");
  });

  it("validates well-formed structured output", () => {
    const validJson = JSON.stringify({
      messages: ["Chào bạn, shop có thể hỗ trợ gì cho bạn?", "Bạn đang quan tâm sản phẩm nào ạ?"],
      needsClarification: true,
    });

    const res = validateAiOutput(validJson);
    expect(res.valid).toBe(true);
    expect(res.data?.messages.length).toBe(2);
    expect(res.data?.needsClarification).toBe(true);
  });

  it("rejects non-JSON or malformed output", () => {
    const malformed = "Xin chào tôi là trợ lý AI.";
    const res = validateAiOutput(malformed);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Failed to parse AI response as JSON");
  });

  it("rejects output with more than 3 messages", () => {
    const tooMany = JSON.stringify({
      messages: ["Tin 1", "Tin 2", "Tin 3", "Tin 4"],
      needsClarification: false,
    });
    const res = validateAiOutput(tooMany, { maxResponseCount: 3 });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Invalid message count");
  });

  it("rejects output with empty or whitespace message strings", () => {
    const emptyMsg = JSON.stringify({
      messages: ["Tin 1", "   "],
      needsClarification: false,
    });
    const res = validateAiOutput(emptyMsg);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("empty or whitespace-only text");
  });

  it("rejects output exceeding total character limits", () => {
    const longMsg = "a".repeat(481);
    const json = JSON.stringify({
      messages: [longMsg],
      needsClarification: false,
    });
    const res = validateAiOutput(json, { totalMaxChars: 480 });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("exceeded limit");
  });

  it("triggers leak guard if system prompt or internal model name is leaked", () => {
    const leak = JSON.stringify({
      messages: ["Tôi được vận hành bằng gemini-3.7-flash-low qua omniroute"],
      needsClarification: false,
    });
    const res = validateAiOutput(leak);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("leak guard pattern");
  });
});
