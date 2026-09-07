import { z } from "zod";
import {
  SenderActorSchema,
  SenderKindSchema,
  ThreadKindSchema,
  ClassificationReliabilitySchema,
  TimestampProvenanceSchema,
  TimestampPrecisionSchema,
  ContentStatusSchema,
  type ContentStatus,
  MediaRoleSchema,
  ShareOriginSchema,
  ShareAccessSchema,
  MessageEventKindSchema,
  type MessageEventKind,
  ContentQualitySchema,
  IdentityQualitySchema,
  DirectionQualitySchema,
  ParseQualitySchema,
  ReplyAvailabilitySchema,
} from "./enums.js";
import { DerivedTranscriptSchema } from "./ai.js";

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
  senderExternalId: z.string().nullable().optional(),
  senderParticipantId: z.string().nullable().optional(),
  senderDisplayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  mentions: z.array(MentionEvidenceSchema).optional(),
  timestamps: MessageTimestampsSchema.optional(),
  eventTimestamp: z.coerce.date().nullable().optional(),
  observedTimestamp: z.coerce.date().nullable().optional(),
  timestampProvenance: TimestampProvenanceSchema.optional(),
  timestampPrecision: TimestampPrecisionSchema.optional(),
  threadEvidence: z.array(ClassificationEvidenceSchema).optional(),
  senderEvidence: z.array(ClassificationEvidenceSchema).optional(),
};

// --- PR-03 Message Parts & Rich Content Schemas ---

