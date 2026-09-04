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

  it("strips <think> tags and reasoning blocks and extracts valid JSON", () => {
    const responseWithThink = `<think>
Tôi là nhân viên CSKH. Khách hàng hỏi size M.
Tôi cần định dạng đầu ra thành JSON có messages.
</think>
\`\`\`json
{
  "messages": ["Dạ shop vẫn còn size M bạn nhé!"],
  "needsClarification": false
}
\`\`\``;

    const res = validateAiOutput(responseWithThink);
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toBe("Dạ shop vẫn còn size M bạn nhé!");
  });

  it("extracts embedded JSON when wrapped with conversational text or unclosed fences", () => {
    const responseWithPreamble = `Chào bạn, đây là câu trả lời của tôi:
{
  "messages": ["Shop hỗ trợ bạn ngay ạ!"],
  "needsClarification": false
}
Hy vọng giúp ích được cho bạn.`;

    const res = validateAiOutput(responseWithPreamble);
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toBe("Shop hỗ trợ bạn ngay ạ!");
  });

  it("detects HTML error pages from upstream proxy and returns AI Gateway error instead of JSON parse error", () => {
    const html502 = `<!DOCTYPE html>
<html>
<head><title>502 Bad Gateway</title></head>
<body>
<h1>502 Bad Gateway</h1>
<p>Cloudflare / Nginx proxy connection error</p>
</body>
</html>`;

    const res = validateAiOutput(html502);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("AI Gateway error: Upstream server returned HTML error page (502 Bad Gateway)");
    // Must NOT be the confusing "JSON Parse error: Unrecognized token '<'"
    expect(res.error).not.toContain("JSON Parse error: Unrecognized token '<'");
  });

  it("handles thinking block containing pseudo-JSON and extracts real JSON", () => {
    const rawWithNestedJsonInThink = `<think>
User seems to be testing system and also pointing out error. Let me respond properly with correct JSON format as required by system prompt.

I need to return valid JSON with required format:
{
 "messages": ["tin nhắn"],
 "needsClarification": boolean
}

And I should keep it short (30-160 chars per message, max 480 chars total).
</think>

{"messages":["hello! Em chào anh/chị ạ rất vui được hỗ trợ. Anh/chị cần em giúp gì hôm nay ạ?"],"needsClarification":false}`;

    const res = validateAiOutput(rawWithNestedJsonInThink);
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toBe("hello! Em chào anh/chị ạ rất vui được hỗ trợ. Anh/chị cần em giúp gì hôm nay ạ?");
  });

  it("rescues plain text response when allowPlainTextFallback is true", () => {
    const plainTextWithThink = `<think>
The user is saying "hello" after some random test messages. As a CSKH representative, I should greet them warmly and ask how I can help.
</think>

hello! Em chào anh/chị ạ rất vui được hỗ trợ. Anh/chị cần em giúp gì hôm nay ạ?`;

    const res = validateAiOutput(plainTextWithThink, { allowPlainTextFallback: true });
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toBe("hello! Em chào anh/chị ạ rất vui được hỗ trợ. Anh/chị cần em giúp gì hôm nay ạ?");
  });

  it("handles plain text starting with 'D' when allowPlainTextFallback is enabled", () => {
    const rawStartingWithD = "Dạ shop em chào bạn, bên em vẫn còn hàng size L màu đen anh nhé!";
    const res = validateAiOutput(rawStartingWithD, { allowPlainTextFallback: true });
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toBe(rawStartingWithD);
    expect(res.data?.needsClarification).toBe(false);
  });

  it("handles short Vietnamese plain text responses (e.g. 'Dạ có ạ!')", () => {
    const shortText = "Dạ có ạ!";
    const res = validateAiOutput(shortText, { allowPlainTextFallback: true });
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toBe("Dạ có ạ!");
  });

  it("normalizes singular 'message' key to 'messages' array", () => {
    const singular = JSON.stringify({
      message: "Dạ em chào anh/chị, em hỗ trợ gì cho mình ạ?",
    });
    const res = validateAiOutput(singular);
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toContain("Dạ em chào anh/chị");
    expect(res.data?.needsClarification).toBe(false);
  });

  it("normalizes string 'messages' value to array", () => {
    const strMessages = JSON.stringify({
      messages: "Dạ sản phẩm này giá 250k bạn nha.",
    });
    const res = validateAiOutput(strMessages);
    expect(res.valid).toBe(true);
    expect(res.data?.messages[0]).toContain("giá 250k");
  });

  it("normalizes direct JSON array to structured output", () => {
    const rawArray = JSON.stringify(["Dạ chào bạn ạ", "Shop có thể giúp gì cho bạn?"]);
    const res = validateAiOutput(rawArray);
    expect(res.valid).toBe(true);
    expect(res.data?.messages.length).toBe(2);
    expect(res.data?.messages[0]).toBe("Dạ chào bạn ạ");
  });
});
