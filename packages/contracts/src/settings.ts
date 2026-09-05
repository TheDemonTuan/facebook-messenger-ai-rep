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

// Single source of truth for SystemSettings field shapes without defaults
export const SystemSettingsBaseShape = {
  debounceMs: z.number().int().min(500).max(30000),
  stickyWindowMs: z.number().int().min(5000).max(300000),
  stickyMaxTurns: z.number().int().min(1).max(10),
  stickyMaxDurationMs: z.number().int().min(10000).max(600000),
  aiModel: z.string().trim().min(1).refine(isValidAiModel, {
    message: "Invalid AI model name.",
  }),
  aiTimeoutMs: z.number().int().min(2000).max(60000),
  aiMaxResponseCount: z.number().int().min(1).max(3),
  aiTotalMaxChars: z.number().int().min(50).max(2000),
  aiSystemPersona: z.string().min(1),
  businessProfile: z.string(),
  typingTargetWpmMin: z.number().int().min(20).max(300),
  typingTargetWpmMax: z.number().int().min(20).max(300),
  busyMode: z.boolean(),
  autoReplyEnabled: z.boolean(),
  pauseIntakeProcessing: z.boolean(),
  businessTimeZone: z.string().refine(isValidTimeZone, {
    message: "Invalid IANA time zone identifier.",
  }),
  replyMode: ReplyModeSchema,
  directRepliesEnabled: z.boolean(),
  groupRepliesEnabled: z.boolean(),
  pageRepliesEnabled: z.boolean(),
  nonPersonRepliesEnabled: z.boolean(),
  requireGroupMention: z.boolean(),
  selectedParticipantIds: z.array(z.string().trim().min(1)),
  excludedParticipantIds: z.array(z.string().trim().min(1)),
};

// Default values for full system settings
export const SystemSettingsDefaults = {
  debounceMs: 3000,
  stickyWindowMs: 45000,
  stickyMaxTurns: 3,
  stickyMaxDurationMs: 120000,
  aiModel: "auto/best-chat",
  aiTimeoutMs: 20000,
  aiMaxResponseCount: 3,
  aiTotalMaxChars: 480,
  aiSystemPersona:
    "Bạn là nhân viên CSKH duy nhất, nhiệt tình, lịch sự, ngắn gọn và trung thực. Chỉ trả lời dựa trên thông tin được cung cấp, không bịa thông tin về giá, đơn hàng, chính sách nếu chưa có dữ liệu rõ ràng. Nếu thiếu dữ kiện cần thiết, hãy lịch sự hỏi đúng 1 câu tối thiểu.",
  businessProfile: "Shop tư vấn và hỗ trợ khách hàng trực tuyến.",
  typingTargetWpmMin: 55,
  typingTargetWpmMax: 65,
  busyMode: false,
  autoReplyEnabled: true,
  pauseIntakeProcessing: false,
  businessTimeZone: "Asia/Ho_Chi_Minh",
  replyMode: "EVERYONE_EXCEPT" as const,
  directRepliesEnabled: true,
  groupRepliesEnabled: false,
  pageRepliesEnabled: false,
  nonPersonRepliesEnabled: false,
  requireGroupMention: true,
  selectedParticipantIds: [] as string[],
  excludedParticipantIds: [] as string[],
};

// Patch schema for partial updates without default population
export const SystemSettingsPatchSchema = z.object(SystemSettingsBaseShape).partial();
export type SystemSettingsPatch = z.infer<typeof SystemSettingsPatchSchema>;

export const SystemSettingsSchema = z.object({
  debounceMs: SystemSettingsBaseShape.debounceMs.default(SystemSettingsDefaults.debounceMs),
  stickyWindowMs: SystemSettingsBaseShape.stickyWindowMs.default(SystemSettingsDefaults.stickyWindowMs),
  stickyMaxTurns: SystemSettingsBaseShape.stickyMaxTurns.default(SystemSettingsDefaults.stickyMaxTurns),
  stickyMaxDurationMs: SystemSettingsBaseShape.stickyMaxDurationMs.default(SystemSettingsDefaults.stickyMaxDurationMs),
  aiModel: SystemSettingsBaseShape.aiModel.default(SystemSettingsDefaults.aiModel),
  aiTimeoutMs: SystemSettingsBaseShape.aiTimeoutMs.default(SystemSettingsDefaults.aiTimeoutMs),
  aiMaxResponseCount: SystemSettingsBaseShape.aiMaxResponseCount.default(SystemSettingsDefaults.aiMaxResponseCount),
  aiTotalMaxChars: SystemSettingsBaseShape.aiTotalMaxChars.default(SystemSettingsDefaults.aiTotalMaxChars),
  aiSystemPersona: SystemSettingsBaseShape.aiSystemPersona.default(SystemSettingsDefaults.aiSystemPersona),
  businessProfile: SystemSettingsBaseShape.businessProfile.default(SystemSettingsDefaults.businessProfile),
  typingTargetWpmMin: SystemSettingsBaseShape.typingTargetWpmMin.default(SystemSettingsDefaults.typingTargetWpmMin),
  typingTargetWpmMax: SystemSettingsBaseShape.typingTargetWpmMax.default(SystemSettingsDefaults.typingTargetWpmMax),
  busyMode: SystemSettingsBaseShape.busyMode.default(SystemSettingsDefaults.busyMode),
  autoReplyEnabled: SystemSettingsBaseShape.autoReplyEnabled.default(SystemSettingsDefaults.autoReplyEnabled),
  pauseIntakeProcessing: SystemSettingsBaseShape.pauseIntakeProcessing.default(SystemSettingsDefaults.pauseIntakeProcessing),
  businessTimeZone: SystemSettingsBaseShape.businessTimeZone.default(SystemSettingsDefaults.businessTimeZone),
  replyMode: SystemSettingsBaseShape.replyMode.default(SystemSettingsDefaults.replyMode),
  directRepliesEnabled: SystemSettingsBaseShape.directRepliesEnabled.default(SystemSettingsDefaults.directRepliesEnabled),
  groupRepliesEnabled: SystemSettingsBaseShape.groupRepliesEnabled.default(SystemSettingsDefaults.groupRepliesEnabled),
  pageRepliesEnabled: SystemSettingsBaseShape.pageRepliesEnabled.default(SystemSettingsDefaults.pageRepliesEnabled),
  nonPersonRepliesEnabled: SystemSettingsBaseShape.nonPersonRepliesEnabled.default(SystemSettingsDefaults.nonPersonRepliesEnabled),
  requireGroupMention: SystemSettingsBaseShape.requireGroupMention.default(SystemSettingsDefaults.requireGroupMention),
  selectedParticipantIds: SystemSettingsBaseShape.selectedParticipantIds.default(SystemSettingsDefaults.selectedParticipantIds),
  excludedParticipantIds: SystemSettingsBaseShape.excludedParticipantIds.default(SystemSettingsDefaults.excludedParticipantIds),
});

// Override .partial() so partial update callers do not get whole-object default resets
(SystemSettingsSchema as unknown as { partial: () => typeof SystemSettingsPatchSchema }).partial =
  () => SystemSettingsPatchSchema;

export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

/**
 * Safely merges a partial settings patch into an existing full settings object without resetting unspecified fields.
 */
export function mergeSystemSettings(
  existing: SystemSettings,
  patch: Partial<SystemSettings> | SystemSettingsPatch
): SystemSettings {
  const cleanPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      cleanPatch[key] = value;
    }
  }
  return SystemSettingsSchema.parse({
    ...existing,
    ...cleanPatch,
  });
}

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