export const MediaRefSchema = z.object({
  mediaId: z.string().min(1).max(256),
  mediaRefId: z.string().max(256).optional(),
  role: MediaRoleSchema.default("ATTACHMENT"),
  mimeType: z.string().max(128).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  status: ContentStatusSchema.default("READY"),
  sourceUrl: z.string().max(2048).optional(),
  storagePath: z.string().max(1024).optional(),
  thumbnailRef: z.string().max(256).optional(),
  fileName: z.string().max(256).optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

export const TextPartSchema = z.object({
  type: z.literal("TEXT"),
  text: z.string().max(10000),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ImagePartSchema = z.object({
  type: z.literal("IMAGE"),
  media: MediaRefSchema,
  altText: z.string().max(1000).optional(),
});
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const VoicePartSchema = z.object({
  type: z.literal("VOICE"),
  media: MediaRefSchema,
  transcriptRef: z.string().max(256).optional(),
  transcript: DerivedTranscriptSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type VoicePart = z.infer<typeof VoicePartSchema>;

export const AudioPartSchema = z.object({
  type: z.literal("AUDIO"),
  media: MediaRefSchema,
  transcriptRef: z.string().max(256).optional(),
  transcript: DerivedTranscriptSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AudioPart = z.infer<typeof AudioPartSchema>;

export const VideoCoverageSchema = z.object({
  container: z.string().max(32),
  codecs: z.array(z.string().max(32)).default([]),
  durationMs: z.number().int().nonnegative().optional(),
  hasVideoTrack: z.boolean().default(true),
  hasAudioTrack: z.boolean().default(false),
  framesExtracted: z.number().int().nonnegative().default(0),
  audioExtracted: z.boolean().default(false),
  coverageStatus: z.enum(["FULL", "POSTER_ONLY", "AUDIO_ONLY", "FRAMES_AND_AUDIO", "UNSUPPORTED"]).default("POSTER_ONLY"),
  limitationReason: z.string().max(256).optional(),
});
export type VideoCoverage = z.infer<typeof VideoCoverageSchema>;

export const VideoPartSchema = z.object({
  type: z.literal("VIDEO"),
  media: MediaRefSchema,
  posterRef: z.string().max(256).optional(),
  analysisRef: z.string().max(256).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  transcript: DerivedTranscriptSchema.optional(),
  coverage: VideoCoverageSchema.optional(),
});
export type VideoPart = z.infer<typeof VideoPartSchema>;

export const StickerPartSchema = z.object({
  type: z.literal("STICKER"),
  label: z.string().max(256).optional(),
  media: MediaRefSchema.optional(),
});
export type StickerPart = z.infer<typeof StickerPartSchema>;

export const GifPartSchema = z.object({
  type: z.literal("GIF"),
  media: MediaRefSchema,
});
export type GifPart = z.infer<typeof GifPartSchema>;

export const SharePartSchema = z.object({
  type: z.literal("SHARE"),
  origin: ShareOriginSchema.default("UNKNOWN"),
  url: z.string().max(2048).optional(),
  title: z.string().max(500).optional(),
  previewText: z.string().max(2000).optional(),
  previewMedia: MediaRefSchema.optional(),
  access: ShareAccessSchema.default("UNKNOWN"),
});
export type SharePart = z.infer<typeof SharePartSchema>;

export const FilePartSchema = z.object({
  type: z.literal("FILE"),
  media: MediaRefSchema,
  fileName: z.string().max(256).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  extractedText: z.string().max(100000).optional(),
  extractedChars: z.number().int().nonnegative().optional(),
});
export type FilePart = z.infer<typeof FilePartSchema>;

export const LocationPartSchema = z.object({
  type: z.literal("LOCATION"),
  label: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type LocationPart = z.infer<typeof LocationPartSchema>;

export const ContactPartSchema = z.object({
  type: z.literal("CONTACT"),
  displayName: z.string().max(256).optional(),
  normalizedFields: z.record(z.string().max(64), z.string().max(256)).optional(),
});
export type ContactPart = z.infer<typeof ContactPartSchema>;

export const UnknownPartSchema = z.object({
  type: z.literal("UNKNOWN"),
  observedLabel: z.string().max(500).optional(),
});
export type UnknownPart = z.infer<typeof UnknownPartSchema>;

export const MessagePartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ImagePartSchema,
  VoicePartSchema,
  AudioPartSchema,
  VideoPartSchema,
  StickerPartSchema,
  GifPartSchema,
  SharePartSchema,
  FilePartSchema,
  LocationPartSchema,
  ContactPartSchema,
  UnknownPartSchema,
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const ReplyContextSchema = z.object({
  sourceMessageId: z.string().optional(),
  quotedText: z.string().max(1000).optional(),
  availability: ReplyAvailabilitySchema.default("AVAILABLE"),
});
export type ReplyContext = z.infer<typeof ReplyContextSchema>;

export const NormalizationInfoSchema = z.object({
  parserVersion: z.string().max(64).optional(),
  identityQuality: IdentityQualitySchema.optional(),
  directionQuality: DirectionQualitySchema.optional(),
  parseQuality: ParseQualitySchema.optional(),
  warnings: z.array(z.string().max(256)).optional().default([]),
});
export type NormalizationInfo = z.infer<typeof NormalizationInfoSchema>;

export const NormalizedContentSchema = z.object({
  contentSchemaVersion: z.literal(2).default(2),
  contentRevision: z.number().int().nonnegative().default(1),
  contentStatus: ContentStatusSchema.default("READY"),
  parts: z.array(MessagePartSchema).max(50).default([]),
  text: z.string().max(10000).default(""),
  replyTo: ReplyContextSchema.optional(),
  normalization: NormalizationInfoSchema.optional(),
});
export type NormalizedContent = z.infer<typeof NormalizedContentSchema>;

export function isMeaningfulPart(part: MessagePart): boolean {
  if (part.type === "TEXT") return part.text.trim().length > 0;
  if (part.type === "IMAGE" || part.type === "VOICE" || part.type === "AUDIO" || part.type === "VIDEO") return true;
  if (part.type === "STICKER" || part.type === "GIF" || part.type === "FILE") return true;
  if (part.type === "SHARE") {
    return Boolean(
      (part.url && part.url.trim()) ||
      (part.title && part.title.trim()) ||
      (part.previewText && part.previewText.trim()) ||
      part.previewMedia
    );
  }
  if (part.type === "LOCATION" || part.type === "CONTACT") return true;
  if (part.type === "UNKNOWN") return Boolean(part.observedLabel && part.observedLabel.trim().length > 0);
  return false;
}

export function isMeaningfulContent(input: {
  text?: string | null;
  parts?: MessagePart[] | null;
  eventKind?: MessageEventKind | null;
}): boolean {
  if (
    input.eventKind === "MESSAGE_UNSENT" ||
    input.eventKind === "REACTION_CHANGED" ||
    input.eventKind === "DELIVERY_UPDATED" ||
    input.eventKind === "PRESENCE_CHANGED" ||
    input.eventKind === "THREAD_UPDATED" ||
    input.eventKind === "SYSTEM_NOTICE"
  ) {
    return true;
  }
  if (input.text && input.text.trim().length > 0) {
    return true;
  }
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    return input.parts.some(isMeaningfulPart);
  }
  return false;
}

export function normalizeMessageContent(input: {
  text?: string | null;
  parts?: MessagePart[] | null;
  content?: NormalizedContent | null;
  contentStatus?: ContentStatus | null;
  contentRevision?: number | null;
  eventKind?: MessageEventKind | null;
  replyTo?: ReplyContext | null;
  normalization?: NormalizationInfo | null;
}): NormalizedContent {
  if (input.content) {
    return input.content;
  }

  const rawText = input.text ?? "";
  let resolvedParts: MessagePart[] = [];
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    resolvedParts = [...input.parts];
  } else if (rawText.trim().length > 0) {
    resolvedParts = [{ type: "TEXT", text: rawText }];
  }

  return {
    contentSchemaVersion: 2,
    contentRevision: input.contentRevision ?? 1,
    contentStatus: input.contentStatus ?? "READY",
    parts: resolvedParts,
    text: rawText,
    replyTo: input.replyTo ?? undefined,
    normalization: input.normalization ?? undefined,
  };
}

export const MessageTimelineDtoSchema = z.object({
  id: z.string().uuid(),
  direction: MessageDirectionSchema,
  actor: z.string(),
  text: z.string(),
  parts: z.array(MessagePartSchema),
  contentStatus: ContentStatusSchema,
  contentRevision: z.number().int().nonnegative(),
  eventKind: MessageEventKindSchema.default("MESSAGE_CREATED"),
  sender: z.object({
    name: z.string().nullable(),
    avatarMediaRef: z.string().nullable(),
    senderKind: SenderKindSchema.optional(),
    isVerified: z.boolean().default(false),
  }),
  time: z.object({
    eventAt: z.string().nullable(),
    observedAt: z.string().nullable(),
    displayAt: z.string().nullable(),
    source: z.enum(["FACEBOOK_EVENT", "OBSERVED", "SYSTEM", "UNKNOWN"]),
    precision: z.string(),
    rawLabel: z.string().optional(),
  }),
  replyDecision: z.object({
    action: z.enum(["SKIP", "DEFER", "GENERATE", "CLARIFY", "HANDOFF"]),
    reasonCode: z.string(),
    displayLabel: z.string(),
  }).optional().nullable(),
  // Legacy aliases for backward compatibility
  senderName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  senderKind: SenderKindSchema.optional(),
  isVerified: z.boolean().optional(),
  timestamp: z.coerce.date().optional(),
  observedTimestamp: z.coerce.date().nullable().optional(),
  eventTimestamp: z.coerce.date().nullable().optional(),
  skipReason: z.record(z.string(), z.unknown()).nullable().optional(),
  externalMessageId: z.string().optional(),
});
export type MessageTimelineDto = z.infer<typeof MessageTimelineDtoSchema>;

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
  // PR-03 v2 fields
  contentSchemaVersion: z.number().int().default(1),
  content: NormalizedContentSchema.optional().nullable(),
  contentStatus: ContentStatusSchema.default("READY"),
  contentRevision: z.number().int().nonnegative().default(1),
  contentHash: z.string().nullable().optional(),
  parserVersion: z.string().nullable().optional(),
  contentQuality: ContentQualitySchema.default("TRUSTED"),
  eventKind: MessageEventKindSchema.default("MESSAGE_CREATED"),
  parts: z.array(MessagePartSchema).optional(),
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
  // PR-03 v2 fields
  contentSchemaVersion: z.number().int().default(1),
  content: NormalizedContentSchema.optional().nullable(),
  contentStatus: ContentStatusSchema.default("READY"),
  contentRevision: z.number().int().nonnegative().default(1),
  contentHash: z.string().nullable().optional(),
  eventKind: MessageEventKindSchema.default("MESSAGE_CREATED"),
  parts: z.array(MessagePartSchema).optional(),
}).extend(MessageClassificationFields);
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const InboundMessagePayloadSchema = z.object({
  channelAccountId: z.string(),
  externalThreadId: z.string(),
  externalThreadRef: z.string(),
  externalCustomerId: z.string().nullable().optional(),
  customerName: z.string().nullable().optional(),
  externalMessageId: z.string(),
  text: z.string().max(10000).default(""),
  timestamp: z.coerce.date(),
  // PR-03 v2 additive fields
  parts: z.array(MessagePartSchema).max(50).optional(),
  content: NormalizedContentSchema.optional(),
  contentStatus: ContentStatusSchema.default("READY").optional(),
  contentRevision: z.number().int().nonnegative().default(1).optional(),
  contentSchemaVersion: z.number().int().default(2).optional(),
  eventKind: MessageEventKindSchema.default("MESSAGE_CREATED").optional(),
  contentHash: z.string().max(64).optional(),
  parserVersion: z.string().max(32).optional(),
  contentQuality: ContentQualitySchema.default("TRUSTED").optional(),
  quality: ContentQualitySchema.optional(),
  replyTo: ReplyContextSchema.optional(),
  normalization: NormalizationInfoSchema.optional(),
}).extend(MessageClassificationFields).superRefine((data, ctx) => {
  const parts = data.parts ?? data.content?.parts;
  const meaningful = isMeaningfulContent({
    text: data.text,
    parts,
    eventKind: data.eventKind,
  });
  if (!meaningful) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Empty meaningless message: must provide non-empty text, valid media parts, or supported event tombstone",
      path: ["text"],
    });
  }
});
export type InboundMessagePayload = z.infer<typeof InboundMessagePayloadSchema>;
