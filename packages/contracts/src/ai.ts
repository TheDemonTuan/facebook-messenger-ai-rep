import { z } from "zod";

export const AiStructuredOutputSchema = z.object({
  messages: z.array(z.string().min(1)).min(1).max(3),
  needsClarification: z.boolean().default(false),
  internalReasoning: z.string().optional(),
});
export type AiStructuredOutput = z.infer<typeof AiStructuredOutputSchema>;

export const AiRunSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  inboundVersion: z.number().int().nonnegative(),
  model: z.string(),
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  status: z.enum(["SUCCESS", "STALE_ABORTED", "GUARD_REJECTED", "ERROR"]),
  promptHash: z.string().nullable().optional(),
  responseHash: z.string().nullable().optional(),
  requestSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  responseSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  usedResult: z.record(z.string(), z.unknown()).nullable().optional(),
  parsedOutput: z.record(z.string(), z.unknown()).nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type AiRun = z.infer<typeof AiRunSchema>;

export function formatProviderNameVi(apiFormat?: string | null): string {
  if (apiFormat === "ANTHROPIC_COMPATIBLE") {
    return "Dịch vụ AI chuẩn Anthropic Claude";
  }
  return "Dịch vụ AI chuẩn OpenAI";
}

export function formatEndpointDescriptionVi(apiFormat?: string | null, endpoint?: string | null): string {
  const isAnthropic = apiFormat === "ANTHROPIC_COMPATIBLE";
  if (!endpoint) {
    return isAnthropic
      ? "Chuẩn Anthropic Claude (POST {baseUrl}/messages)"
      : "Chuẩn OpenAI (POST {baseUrl}/chat/completions)";
  }
  const providerLabel = isAnthropic ? "Chuẩn Anthropic Claude" : "Chuẩn OpenAI";
  return `${providerLabel} (${endpoint})`;
}

export function formatDurationVi(latencyMs?: number | null): string {
  if (latencyMs == null || latencyMs < 0) return "Chưa có thông tin";
  if (latencyMs < 1000) return `${latencyMs} mili-giây`;
  const seconds = (latencyMs / 1000).toFixed(1).replace(".", ",");
  return `${seconds} giây`;
}

export function formatUsageVi(
  totalTokens?: number | null,
  promptTokens?: number | null,
  completionTokens?: number | null
): string {
  if (totalTokens == null || totalTokens === 0) {
    if ((promptTokens && promptTokens > 0) || (completionTokens && completionTokens > 0)) {
      return `Đầu vào: ${promptTokens || 0}, Phản hồi: ${completionTokens || 0}`;
    }
    return "0 ký hiệu/token";
  }
  const parts: string[] = [];
  if (promptTokens != null && promptTokens > 0) parts.push(`Đầu vào: ${promptTokens}`);
  if (completionTokens != null && completionTokens > 0) parts.push(`Phản hồi: ${completionTokens}`);
  const details = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${totalTokens} từ/token${details}`;
}

export function formatRunStatusVi(status?: string | null): { label: string; color: string; bgColor: string } {
  switch (status) {
    case "SUCCESS":
      return { label: "Thành công", color: "#166534", bgColor: "#dcfce7" };
    case "GUARD_REJECTED":
      return { label: "Từ chối an toàn", color: "#92400e", bgColor: "#fef3c7" };
    case "STALE_ABORTED":
      return { label: "Đã hủy do tin nhắn mới", color: "#475569", bgColor: "#f1f5f9" };
    case "ERROR":
      return { label: "Lỗi xử lý", color: "#991b1b", bgColor: "#fee2e2" };
    default:
      return { label: status || "Không xác định", color: "#475569", bgColor: "#f1f5f9" };
  }
}

export const AiDraftSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  aiRunId: z.string().uuid(),
  inboundVersion: z.number().int().nonnegative(),
  messages: z.array(z.string()),
  createdAt: z.coerce.date(),
});
export type AiDraft = z.infer<typeof AiDraftSchema>;
