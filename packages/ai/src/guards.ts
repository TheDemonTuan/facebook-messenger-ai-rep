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

export function extractJsonFromRaw(raw: string): string {
  let cleaned = raw.trim();
  // Remove markdown code blocks if present
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

export function validateAiOutput(
  rawText: string,
  options: {
    maxResponseCount?: number;
    totalMaxChars?: number;
  } = {}
): GuardValidationResult {
  const maxResponseCount = options.maxResponseCount || 3;
  const totalMaxChars = options.totalMaxChars || 480;

  let parsedJson: unknown;
  try {
    const jsonStr = extractJsonFromRaw(rawText);
    parsedJson = JSON.parse(jsonStr);
  } catch (err) {
    return {
      valid: false,
      error: `Failed to parse AI response as JSON: ${(err as Error).message}`,
    };
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
