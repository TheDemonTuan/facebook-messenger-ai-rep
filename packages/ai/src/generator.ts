import type { ConversationContext } from "./persona.js";
import { buildChatMessages } from "./persona.js";
import { validateAiOutput } from "./guards.js";
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
}

export class AiReplyGenerator {
  async generateReply(context: ConversationContext): Promise<GenerationResult> {
    const client = getAiClient();
    const model = context.settings.aiModel;
    const startTime = Date.now();

    const initialMessages = buildChatMessages(context);

    try {
      // 1. Initial attempt
      const completion = await client.chat.completions.create({
        model,
        messages: initialMessages,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const latencyMs = Date.now() - startTime;
      const rawResponse = completion.choices[0]?.message?.content || "";
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

      const retryCompletion = await client.chat.completions.create({
        model,
        messages: retryMessages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const totalLatencyMs = Date.now() - startTime;
      const retryRaw = retryCompletion.choices[0]?.message?.content || "";
      const retryUsage = retryCompletion.usage;
      const finalPromptTokens = promptTokens + (retryUsage?.prompt_tokens || 0);
      const finalCompletionTokens = completionTokens + (retryUsage?.completion_tokens || 0);
      const finalTotalTokens = totalTokens + (retryUsage?.total_tokens || 0);

      const secondValidation = validateAiOutput(retryRaw, {
        maxResponseCount: context.settings.aiMaxResponseCount,
        totalMaxChars: context.settings.aiTotalMaxChars,
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
      };
    } catch (err: unknown) {
      const error = err as Error;
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        errorMessage: `AI service error: ${error.message}`,
        model,
        latencyMs,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
    }
  }
}
