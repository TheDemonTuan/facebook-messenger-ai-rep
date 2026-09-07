import { AiStructuredOutputSchema, type AiStructuredOutput } from "@messenger/contracts";

export interface GuardValidationResult {
  valid: boolean;
  data?: AiStructuredOutput;
  error?: string;
}

const FORBIDDEN_LEAK_PATTERNS = [
  /system prompt/i,
  /omniroute/i,
  /chatgpt/i,
  /gemini-\d/i,
  /openai/i,
  /fencing token/i,
  /inbound version/i,
  /conversation queue/i,
  /instruction:/i,
];

export function isHtmlPayload(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    /<html[\s>]/i.test(trimmed) ||
    /<head[\s>]/i.test(trimmed) ||
    /<body[\s>]/i.test(trimmed)
  );
}

export function isJsonEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }
  return (
    /(?:^|[\s,{])"?messages"?\s*:/i.test(trimmed) ||
    /(?:^|[\s,{])"?needsClarification"?\s*:/i.test(trimmed)
  );
}

export function extractJsonFromRaw(raw: string): string {
  let cleaned = raw.trim();

  // 1. Strip reasoning / thinking tags (e.g. <think>...</think>, <reasoning>...</reasoning>, <thought>...</thought>)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  const lastThinkEnd = cleaned.lastIndexOf("</think>");
  if (lastThinkEnd !== -1) {
    cleaned = cleaned.substring(lastThinkEnd + "</think>".length).trim();
  }
  const lastReasoningEnd = cleaned.lastIndexOf("</reasoning>");
  if (lastReasoningEnd !== -1) {
    cleaned = cleaned.substring(lastReasoningEnd + "</reasoning>".length).trim();
  }
  const lastThoughtEnd = cleaned.lastIndexOf("</thought>");
  if (lastThoughtEnd !== -1) {
    cleaned = cleaned.substring(lastThoughtEnd + "</thought>".length).trim();
  }
  cleaned = cleaned.trim();

  // 2. Extract content from markdown code fences if present anywhere
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  } else {
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();
  }

  // 3. Extract substring between first '{' and last '}' (or '[' and ']') if wrapped by text or XML tags
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1).trim();
  } else {
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      cleaned = cleaned.substring(firstBracket, lastBracket + 1).trim();
    }
  }

  return cleaned;
}

/**
 * Normalizes outgoing chat messages to match human conversational conventions:
 * 1. Consolidates product lists, introductions, and explanations into 1 single message.
 * 2. Isolates trailing questions or call-to-actions (e.g. "Bạn đang tìm món gì nè?") into a second message.
 * 3. Prevents fragmenting lists into excessive small bubbles.
 */
export function normalizeOutgoingChatMessages(messages: string[]): string[] {
  if (!messages || messages.length === 0) return messages;

  // Case 1: Multiple messages were returned
  if (messages.length > 1) {
    const lastMsg = messages[messages.length - 1]!.trim();
    const isClosingQuestion =
      lastMsg.length <= 150 &&
      (/\?$/.test(lastMsg) ||
        /\b(nè|nhé|nha|ạ|nhỉ|hông|không|được không|gì nè)\s*[!?.]*$/i.test(lastMsg) ||
        /^(bạn|em|chị|anh|mình)\s+(đang tìm|muốn|cần|có thể|thích|hỏi)/i.test(lastMsg));

    if (isClosingQuestion) {
      const contentParts = messages.slice(0, -1).map((m) => m.trim()).filter(Boolean);
      const combinedContent = contentParts.join("\n");
      return [combinedContent, lastMsg];
    }

    if (messages.length > 2) {
      const first = messages.slice(0, -1).map((m) => m.trim()).filter(Boolean).join("\n");
      return [first, lastMsg];
    }

    return messages;
  }

  // Case 2: Exactly 1 message was returned, check if it contains content/list followed by a closing question on a new line
  const single = messages[0]!.trim();
  const lines = single.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.length >= 2) {
    const lastLine = lines[lines.length - 1]!;
    const isClosingQuestion =
      lastLine.length <= 150 &&
      (/\?$/.test(lastLine) ||
        /\b(nè|nhé|nha|ạ|nhỉ|hông|không|được không|gì nè)\s*[!?.]*$/i.test(lastLine) ||
        /^(bạn|em|chị|anh|mình)\s+(đang tìm|muốn|cần|có thể|thích|hỏi)/i.test(lastLine));

    const hasListOrIntro = lines.slice(0, -1).some((l) => /^[-*•\d.]/.test(l) || l.endsWith(":"));

    if (isClosingQuestion && (hasListOrIntro || lines.length >= 3)) {
      const content = lines.slice(0, -1).join("\n");
      return [content, lastLine];
    }
  }

  return [single];
}

