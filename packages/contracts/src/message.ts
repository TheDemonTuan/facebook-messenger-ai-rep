import { z } from "zod";
import {
  SenderActorSchema,
  SenderKindSchema,
  ThreadKindSchema,
  ClassificationReliabilitySchema,
  TimestampProvenanceSchema,
  TimestampPrecisionSchema,
} from "./enums.js";

export const MessageDirectionSchema = z.enum(["INBOUND", "OUTBOUND"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const ClassificationEvidenceSourceSchema = z.enum([
  "GRAPH_API",
  "WEBHOOK_METADATA",
  "DOM_SELECTOR",
  "DOM_BADGE",
  "PROFILE_METADATA",
  "THREAD_METADATA",
  "HEURISTIC",
  "UNKNOWN",
]);
export type ClassificationEvidenceSource = z.infer<typeof ClassificationEvidenceSourceSchema>;

export const ClassificationEvidenceSchema = z.object({
  source: ClassificationEvidenceSourceSchema,
  signal: z.string(),
  confidence: z.number().min(0).max(1).default(1),
  details: z.record(z.string(), z.unknown()).optional().default({}),
});
export type ClassificationEvidence = z.infer<typeof ClassificationEvidenceSchema>;

export const MentionEvidenceTypeSchema = z.enum([
  "DOM_ANCHOR",
  "ENTITY_TAG",
  "WEBHOOK_MENTION",
  "TEXT_FALLBACK",
]);
export type MentionEvidenceType = z.infer<typeof MentionEvidenceTypeSchema>;

export const MentionEvidenceSchema = z.object({
  entityId: z.string(),
  profileUrl: z.string().nullable().optional(),
  mentionText: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  isVerified: z.boolean().default(true),
  evidenceType: MentionEvidenceTypeSchema.default("DOM_ANCHOR"),
  rawMetadata: z.record(z.string(), z.unknown()).optional().default({}),
});
export type MentionEvidence = z.infer<typeof MentionEvidenceSchema>;

export const TimestampDetailSchema = z.object({
  timestamp: z.coerce.date(),
  provenance: TimestampProvenanceSchema,
  precision: TimestampPrecisionSchema.default("UNKNOWN"),
  sourceLabel: z.string().optional(),
});
export type TimestampDetail = z.infer<typeof TimestampDetailSchema>;

export const MessageTimestampsSchema = z.object({
  facebookEvent: TimestampDetailSchema.nullable().optional(),
  observed: TimestampDetailSchema,
});
export type MessageTimestamps = z.infer<typeof MessageTimestampsSchema>;

export const VerifiedParticipantIdentitySchema = z.object({
  channelAccountId: z.string(),
  participantId: z.string(),
  senderKind: SenderKindSchema,
  isVerified: z.boolean().default(false),
  profileUrl: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  verifiedAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
export type VerifiedParticipantIdentity = z.infer<typeof VerifiedParticipantIdentitySchema>;

export function formatChannelScopedParticipantId(channelAccountId: string, participantId: string): string {
  return `${channelAccountId}:${participantId}`;
}

export function createMessageTimestamps(options: {
  observedAt?: Date | string | number;
  facebookEventAt?: Date | string | number | null;
  facebookPrecision?: z.infer<typeof TimestampPrecisionSchema>;
  observedPrecision?: z.infer<typeof TimestampPrecisionSchema>;
  facebookSourceLabel?: string;
  observedSourceLabel?: string;
}): MessageTimestamps {
  return {
    facebookEvent: options.facebookEventAt
      ? {
          timestamp: new Date(options.facebookEventAt),
          provenance: "FACEBOOK_EVENT",
          precision: options.facebookPrecision ?? "MINUTE",
          sourceLabel: options.facebookSourceLabel,
        }
      : null,
    observed: {
      timestamp: options.observedAt ? new Date(options.observedAt) : new Date(),
      provenance: "OBSERVED",
      precision: options.observedPrecision ?? "MILLISECOND",
      sourceLabel: options.observedSourceLabel,
    },
  };
}

export const MessageSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  externalMessageId: z.string(),
  direction: MessageDirectionSchema,
  actor: SenderActorSchema,
  text: z.string(),
  textHash: z.string(),
  inboundVersion: z.number().int().nonnegative(),
  responseIndex: z.number().int().nonnegative().default(0),
  timestamp: z.coerce.date(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createdAt: z.coerce.date(),
  threadKind: ThreadKindSchema.optional(),
  senderKind: SenderKindSchema.optional(),
  threadReliability: ClassificationReliabilitySchema.optional(),
  senderReliability: ClassificationReliabilitySchema.optional(),
  participantIdentity: VerifiedParticipantIdentitySchema.nullable().optional(),
  mentions: z.array(MentionEvidenceSchema).optional(),
  timestamps: MessageTimestampsSchema.optional(),
  threadEvidence: z.array(ClassificationEvidenceSchema).optional(),
  senderEvidence: z.array(ClassificationEvidenceSchema).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const InboundMessageSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string(),
  senderExternalId: z.string().nullable().optional(),
  text: z.string(),
  textHash: z.string(),
  inboundVersion: z.number().int().default(1),
  receivedAt: z.coerce.date(),
  rawPayload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.coerce.date(),
  threadKind: ThreadKindSchema.optional(),
  senderKind: SenderKindSchema.optional(),
  threadReliability: ClassificationReliabilitySchema.optional(),
  senderReliability: ClassificationReliabilitySchema.optional(),
  participantIdentity: VerifiedParticipantIdentitySchema.nullable().optional(),
  mentions: z.array(MentionEvidenceSchema).optional(),
  timestamps: MessageTimestampsSchema.optional(),
  threadEvidence: z.array(ClassificationEvidenceSchema).optional(),
  senderEvidence: z.array(ClassificationEvidenceSchema).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const InboundMessagePayloadSchema = z.object({
  channelAccountId: z.string(),
  externalThreadId: z.string(),
  externalThreadRef: z.string(),
  externalCustomerId: z.string(),
  customerName: z.string().nullable().optional(),
  externalMessageId: z.string(),
  text: z.string(),
  timestamp: z.coerce.date(),
  threadKind: ThreadKindSchema.optional(),
  senderKind: SenderKindSchema.optional(),
  threadReliability: ClassificationReliabilitySchema.optional(),
  senderReliability: ClassificationReliabilitySchema.optional(),
  participantIdentity: VerifiedParticipantIdentitySchema.nullable().optional(),
  mentions: z.array(MentionEvidenceSchema).optional(),
  timestamps: MessageTimestampsSchema.optional(),
  threadEvidence: z.array(ClassificationEvidenceSchema).optional(),
  senderEvidence: z.array(ClassificationEvidenceSchema).optional(),
});
export type InboundMessagePayload = z.infer<typeof InboundMessagePayloadSchema>;
