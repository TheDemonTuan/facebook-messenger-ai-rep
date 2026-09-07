import type { NonSecretSettings } from "../types";

/**
 * Strips secret fields (aiBaseUrl, aiApiKey) from settings before saving or displaying.
 * Only model, pacing, persona, and non-secret operational parameters are preserved.
 */
export function sanitizeSettingsForSave(
  input: Record<string, unknown>
): Partial<NonSecretSettings> {
  const sanitized: Partial<NonSecretSettings> = {};

  if (typeof input.aiModel === "string" && input.aiModel.trim().length > 0) {
    sanitized.aiModel = input.aiModel.trim();
  }
  if (typeof input.debounceMs === "number" && !isNaN(input.debounceMs)) {
    sanitized.debounceMs = Math.max(500, Math.min(30000, input.debounceMs));
  }
  if (typeof input.stickyWindowMs === "number" && !isNaN(input.stickyWindowMs)) {
    sanitized.stickyWindowMs = Math.max(5000, Math.min(300000, input.stickyWindowMs));
  }
  if (typeof input.stickyMaxTurns === "number" && !isNaN(input.stickyMaxTurns)) {
    sanitized.stickyMaxTurns = Math.max(1, Math.min(10, input.stickyMaxTurns));
  }
  if (typeof input.stickyMaxDurationMs === "number" && !isNaN(input.stickyMaxDurationMs)) {
    sanitized.stickyMaxDurationMs = Math.max(10000, Math.min(600000, input.stickyMaxDurationMs));
  }
  if (typeof input.aiTimeoutMs === "number" && !isNaN(input.aiTimeoutMs)) {
    sanitized.aiTimeoutMs = Math.max(3000, Math.min(60000, input.aiTimeoutMs));
  }
  if (typeof input.aiMaxResponseCount === "number" && !isNaN(input.aiMaxResponseCount)) {
    sanitized.aiMaxResponseCount = Math.max(1, Math.min(3, input.aiMaxResponseCount));
  }
  if (typeof input.aiTotalMaxChars === "number" && !isNaN(input.aiTotalMaxChars)) {
    sanitized.aiTotalMaxChars = Math.max(100, Math.min(2000, input.aiTotalMaxChars));
  }
  if (typeof input.aiSystemPersona === "string") {
    sanitized.aiSystemPersona = input.aiSystemPersona;
  }
  if (typeof input.businessProfile === "string") {
    sanitized.businessProfile = input.businessProfile;
  }
  if (typeof input.typingTargetWpmMin === "number" && !isNaN(input.typingTargetWpmMin)) {
    sanitized.typingTargetWpmMin = Math.max(20, Math.min(300, input.typingTargetWpmMin));
  }
  if (typeof input.typingTargetWpmMax === "number" && !isNaN(input.typingTargetWpmMax)) {
    sanitized.typingTargetWpmMax = Math.max(20, Math.min(300, input.typingTargetWpmMax));
  }
  if (typeof input.busyMode === "boolean") {
    sanitized.busyMode = input.busyMode;
  }
  if (typeof input.autoReplyEnabled === "boolean") {
    sanitized.autoReplyEnabled = input.autoReplyEnabled;
  }
  if (typeof input.pauseIntakeProcessing === "boolean") {
    sanitized.pauseIntakeProcessing = input.pauseIntakeProcessing;
  }
  if (typeof input.businessTimeZone === "string" && input.businessTimeZone.trim().length > 0) {
    sanitized.businessTimeZone = input.businessTimeZone.trim();
  }
  if (input.replyMode === "EVERYONE_EXCEPT" || input.replyMode === "ONLY_SELECTED") {
    sanitized.replyMode = input.replyMode;
  }
  if (typeof input.directRepliesEnabled === "boolean") {
    sanitized.directRepliesEnabled = input.directRepliesEnabled;
  }
  if (typeof input.groupRepliesEnabled === "boolean") {
    sanitized.groupRepliesEnabled = input.groupRepliesEnabled;
  }
  if (typeof input.pageRepliesEnabled === "boolean") {
    sanitized.pageRepliesEnabled = input.pageRepliesEnabled;
  }
  if (typeof input.nonPersonRepliesEnabled === "boolean") {
    sanitized.nonPersonRepliesEnabled = input.nonPersonRepliesEnabled;
  }
  if (typeof input.requireGroupMention === "boolean") {
    sanitized.requireGroupMention = input.requireGroupMention;
  }
  if (Array.isArray(input.selectedParticipantIds)) {
    sanitized.selectedParticipantIds = (input.selectedParticipantIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
  }
  if (Array.isArray(input.excludedParticipantIds)) {
    sanitized.excludedParticipantIds = (input.excludedParticipantIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
  }

  // Human priority & handoff configuration
  if (typeof input.humanHandoffEnabled === "boolean") {
    sanitized.humanHandoffEnabled = input.humanHandoffEnabled;
  }
  if (typeof input.humanOutboundGraceMs === "number" && !isNaN(input.humanOutboundGraceMs)) {
    sanitized.humanOutboundGraceMs = Math.max(5000, Math.min(1800000, input.humanOutboundGraceMs));
  }
  if (typeof input.humanInboundResponseWaitMs === "number" && !isNaN(input.humanInboundResponseWaitMs)) {
    sanitized.humanInboundResponseWaitMs = Math.max(5000, Math.min(600000, input.humanInboundResponseWaitMs));
  }
  if (typeof input.humanDraftLeaseMs === "number" && !isNaN(input.humanDraftLeaseMs)) {
    sanitized.humanDraftLeaseMs = Math.max(5000, Math.min(300000, input.humanDraftLeaseMs));
  }
  if (typeof input.humanSessionMaxMs === "number" && !isNaN(input.humanSessionMaxMs)) {
    sanitized.humanSessionMaxMs = Math.max(30000, Math.min(3600000, input.humanSessionMaxMs));
  }
  if (typeof input.autoResumeAfterHuman === "boolean") {
    sanitized.autoResumeAfterHuman = input.autoResumeAfterHuman;
  }

  // Eligibility-first persistence configuration
  if (input.persistenceMode === "ELIGIBLE_ONLY" || input.persistenceMode === "ALL_OBSERVED") {
    sanitized.persistenceMode = input.persistenceMode;
  }
  if (typeof input.persistExcludedInbound === "boolean") {
    sanitized.persistExcludedInbound = input.persistExcludedInbound;
  }
  if (typeof input.persistDropTelemetry === "boolean") {
    sanitized.persistDropTelemetry = input.persistDropTelemetry;
  }

  // Safety invariant: NEVER include aiBaseUrl or aiApiKey in output
  delete (sanitized as Record<string, unknown>).aiBaseUrl;
  delete (sanitized as Record<string, unknown>).aiApiKey;

  return sanitized;
}

/**
 * Checks if a settings object contains any secret field keys.
 */
export function hasSecretFields(settings: Record<string, unknown>): boolean {
  return "aiApiKey" in settings || "aiBaseUrl" in settings;
}
