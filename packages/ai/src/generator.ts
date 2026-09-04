import type { ConversationContext } from "./persona.js";
import { buildChatMessages } from "./persona.js";
import { validateAiOutput } from "./guards.js";
import { getAiClient } from "./client.js";
import { getEnv } from "@messenger/config";
import type { AiStructuredOutput } from "@messenger/contracts";

export interface GenerationResult {
  success: boolean;
  data?: AiStructuredOutput;
  rawResponse?: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage?: string;
  requestMessages?: Array<{ role: string; content: string }>;
}

export class AiReplyGenerator {
  async generateReply(context: ConversationContext): Promise<GenerationResult> {
    const env = getEnv();
    const model = context.settings.aiModel || env.XAI_MODEL;
    const client = getAiClient({
      baseURL: context.settings.aiBaseUrl || env.XAI_BASE_URL,
      timeoutMs: context.settings.aiTimeoutMs,
    });
    const startTime = Date.now();
    const initialMessages = buildChatMessages(context);

    console.log(`[AI Proxy] ---> POST chat/completions | Model: ${model} | Timeout: ${context.settings.aiTimeoutMs}ms`);

    try {
      // 1. Initial attempt
      const completion = await client.chat.completions.create({
        model,
        messages: initialMessages,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const latencyMs = Date.now() - startTime;
      const choice = completion?.choices?.[0];
      const rawResponse = choice?.message?.content || "";

      if (!choice || !completion?.choices) {
        const compAny = completion as unknown as Record<string, unknown> | undefined;
        const proxyError = (compAny?.error as { message?: string })?.message
          || compAny?.error
          || compAny?.message
          || compAny?.detail
          || compAny?.msg;
        const rawDump = typeof completion === "object" ? JSON.stringify(completion) : String(completion);
        const errMsg = proxyError
          ? `AI Proxy returned error: ${typeof proxyError === "object" ? JSON.stringify(proxyError) : proxyError}`
          : "AI Proxy returned unexpected format (missing choices array)";
        console.error(`[AI Proxy] Bad response:`, errMsg);
        return {
          success: false,
          errorMessage: errMsg,
          rawResponse: rawDump,
          model,
          latencyMs,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requestMessages: initialMessages,
        };
      }

      const usage = completion.usage;
      const promptTokens = usage?.prompt_tokens || 0;
      const completionTokens = usage?.completion_tokens || 0;
      const totalTokens = usage?.total_tokens || 0;

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
          rawResponse,
          model,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          requestMessages: initialMessages,
        };
      }

      // If response is an upstream HTML error (e.g. 502/504 Bad Gateway), abort immediately without prompt retry
      if (firstValidation.error?.includes("AI Gateway error") ||
          firstValidation.error?.includes("HTML error page") ||
          rawResponse.trim().toLowerCase().startsWith("<!doctype") ||
          rawResponse.trim().toLowerCase().startsWith("<html")) {
        return {
          success: false,
          errorMessage: firstValidation.error || "AI Gateway returned HTML error page",
          rawResponse,
          model,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          requestMessages: initialMessages,
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

      console.log(`[AI Proxy Retry] ---> POST chat/completions (retry with error feedback) | Model: ${model}`);

      const retryCompletion = await client.chat.completions.create({
        model,
        messages: retryMessages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const totalLatencyMs = Date.now() - startTime;
      const retryChoice = retryCompletion?.choices?.[0];
      const retryRaw = retryChoice?.message?.content || "";

      if (!retryChoice || !retryCompletion?.choices) {
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
          errorMessage: errMsg,
          rawResponse: "",
          model,
          latencyMs: totalLatencyMs,
          promptTokens,
          completionTokens,
          totalTokens,
          requestMessages: retryMessages,
        };
      }

      const retryUsage = retryCompletion.usage;
      const finalPromptTokens = promptTokens + (retryUsage?.prompt_tokens || 0);
      const finalCompletionTokens = completionTokens + (retryUsage?.completion_tokens || 0);
      const finalTotalTokens = totalTokens + (retryUsage?.total_tokens || 0);

      console.log(`[AI Proxy Retry] <--- Response in ${totalLatencyMs}ms | prompt_tokens=${finalPromptTokens}, completion_tokens=${finalCompletionTokens}`);

      const secondValidation = validateAiOutput(retryRaw, {
        maxResponseCount: context.settings.aiMaxResponseCount,
        totalMaxChars: context.settings.aiTotalMaxChars,
        allowPlainTextFallback: true,
      });

      if (secondValidation.valid && secondValidation.data) {
        return {
          success: true,
          data: secondValidation.data,
          rawResponse: retryRaw,
          model,
          latencyMs: totalLatencyMs,
          promptTokens: finalPromptTokens,
          completionTokens: finalCompletionTokens,
          totalTokens: finalTotalTokens,
          requestMessages: retryMessages,
        };
      }

      return {
        success: false,
        errorMessage: `Validation failed after retry: ${secondValidation.error}`,
        rawResponse: retryRaw,
        model,
        latencyMs: totalLatencyMs,
        promptTokens: finalPromptTokens,
        completionTokens: finalCompletionTokens,
        totalTokens: finalTotalTokens,
        requestMessages: retryMessages,
      };
    } catch (err: unknown) {
      const error = err as Error;
      const totalLatencyMs = Date.now() - startTime;
      console.error(`[AI Generator] Error calling AI Gateway (${error.name}):`, error.message);
      return {
        success: false,
        errorMessage: error.message || "Failed to generate reply",
        model,
        latencyMs: totalLatencyMs,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requestMessages: initialMessages,
      };
    }
  }
}
