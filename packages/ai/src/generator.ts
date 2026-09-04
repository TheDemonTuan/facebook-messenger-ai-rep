import type { ConversationContext } from "./persona.js";
import { buildChatMessages } from "./persona.js";
import { validateAiOutput, isHtmlPayload } from "./guards.js";
import { getAiClient } from "./client.js";
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
    const client = getAiClient({
      baseURL: context.settings.aiBaseUrl,
      apiKey: context.settings.aiApiKey,
      timeoutMs: context.settings.aiTimeoutMs,
    });
    const model = context.settings.aiModel;
    const startTime = Date.now();

    const initialMessages = buildChatMessages(context);

    console.log(`[AI Proxy] ---> POST ${context.settings.aiBaseUrl}/chat/completions`);
    console.log(`[AI Proxy] Model: ${model} | Timeout: ${context.settings.aiTimeoutMs}ms`);
    console.log(`[AI Proxy] Request Payload:`, JSON.stringify({
      model,
      messages: initialMessages,
      temperature: 0.3,
      response_format: { type: "json_object" },
    }, null, 2));

    try {
      // 1. Initial attempt
      const completion = await client.chat.completions.create({
        model,
        messages: initialMessages,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const latencyMs = Date.now() - startTime;
      console.log(`[AI Proxy] <--- Response in ${latencyMs}ms:`, JSON.stringify(completion, null, 2));

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
          : `AI Proxy returned unexpected format (missing choices array): ${rawDump}`;
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

      const firstValidation = validateAiOutput(rawResponse, {
        maxResponseCount: context.settings.aiMaxResponseCount,
        totalMaxChars: context.settings.aiTotalMaxChars,
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
      if (firstValidation.error?.includes("AI Gateway error") || isHtmlPayload(rawResponse)) {
        console.error(`[AI Generator] Upstream gateway returned HTML error:`, firstValidation.error);
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
      const retryMessages = [
        ...initialMessages,
        {
          role: "assistant" as const,
          content: rawResponse,
        },
        {
          role: "user" as const,
          content: `Lần trả lời trước vi phạm quy tắc: ${firstValidation.error}. Vui lòng sửa lại và chỉ trả về đúng JSON chuẩn: { "messages": [...], "needsClarification": boolean }`,
        },
      ];

      console.log(`[AI Proxy Retry] ---> POST ${context.settings.aiBaseUrl}/chat/completions (retry with error feedback)`);
      console.log(`[AI Proxy Retry] Request Payload:`, JSON.stringify({
        model,
        messages: retryMessages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }, null, 2));

      const retryCompletion = await client.chat.completions.create({
        model,
        messages: retryMessages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const totalLatencyMs = Date.now() - startTime;
      console.log(`[AI Proxy Retry] <--- Response in ${totalLatencyMs}ms:`, JSON.stringify(retryCompletion, null, 2));

      const retryChoice = retryCompletion?.choices?.[0];
      const retryRaw = retryChoice?.message?.content || "";

      if (!retryChoice || !retryCompletion?.choices) {
        const compAny = retryCompletion as unknown as Record<string, unknown> | undefined;
        const proxyError = (compAny?.error as { message?: string })?.message
          || compAny?.error
          || compAny?.message
          || compAny?.detail
          || compAny?.msg;
        const rawDump = typeof retryCompletion === "object" ? JSON.stringify(retryCompletion) : String(retryCompletion);
        const errMsg = proxyError
          ? `AI Proxy retry error: ${typeof proxyError === "object" ? JSON.stringify(proxyError) : proxyError}`
          : `AI Proxy retry returned unexpected format: ${rawDump}`;
        console.error(`[AI Proxy Retry] Bad response:`, errMsg);
        return {
          success: false,
          errorMessage: errMsg,
          rawResponse: rawDump,
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

      if (secondValidation.error?.includes("AI Gateway error") || isHtmlPayload(retryRaw)) {
        return {
          success: false,
          errorMessage: secondValidation.error || "AI Gateway returned HTML error page",
          rawResponse: retryRaw,
          model,
          latencyMs: totalLatencyMs,
          promptTokens: finalPromptTokens,
          completionTokens: finalCompletionTokens,
          totalTokens: finalTotalTokens,
          requestMessages: retryMessages,
        };
      }

      // Second attempt also failed
      return {
        success: false,
        errorMessage: `Guard rejection after retry: ${secondValidation.error}`,
        rawResponse: retryRaw,
        model,
        latencyMs: totalLatencyMs,
        promptTokens: finalPromptTokens,
        completionTokens: finalCompletionTokens,
        totalTokens: finalTotalTokens,
        requestMessages: retryMessages,
      };
    } catch (err: unknown) {
      const error = err as Error & { status?: number; response?: { data?: unknown } };
      const latencyMs = Date.now() - startTime;
      console.error(`[AI Proxy Error] Call failed in ${latencyMs}ms:`, error.message, error.stack);
      return {
        success: false,
        errorMessage: `AI service error: ${error.message}`,
        rawResponse: error.response?.data ? JSON.stringify(error.response.data) : (error.stack || error.message),
        model,
        latencyMs,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requestMessages: initialMessages,
      };
    }
  }
}
