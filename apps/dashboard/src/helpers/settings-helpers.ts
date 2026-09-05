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
    sanitized.aiMaxResponseCount = Math.max(1, Math.min(5, input.aiMaxResponseCount));
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
