import { z } from "zod";

export const ALLOWED_AI_MODELS = [
  "grok-4.5",
  "grok-4.5-mini",
  "grok-beta",
  "grok-2",
  "grok-2-latest",
  "grok-2-vision-1212",
  "grok-3",
  "grok-3-mini",
  "test-model",
] as const;

export function isValidAiModel(model: string): boolean {
  return (
    ALLOWED_AI_MODELS.includes(model as (typeof ALLOWED_AI_MODELS)[number]) ||
    /^grok-[a-z0-9.-]+$/i.test(model) ||
    model === "test-model"
  );
}

export const SystemSettingsSchema = z.object({
  debounceMs: z.number().int().min(500).max(30000).default(3000),
  stickyWindowMs: z.number().int().min(5000).max(300000).default(45000),
  stickyMaxTurns: z.number().int().min(1).max(10).default(3),
  stickyMaxDurationMs: z.number().int().min(10000).max(600000).default(120000),
  aiModel: z.string().min(1).default("grok-4.5").refine(isValidAiModel, {
    message: "Invalid AI model. Allowed models must be from the approved xAI list.",
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
