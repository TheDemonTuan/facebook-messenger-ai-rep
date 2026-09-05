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

/**
 * Sanitizes reason text and detail dictionaries to strip raw UUIDs or internal IDs
 * for safe consumption in normal/dashboard read models.
 */
export function sanitizeReadableSnapshot(
  reason: string,
  details?: Record<string, unknown>
): { readableReason: string; sanitizedDetails: Record<string, unknown> } {
  const readableReason = reason.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "[id]"
  );

  const sanitizedDetails: Record<string, unknown> = {};
  if (details) {
    for (const [k, v] of Object.entries(details)) {
      if (["id", "conversationId", "inboundMessageId", "channelAccountId"].includes(k)) {
        continue;
      }
      if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
        sanitizedDetails[k] = "[id]";
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        sanitizedDetails[k] = sanitizeReadableSnapshot("", v as Record<string, unknown>).sanitizedDetails;
      } else {
        sanitizedDetails[k] = v;
      }
    }
  }

  return { readableReason, sanitizedDetails };
}