export function validateAiOutput(
  rawText: string,
  options: {
    maxResponseCount?: number;
    totalMaxChars?: number;
    allowPlainTextFallback?: boolean;
  } = {}
): GuardValidationResult {
  const maxResponseCount = options.maxResponseCount || 3;
  const totalMaxChars = options.totalMaxChars || 480;

  // Check if rawText is an upstream HTML error page (Cloudflare / Nginx 502/504)
  if (isHtmlPayload(rawText)) {
    const titleMatch = rawText.match(/<title>([^<]+)<\/title>/i);
    const htmlTitle = titleMatch && titleMatch[1] ? titleMatch[1].trim() : "Upstream Server Error";
    return {
      valid: false,
      error: `AI Gateway error: Upstream server returned HTML error page (${htmlTitle}) instead of JSON API response.`,
    };
  }

  let parsedJson: unknown;
  try {
    const jsonStr = extractJsonFromRaw(rawText);
    parsedJson = JSON.parse(jsonStr);
  } catch (err) {
    if (options.allowPlainTextFallback) {
      const plainText = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
        .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
        .replace(/^.*<\/think>/is, "")
        .replace(/^.*<\/reasoning>/is, "")
        .replace(/^.*<\/thought>/is, "")
        .replace(/```[a-z]*\s*|\s*```/gi, "")
        .trim();

      const extracted = extractJsonFromRaw(rawText);
      if (isJsonEnvelope(plainText) || isJsonEnvelope(extracted) || isJsonEnvelope(rawText)) {
        return {
          valid: false,
          error: `Failed to parse AI response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (
        plainText.length >= 2 &&
        plainText.length <= totalMaxChars &&
        !isHtmlPayload(plainText) &&
        !FORBIDDEN_LEAK_PATTERNS.some((pattern) => pattern.test(plainText))
      ) {
        const msgs = normalizeOutgoingChatMessages([plainText]);
        parsedJson = {
          messages: msgs,
          needsClarification: false,
        };
      } else {
        return {
          valid: false,
          error: `Failed to parse AI response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      return {
        valid: false,
        error: `Failed to parse AI response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Normalize JSON output variations from different LLM models
  if (parsedJson && typeof parsedJson === "object") {
    if (Array.isArray(parsedJson)) {
      parsedJson = {
        messages: parsedJson.map(String).map((s) => s.trim()).filter(Boolean),
        needsClarification: false,
      };
    } else {
      const record = parsedJson as Record<string, unknown>;

      // If "messages" is a single string: { messages: "..." }
      if (typeof record.messages === "string") {
        record.messages = [record.messages.trim()];
      }

      // If alternative singular key used: message, reply, response, text
      if (!record.messages) {
        const alt = record.message || record.reply || record.response || record.text;
        if (typeof alt === "string" && alt.trim().length > 0) {
          record.messages = [alt.trim()];
        } else if (Array.isArray(alt) && alt.length > 0) {
          record.messages = alt.map(String).map((s) => s.trim()).filter(Boolean);
        }
      }

      // Default needsClarification if omitted
      if (record.needsClarification === undefined) {
        record.needsClarification = false;
      }
    }
  }

  if (parsedJson && typeof parsedJson === "object" && "messages" in parsedJson && Array.isArray(parsedJson.messages)) {
    if (parsedJson.messages.length === 0 || parsedJson.messages.length > maxResponseCount) {
      return {
        valid: false,
        error: `Invalid message count: ${parsedJson.messages.length} (max allowed: ${maxResponseCount})`,
      };
    }
  }

  const parseResult = AiStructuredOutputSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    return {
      valid: false,
      error: `JSON does not match expected schema: ${JSON.stringify(parseResult.error.format())}`,
    };
  }
  const data = parseResult.data;
  data.messages = data.messages.map((msg) =>
    msg
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
      .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
      .trim()
  );

  // Check message count
  if (data.messages.length === 0 || data.messages.length > maxResponseCount) {
    return {
      valid: false,
      error: `Invalid message count: ${data.messages.length} (max allowed: ${maxResponseCount})`,
    };
  }

  // Check character limits and empty strings
  let totalChars = 0;
  for (const msg of data.messages) {
    const trimmed = msg.trim();
    if (trimmed.length === 0) {
      return {
        valid: false,
        error: "Message contains empty or whitespace-only text",
      };
    }
    if (isJsonEnvelope(trimmed)) {
      return {
        valid: false,
        error: "Message contains a serialized JSON envelope",
      };
    }
    totalChars += trimmed.length;

    // Check for leak patterns
    for (const pattern of FORBIDDEN_LEAK_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          valid: false,
          error: `Output triggered leak guard pattern: ${pattern.source}`,
        };
      }
    }
  }

  if (totalChars > totalMaxChars) {
    return {
      valid: false,
      error: `Total message length (${totalChars}) exceeded limit (${totalMaxChars})`,
    };
  }

  // Normalize message distribution:
  // Combine all content/lists into Message 1, and isolate closing question to Message 2
  data.messages = normalizeOutgoingChatMessages(data.messages);

  return {
    valid: true,
    data,
  };
}
