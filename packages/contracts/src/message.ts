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
  source: ClassificationEvidenceSourceSchema.default("UNKNOWN"),
  signal: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
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
  isVerified: z.boolean().default(false),
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
    facebookEvent:
      options.facebookEventAt != null
        ? {
            timestamp: new Date(options.facebookEventAt),
            provenance: "FACEBOOK_EVENT",
            precision: options.facebookPrecision ?? "MINUTE",
            sourceLabel: options.facebookSourceLabel,
          }
        : null,
    observed: {
      timestamp: options.observedAt != null ? new Date(options.observedAt) : new Date(),
      provenance: "OBSERVED",
      precision: options.observedPrecision ?? "MILLISECOND",
      sourceLabel: options.observedSourceLabel,
    },
  };
}

/**
 * Validates whether a raw URL belongs to an approved Facebook hostname.
 */
export function isApprovedFacebookUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

/**
 * Normalizes an approved Facebook profile/entity URL into canonical form.
 * Returns null if the URL is invalid, untrusted, or ambiguous.
 */
export function canonicalizeFacebookUrl(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    const isFacebook = hostname === "facebook.com" || hostname.endsWith(".facebook.com");
    if (!isFacebook) {
      return null;
    }

    // Strip trailing slashes
    const pathname = parsed.pathname.replace(/\/+$/, "");

    // Reject ambiguous or non-identity paths
    const lowerPath = pathname.toLowerCase();
    if (
      lowerPath === "" ||
      lowerPath === "/" ||
      lowerPath.startsWith("/messages") ||
      lowerPath.startsWith("/chat") ||
      lowerPath.startsWith("/home") ||
      lowerPath.startsWith("/login") ||
      lowerPath.startsWith("/recover") ||
      lowerPath.startsWith("/help") ||
      lowerPath.startsWith("/settings") ||
      lowerPath.startsWith("/privacy") ||
      lowerPath.startsWith("/watch") ||
      lowerPath.startsWith("/marketplace")
    ) {
      return null;
    }

    // If profile.php?id=<digits>
    if (pathname.toLowerCase() === "/profile.php") {
      const id = parsed.searchParams.get("id");
      if (id && /^\d+$/.test(id.trim())) {
        return `https://www.facebook.com/profile.php?id=${id.trim()}`;
      }
      return null;
    }

    // Canonicalize to https://www.facebook.com/<username>
    return `https://www.facebook.com${pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Extracts a stable Facebook entity ID from a raw ID or approved Facebook profile URL.
 */
export function extractFacebookEntityId(urlOrId: string): string | null {
  if (!urlOrId || typeof urlOrId !== "string") return null;
  const trimmed = urlOrId.trim();
  if (!trimmed) return null;

  // If already an alphanumeric ID without slashes or domain dots
  if (/^[a-zA-Z0-9._-]+$/.test(trimmed) && !trimmed.includes("/") && !trimmed.includes(".com")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!isApprovedFacebookUrl(trimmed)) return null;

    if (parsed.pathname.toLowerCase() === "/profile.php") {
      const id = parsed.searchParams.get("id");
      if (id && id.trim().length > 0) {
        return id.trim();
      }
    }
    const match = parsed.pathname.match(/\/messages\/t\/([0-9]+)/);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // Not a URL
  }
  return null;
}

// Single source of truth for message classification & evidence fields
export const MessageClassificationFields = {
  threadKind: ThreadKindSchema.optional(),
  senderKind: SenderKindSchema.optional(),
  threadReliability: ClassificationReliabilitySchema.optional(),
  senderReliability: ClassificationReliabilitySchema.optional(),
  participantIdentity: VerifiedParticipantIdentitySchema.nullable().optional(),
  mentions: z.array(MentionEvidenceSchema).optional(),
  timestamps: MessageTimestampsSchema.optional(),
  threadEvidence: z.array(ClassificationEvidenceSchema).optional(),
  senderEvidence: z.array(ClassificationEvidenceSchema).optional(),
};

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
}).extend(MessageClassificationFields);
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
}).extend(MessageClassificationFields);
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
}).extend(MessageClassificationFields);
export type InboundMessagePayload = z.infer<typeof InboundMessagePayloadSchema>;
