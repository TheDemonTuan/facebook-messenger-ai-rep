import { z } from "zod";

export const UserRoleSchema = z.enum(["OWNER", "OPERATOR", "VIEWER"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const ConversationStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "DEBOUNCING",
  "READING",
  "THINKING",
  "DRAFT_READY",
  "TYPING",
  "SENDING",
  "WAITING_CUSTOMER",
  "MANUAL",
  "BLOCKED",
  "ERROR",
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ChannelStatusSchema = z.enum([
  "RUNNING",
  "PAUSED",
  "SUSPENDED",
  "DEGRADED",
  "ERROR",
]);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const OutboundActionStatusSchema = z.enum([
  "PENDING",
  "TYPING",
  "SEND_INTENT",
  "CONFIRMED",
  "SEND_UNCERTAIN",
  "RETRY_APPROVED",
  "CANCELLED",
  "FAILED",
  // Legacy aliases for backwards compatibility
  "SENDING",
  "SENT",
  "ABORTED",
  "UNCONFIRMED",
]);
export type OutboundActionStatus = z.infer<typeof OutboundActionStatusSchema>;

export const JobStatusSchema = z.enum([
  "READY",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TurnStatusSchema = z.enum([
  "PENDING",
  "THINKING",
  "DRAFT_READY",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const OutboxStatusSchema = z.enum([
  "PENDING",
  "PROCESSED",
  "FAILED",
]);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const EventTypeSchema = z.enum([
  "INBOUND_RECEIVED",
  "DEBOUNCE_STARTED",
  "DEBOUNCE_RESET",
  "CONVERSATION_QUEUED",
  "CONVERSATION_CLAIMED",
  "AI_STARTED",
  "AI_COMPLETED",
  "AI_CANCELLED_STALE",
  "DRAFT_CREATED",
  "TYPING_STARTED",
  "TYPING_ABORTED",
  "SEND_STARTED",
  "SEND_INTENT",
  "SEND_CONFIRMED",
  "SEND_UNCERTAIN",
  "SEND_UNCONFIRMED",
  "CONVERSATION_RELEASED",
  "ERROR",
  "SESSION_SUSPENDED",
  "SESSION_RESUMED",
  "MANUAL_TAKEOVER",
  "MANUAL_RELEASED",
  "SETTING_CHANGED",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const IncidentTypeSchema = z.enum([
  "DOM_CHANGED",
  "CHECKPOINT",
  "UNCONFIRMED_SEND",
  "SEND_UNCERTAIN",
  "RATE_LIMITED",
  "CHANNEL_SUSPENDED",
  "AI_ERROR",
  "SYSTEM_ERROR",
]);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const IncidentStatusSchema = z.enum([
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const SenderActorSchema = z.enum([
  "AI",
  "MANUAL_OWNER",
  "SYSTEM",
]);
export type SenderActor = z.infer<typeof SenderActorSchema>;

export const ChannelAccountTypeSchema = z.enum([
  "PERSONAL_MESSENGER",
  "FACEBOOK_PAGE",
]);
export type ChannelAccountType = z.infer<typeof ChannelAccountTypeSchema>;

export const ReplyModeSchema = z.enum([
  "EVERYONE_EXCEPT",
  "ONLY_SELECTED",
]);
export type ReplyMode = z.infer<typeof ReplyModeSchema>;

export const ThreadKindSchema = z.enum([
  "DIRECT",
  "GROUP",
  "UNKNOWN",
]);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

export const SenderKindSchema = z.enum([
  "PERSON",
  "PAGE",
  "NON_PERSON",
  "UNKNOWN",
]);
export type SenderKind = z.infer<typeof SenderKindSchema>;

export const ClassificationReliabilitySchema = z.enum([
  "VERIFIED",
  "UNVERIFIED",
  "LEGACY_UNVERIFIED",
]);
export type ClassificationReliability = z.infer<typeof ClassificationReliabilitySchema>;

export const TimestampProvenanceSchema = z.enum([
  "FACEBOOK_EVENT",
  "OBSERVED",
  "SYSTEM",
  "UNKNOWN",
]);
export type TimestampProvenance = z.infer<typeof TimestampProvenanceSchema>;

export const TimestampPrecisionSchema = z.enum([
  "MILLISECOND",
  "SECOND",
  "MINUTE",
  "APPROXIMATE",
  "UNKNOWN",
]);
export type TimestampPrecision = z.infer<typeof TimestampPrecisionSchema>;

export const ReplyEligibilityDecisionSchema = z.enum([
  "ELIGIBLE",
  "INELIGIBLE",
]);
export type ReplyEligibilityDecision = z.infer<typeof ReplyEligibilityDecisionSchema>;

export const ReplyEligibilityReasonCodeSchema = z.enum([
  "ELIGIBLE",
  // Hard gates
  "AUTO_REPLY_DISABLED",
  "INTAKE_PAUSED",
  "CHANNEL_SUSPENDED",
  "CHANNEL_PAUSED",
  "CONVERSATION_BLOCKED",
  "CONVERSATION_MANUAL_MODE",
  "STALE_INBOUND_VERSION",
  "DIRECTION_NOT_INBOUND",
  "SELF_MESSAGE",
  // Verified classification
  "UNKNOWN_THREAD_KIND",
  "UNVERIFIED_THREAD_CLASSIFICATION",
  "UNKNOWN_SENDER_KIND",
  "UNVERIFIED_SENDER_CLASSIFICATION",
  "UNVERIFIED_PARTICIPANT_IDENTITY",
  // Source controls
  "DIRECT_REPLIES_DISABLED",
  "GROUP_REPLIES_DISABLED",
  // PERSON list mode
  "PERSON_EXCLUDED",
  "PERSON_NOT_SELECTED",
  // Page / Non-person controls
  "PAGE_REPLIES_DISABLED",
  "NON_PERSON_REPLIES_DISABLED",
  // Group verified-mention requirement
  "GROUP_MENTION_REQUIRED",
  "GROUP_MENTION_UNVERIFIED",
]);
export type ReplyEligibilityReasonCode = z.infer<typeof ReplyEligibilityReasonCodeSchema>;

export const ReplyPrecedenceStepSchema = z.enum([
  "HARD_GATES",
  "VERIFIED_CLASSIFICATION",
  "SOURCE_CONTROLS",
  "PERSON_LIST_MODE",
  "PAGE_NON_PERSON_CONTROLS",
  "GROUP_MENTION_REQUIREMENT",
  "ELIGIBLE",
]);
export type ReplyPrecedenceStep = z.infer<typeof ReplyPrecedenceStepSchema>;
