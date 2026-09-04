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

export function extractJsonFromRaw(raw: string): string {
  let cleaned = raw.trim();

  // 1. Strip reasoning / thinking tags (e.g. <think>...</think>, <reasoning>...</reasoning>)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  const lastThinkEnd = cleaned.lastIndexOf("</think>");
  if (lastThinkEnd !== -1) {
    cleaned = cleaned.substring(lastThinkEnd + "</think>".length).trim();
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
        .replace(/^.*<\/think>/is, "")
        .replace(/```[a-z]*\s*|\s*```/gi, "")
        .trim();

      if (
        plainText.length >= 2 &&
        plainText.length <= totalMaxChars &&
        !isHtmlPayload(plainText) &&
        !FORBIDDEN_LEAK_PATTERNS.some((pattern) => pattern.test(plainText))
      ) {
        // Split multi-line messages by paragraphs if appropriate
        const lines = plainText
          .split(/\n{2,}|\n(?=[A-ZĐÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼỀỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴÝỶỸ])/)
          .map((l) => l.trim())
          .filter(Boolean);

        const msgs = lines.length > 1 && lines.length <= maxResponseCount ? lines : [plainText];

        parsedJson = {
          messages: msgs,
          needsClarification: false,
        };
      } else {
        return {
          valid: false,
          error: `Failed to parse AI response as JSON: ${(err as Error).message}`,
        };
      }
    } else {
      return {
        valid: false,
        error: `Failed to parse AI response as JSON: ${(err as Error).message}`,
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
      error: `Total message characters (${totalChars}) exceeded limit (${totalMaxChars})`,
    };
  }

  return {
    valid: true,
    data,
  };
}
