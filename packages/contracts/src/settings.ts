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

import { isValidTimeZone, resolveBusinessTimeZone, DEFAULT_BUSINESS_TIMEZONE } from "./time.js";
export { isValidTimeZone, resolveBusinessTimeZone, DEFAULT_BUSINESS_TIMEZONE };

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
  contextMaxInputTokens: z.number().int().min(512).max(32768).optional(),
  contextMaxMessages: z.number().int().min(2).max(50).optional(),
  contextMaxInboundMessages: z.number().int().min(1).max(25).optional(),
  contextMaxMessagesPerSender: z.number().int().min(1).max(25).optional(),
  contextHistoryMaxAgeHours: z.number().int().min(1).max(168).optional(),
  aiMaxOutputTokens: z.number().int().min(50).max(4096).optional(),
  // Human priority & handoff configuration
  humanHandoffEnabled: z.boolean(),
  humanOutboundGraceMs: z.number().int().min(5000).max(30 * 60 * 1000),
  humanInboundResponseWaitMs: z.number().int().min(5000).max(10 * 60 * 1000),
  humanDraftLeaseMs: z.number().int().min(5000).max(5 * 60 * 1000),
  humanSessionMaxMs: z.number().int().min(30000).max(60 * 60 * 1000),
  autoResumeAfterHuman: z.boolean(),
  // Eligibility-first persistence configuration
  persistenceMode: z.enum(["ELIGIBLE_ONLY", "ALL_OBSERVED"]),
  persistExcludedInbound: z.boolean(),
  persistDropTelemetry: z.boolean(),
  // Media enrichment & vision capabilities
  mediaMaxAttachmentsPerTurn: z.number().int().min(1).max(10).optional(),
  mediaImageMaxBytes: z.number().int().min(1024).max(50 * 1024 * 1024).optional(),
  mediaVoiceMaxBytes: z.number().int().min(1024).max(50 * 1024 * 1024).optional(),
  mediaVoiceMaxDurationSec: z.number().int().min(10).max(600).optional(),
  providerCapabilities: z.record(z.string(), z.boolean()).optional(),
};

// Default values for full system settings
export const SystemSettingsDefaults = {
  debounceMs: 8000,
  stickyWindowMs: 45000,
  stickyMaxTurns: 3,
  stickyMaxDurationMs: 120000,
  aiModel: "auto/best-chat",
  aiTimeoutMs: 20000,
  aiMaxResponseCount: 1,
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
  contextMaxInputTokens: 4096,
  contextMaxMessages: 12,
  contextMaxInboundMessages: 6,
  contextMaxMessagesPerSender: 6,
  contextHistoryMaxAgeHours: 24,
  aiMaxOutputTokens: 384,
  humanHandoffEnabled: true,
  humanOutboundGraceMs: 120_000,
  humanInboundResponseWaitMs: 60_000,
  humanDraftLeaseMs: 30_000,
  humanSessionMaxMs: 10 * 60_000,
  autoResumeAfterHuman: true,
  persistenceMode: "ELIGIBLE_ONLY" as const,
  persistExcludedInbound: false,
  persistDropTelemetry: true,
  mediaMaxAttachmentsPerTurn: 4,
  mediaImageMaxBytes: 10 * 1024 * 1024,
  mediaVoiceMaxBytes: 15 * 1024 * 1024,
  mediaVoiceMaxDurationSec: 120,
  providerCapabilities: {},
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
  contextMaxInputTokens: SystemSettingsBaseShape.contextMaxInputTokens.default(SystemSettingsDefaults.contextMaxInputTokens),
  contextMaxMessages: SystemSettingsBaseShape.contextMaxMessages.default(SystemSettingsDefaults.contextMaxMessages),
  contextMaxInboundMessages: SystemSettingsBaseShape.contextMaxInboundMessages.default(SystemSettingsDefaults.contextMaxInboundMessages),
  contextMaxMessagesPerSender: SystemSettingsBaseShape.contextMaxMessagesPerSender.default(SystemSettingsDefaults.contextMaxMessagesPerSender),
  contextHistoryMaxAgeHours: SystemSettingsBaseShape.contextHistoryMaxAgeHours.default(SystemSettingsDefaults.contextHistoryMaxAgeHours),
  aiMaxOutputTokens: SystemSettingsBaseShape.aiMaxOutputTokens.default(SystemSettingsDefaults.aiMaxOutputTokens),
  humanHandoffEnabled: SystemSettingsBaseShape.humanHandoffEnabled.default(SystemSettingsDefaults.humanHandoffEnabled),
  humanOutboundGraceMs: SystemSettingsBaseShape.humanOutboundGraceMs.default(SystemSettingsDefaults.humanOutboundGraceMs),
  humanInboundResponseWaitMs: SystemSettingsBaseShape.humanInboundResponseWaitMs.default(SystemSettingsDefaults.humanInboundResponseWaitMs),
  humanDraftLeaseMs: SystemSettingsBaseShape.humanDraftLeaseMs.default(SystemSettingsDefaults.humanDraftLeaseMs),
  humanSessionMaxMs: SystemSettingsBaseShape.humanSessionMaxMs.default(SystemSettingsDefaults.humanSessionMaxMs),
  autoResumeAfterHuman: SystemSettingsBaseShape.autoResumeAfterHuman.default(SystemSettingsDefaults.autoResumeAfterHuman),
  persistenceMode: SystemSettingsBaseShape.persistenceMode.default(SystemSettingsDefaults.persistenceMode),
  persistExcludedInbound: SystemSettingsBaseShape.persistExcludedInbound.default(SystemSettingsDefaults.persistExcludedInbound),
  persistDropTelemetry: SystemSettingsBaseShape.persistDropTelemetry.default(SystemSettingsDefaults.persistDropTelemetry),
  mediaMaxAttachmentsPerTurn: SystemSettingsBaseShape.mediaMaxAttachmentsPerTurn.default(SystemSettingsDefaults.mediaMaxAttachmentsPerTurn),
  mediaImageMaxBytes: SystemSettingsBaseShape.mediaImageMaxBytes.default(SystemSettingsDefaults.mediaImageMaxBytes),
  mediaVoiceMaxBytes: SystemSettingsBaseShape.mediaVoiceMaxBytes.default(SystemSettingsDefaults.mediaVoiceMaxBytes),
  mediaVoiceMaxDurationSec: SystemSettingsBaseShape.mediaVoiceMaxDurationSec.default(SystemSettingsDefaults.mediaVoiceMaxDurationSec),
  providerCapabilities: SystemSettingsBaseShape.providerCapabilities.default(SystemSettingsDefaults.providerCapabilities),
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

