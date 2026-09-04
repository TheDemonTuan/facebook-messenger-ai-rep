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
