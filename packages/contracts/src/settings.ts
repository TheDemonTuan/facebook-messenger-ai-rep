import { z } from "zod";
import { ReplyModeSchema } from "./enums.js";

export const AiApiFormatSchema = z.enum(["OPENAI_COMPATIBLE", "ANTHROPIC_COMPATIBLE"]);
export type AiApiFormat = z.infer<typeof AiApiFormatSchema>;

export function isValidAiModel(model: string): boolean {
  const value = model.trim();
  return value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value);
}

export function isValidAiBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  } catch {
    return false;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

export const SystemSettingsSchema = z.object({
  debounceMs: z.number().int().min(500).max(30000).default(3000),
  stickyWindowMs: z.number().int().min(5000).max(300000).default(45000),
  stickyMaxTurns: z.number().int().min(1).max(10).default(3),
  stickyMaxDurationMs: z.number().int().min(10000).max(600000).default(120000),
  aiModel: z.string().trim().min(1).default("auto/best-chat").refine(isValidAiModel, {
    message: "Invalid AI model name.",
  }),
  aiTimeoutMs: z.number().int().min(2000).max(60000).default(20000),
  aiMaxResponseCount: z.number().int().min(1).max(3).default(3),
  aiTotalMaxChars: z.number().int().min(50).max(2000).default(480),
  aiSystemPersona: z.string().min(1).default(
    "Bạn là nhân viên CSKH duy nhất, nhiệt tình, lịch sự, ngắn gọn và trung thực. Chỉ trả lời dựa trên thông tin được cung cấp, không bịa thông tin về giá, đơn hàng, chính sách nếu chưa có dữ liệu rõ ràng. Nếu thiếu dữ kiện cần thiết, hãy lịch sự hỏi đúng 1 câu tối thiểu."
  ),
  businessProfile: z.string().default("Shop tư vấn và hỗ trợ khách hàng trực tuyến."),
  typingTargetWpmMin: z.number().int().min(20).max(300).default(55),
  typingTargetWpmMax: z.number().int().min(20).max(300).default(65),
  busyMode: z.boolean().default(false),
  autoReplyEnabled: z.boolean().default(true),
  pauseIntakeProcessing: z.boolean().default(false),
  // Messenger reply eligibility controls
  businessTimeZone: z.string().default("Asia/Ho_Chi_Minh").refine(isValidTimeZone, {
    message: "Invalid IANA time zone identifier.",
  }),
  replyMode: ReplyModeSchema.default("EVERYONE_EXCEPT"),
  directRepliesEnabled: z.boolean().default(true),
  groupRepliesEnabled: z.boolean().default(false),
  pageRepliesEnabled: z.boolean().default(false),
  nonPersonRepliesEnabled: z.boolean().default(false),
  requireGroupMention: z.boolean().default(true),
  selectedParticipantIds: z.array(z.string().trim().min(1)).default([]),
  excludedParticipantIds: z.array(z.string().trim().min(1)).default([]),
});
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

export const SettingRevisionSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  revision: z.number().int().positive(),
  settings: SystemSettingsSchema,
  changedBy: z.string(),
  reason: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type SettingRevision = z.infer<typeof SettingRevisionSchema>;
