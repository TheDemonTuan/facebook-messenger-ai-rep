import { createHash } from "node:crypto";
import type { ConversationContext } from "./persona.js";
import { buildChatMessages } from "./persona.js";
import { validateAiOutput } from "./guards.js";
import { createAiCompletion, type AiConnectionConfig } from "./client.js";
import { getEnv, getEffectiveAiConfig } from "@messenger/config";
import type { AiStructuredOutput } from "@messenger/contracts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sanitizeAiError(err?: string | null): string | undefined {
  if (!err) return undefined;
  return err
    .replace(/(?:sk-|bearer\s+|key=)[a-zA-Z0-9_\-.]{10,}/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]")
    .slice(0, 500);
}

export interface GenerationResult {
  success: boolean;
  data?: AiStructuredOutput;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptHash: string;
  responseHash?: string;
  errorMessage?: string;
}

export class AiReplyGenerator {
  async generateReply(context: ConversationContext, connection?: AiConnectionConfig): Promise<GenerationResult> {
    const env = getEnv();
    const defaults = getEffectiveAiConfig(env);
    const model = connection?.model || context.settings.aiModel || defaults.model;
    const provider: AiConnectionConfig = connection || {
      apiFormat: defaults.apiFormat,
      baseUrl: defaults.baseURL,
      apiKey: defaults.apiKey || "dummy-dev-key",
      model,
      timeoutMs: context.settings.aiTimeoutMs,
    };
    const startTime = Date.now();
    const initialMessages = buildChatMessages(context);
    const promptHash = sha256(JSON.stringify(initialMessages));

    console.log(`[AI Proxy] ---> ${provider.apiFormat} | Model: ${model} | Timeout: ${context.settings.aiTimeoutMs}ms`);

    try {
      // 1. Initial attempt
      const completion = await createAiCompletion(
        { ...provider, model, timeoutMs: context.settings.aiTimeoutMs },
        initialMessages
      );

      const latencyMs = Date.now() - startTime;
      const rawResponse = completion.content;
      const promptTokens = completion.promptTokens;
      const completionTokens = completion.completionTokens;
      const totalTokens = completion.totalTokens;
      const responseHash = rawResponse ? sha256(rawResponse) : undefined;

      console.log(`[AI Proxy] <--- Response in ${latencyMs}ms | prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}`);

      const firstValidation = validateAiOutput(rawResponse, {
        maxResponseCount: context.settings.aiMaxResponseCount,
        totalMaxChars: context.settings.aiTotalMaxChars,
        allowPlainTextFallback: true,
      });

      if (firstValidation.valid && firstValidation.data) {
        return {
          success: true,
          data: firstValidation.data,
          model,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          promptHash,
          responseHash,
        };
      }

      // If response is an upstream HTML error (e.g. 502/504 Bad Gateway), abort immediately without prompt retry
      if (firstValidation.error?.includes("AI Gateway error") ||
          firstValidation.error?.includes("HTML error page") ||
          rawResponse.trim().toLowerCase().startsWith("<!doctype") ||
          rawResponse.trim().toLowerCase().startsWith("<html")) {
        return {
          success: false,
          errorMessage: sanitizeAiError(firstValidation.error || "AI Gateway returned HTML error page"),
          model,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          promptHash,
          responseHash,
        };
      }

      console.warn(`[AI Generator] First attempt failed guard check: ${firstValidation.error}. Retrying once with error feedback...`);

      // 2. Single retry with validation feedback
      const retryPrompt = `Lần trả lời trước chưa đúng định dạng yêu cầu. Vui lòng phản hồi lại và CHỈ trả về đúng duy nhất 1 JSON object hợp lệ theo định dạng:\n{\n  "messages": ["nội dung phản hồi khách"],\n  "needsClarification": false\n}`;

      const retryMessages = [
        ...initialMessages,
        {
          role: "assistant" as const,
          content: rawResponse,
        },
        {
          role: "user" as const,
          content: retryPrompt,
        },
      ];

      console.log(`[AI Proxy Retry] ---> ${provider.apiFormat} (retry with error feedback) | Model: ${model}`);

      const retryCompletion = await createAiCompletion(
        { ...provider, model, timeoutMs: context.settings.aiTimeoutMs },
        retryMessages
      );

      const totalLatencyMs = Date.now() - startTime;
      const retryRaw = retryCompletion.content;

      if (!retryRaw) {
        const compAny = retryCompletion as unknown as Record<string, unknown> | undefined;
        const proxyError = (compAny?.error as { message?: string })?.message
          || compAny?.error
          || compAny?.message
          || compAny?.detail
          || compAny?.msg;
        const errMsg = proxyError
          ? `AI Proxy retry error: ${typeof proxyError === "object" ? JSON.stringify(proxyError) : proxyError}`
          : "AI Proxy retry returned unexpected format";
        console.error(`[AI Proxy Retry] Bad response:`, errMsg);
        return {
          success: false,
          errorMessage: sanitizeAiError(errMsg),
          model,
          latencyMs: totalLatencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          promptHash,
          responseHash: retryRaw ? sha256(retryRaw) : undefined,
        };
      }

      const retryValidation = validateAiOutput(retryRaw, {
        maxResponseCount: context.settings.aiMaxResponseCount,
        totalMaxChars: context.settings.aiTotalMaxChars,
        allowPlainTextFallback: true,
      });

      if (retryValidation.valid && retryValidation.data) {
        return {
          success: true,
          data: retryValidation.data,
          model,
          latencyMs: totalLatencyMs,
          promptTokens: promptTokens + retryCompletion.promptTokens,
          completionTokens: completionTokens + retryCompletion.completionTokens,
          totalTokens: totalTokens + retryCompletion.totalTokens,
          promptHash,
          responseHash: sha256(retryRaw),
        };
      }

      return {
        success: false,
        errorMessage: sanitizeAiError(retryValidation.error || "Retry output validation failed"),
        model,
        latencyMs: totalLatencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        promptHash,
        responseHash: retryRaw ? sha256(retryRaw) : undefined,
      };
    } catch (err: unknown) {
      const error = err as Error;
      const latencyMs = Date.now() - startTime;
      console.error("[AI Generator] Exception during reply generation:", error);
      return {
        success: false,
        errorMessage: sanitizeAiError(error.message || "Failed to generate reply"),
        model,
        latencyMs,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        promptHash,
        responseHash: sha256(error.message || "Failed to generate reply"),
      };
    }
  }
}
