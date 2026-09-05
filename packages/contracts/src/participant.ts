import { z } from "zod";
import {
  SenderKindSchema,
  ClassificationReliabilitySchema,
  ReplyEligibilityDecisionSchema,
  ReplyEligibilityReasonCodeSchema,
  ReplyPrecedenceStepSchema,
} from "./enums.js";

export const ParticipantSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  participantId: z.string(),
  senderKind: SenderKindSchema.default("UNKNOWN"),
  reliability: ClassificationReliabilitySchema.default("UNVERIFIED"),
  isVerified: z.boolean().default(false),
  profileUrl: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  verifiedAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const ReplyPolicyMemberSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  participantId: z.string(),
  policyMode: z.string().default("EXCLUDE"),
  notes: z.string().nullable().optional(),
  addedBy: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ReplyPolicyMember = z.infer<typeof ReplyPolicyMemberSchema>;

export const ReplyEligibilityDecisionRecordSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid().nullable().optional(),
  inboundMessageId: z.string().uuid(),
  evaluationMode: z.enum(["LIVE", "SHADOW"]).default("LIVE"),
  decision: ReplyEligibilityDecisionSchema,
  eligible: z.boolean(),
  reasonCode: ReplyEligibilityReasonCodeSchema,
  reason: z.string(),
  precedenceStep: ReplyPrecedenceStepSchema,
  details: z.record(z.string(), z.unknown()).default({}),
  snapshot: z.record(z.string(), z.unknown()).default({}),
  evaluatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
});
export type ReplyEligibilityDecisionRecord = z.infer<typeof ReplyEligibilityDecisionRecordSchema>;

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STRIPPED_KEYS = new Set(["id", "conversationId", "inboundMessageId", "channelAccountId"]);

function sanitizeValue(val: unknown): unknown {
  if (typeof val === "string") {
    return val.replace(UUID_REGEX, "[id]");
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item));
  }
  if (val !== null && typeof val === "object") {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (STRIPPED_KEYS.has(k)) {
        continue;
      }
      sanitizedObj[k] = sanitizeValue(v);
    }
    return sanitizedObj;
  }
  return val;
}

/**
 * Sanitizes reason text and detail dictionaries to strip raw UUIDs or internal IDs
 * for safe consumption in normal/dashboard read models.
 * Recursively sanitizes arrays/nested objects and globally redacts embedded UUIDs.
 */
export function sanitizeReadableSnapshot(
  reason: string,
  details?: Record<string, unknown>
): { readableReason: string; sanitizedDetails: Record<string, unknown> } {
  const readableReason = typeof reason === "string" ? reason.replace(UUID_REGEX, "[id]") : "";
  const sanitizedDetails = (details ? (sanitizeValue(details) as Record<string, unknown>) : {}) || {};
  return { readableReason, sanitizedDetails };
}
