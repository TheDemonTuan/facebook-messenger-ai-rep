import { z } from "zod";
import {
  ChannelAccountTypeSchema,
  ThreadKindSchema,
  SenderKindSchema,
  ClassificationReliabilitySchema,
  ReplyEligibilityDecisionSchema,
  ReplyEligibilityReasonCodeSchema,
  ReplyPrecedenceStepSchema,
  SenderActorSchema,
} from "./enums.js";
import { SystemSettingsSchema } from "./settings.js";
import {
  MessageDirectionSchema,
  ClassificationEvidenceSchema,
  MentionEvidenceSchema,
  MessageTimestampsSchema,
  VerifiedParticipantIdentitySchema,
} from "./message.js";

export const ReplyEligibilityChannelContextSchema = z.object({
  id: z.string(),
  accountType: ChannelAccountTypeSchema,
  isSuspended: z.boolean().default(false),
  isPaused: z.boolean().default(false),
  botParticipantId: z.string().optional(),
  botProfileUrl: z.string().optional(),
});
export type ReplyEligibilityChannelContext = z.infer<typeof ReplyEligibilityChannelContextSchema>;

export const ReplyEligibilityThreadContextSchema = z.object({
  id: z.string().optional(),
  externalThreadId: z.string().optional(),
  kind: ThreadKindSchema.default("UNKNOWN"),
  reliability: ClassificationReliabilitySchema.default("UNVERIFIED"),
  isBlocked: z.boolean().default(false),
  manualMode: z.boolean().default(false),
  evidence: z.array(ClassificationEvidenceSchema).default([]),
});
export type ReplyEligibilityThreadContext = z.infer<typeof ReplyEligibilityThreadContextSchema>;

export const ReplyEligibilitySenderContextSchema = z.object({
  id: z.string().optional(),
  kind: SenderKindSchema.default("UNKNOWN"),
  reliability: ClassificationReliabilitySchema.default("UNVERIFIED"),
  participantIdentity: VerifiedParticipantIdentitySchema.nullable().optional(),
  evidence: z.array(ClassificationEvidenceSchema).default([]),
});
export type ReplyEligibilitySenderContext = z.infer<typeof ReplyEligibilitySenderContextSchema>;

export const ReplyEligibilityMessageContextSchema = z.object({
  id: z.string().optional(),
  direction: MessageDirectionSchema.default("INBOUND"),
  actor: SenderActorSchema.default("SYSTEM"),
  text: z.string().default(""),
  mentions: z.array(MentionEvidenceSchema).default([]),
  timestamps: MessageTimestampsSchema.optional(),
  eventTimestamp: z.coerce.date().optional(),
  observedTimestamp: z.coerce.date().optional(),
});
export type ReplyEligibilityMessageContext = z.infer<typeof ReplyEligibilityMessageContextSchema>;

export const ReplyEligibilityInputSchema = z.object({
  channel: ReplyEligibilityChannelContextSchema,
  thread: ReplyEligibilityThreadContextSchema,
  sender: ReplyEligibilitySenderContextSchema,
  message: ReplyEligibilityMessageContextSchema,
  settings: SystemSettingsSchema.default(() => SystemSettingsSchema.parse({})),
  now: z.coerce.date().optional(),
});
export type ReplyEligibilityInput = z.infer<typeof ReplyEligibilityInputSchema>;

export const ReplyEligibilityResultSchema = z.object({
  decision: ReplyEligibilityDecisionSchema,
  eligible: z.boolean(),
  reasonCode: ReplyEligibilityReasonCodeSchema,
  reason: z.string(),
  precedenceStep: ReplyPrecedenceStepSchema,
  evaluatedAt: z.coerce.date(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ReplyEligibilityResult = z.infer<typeof ReplyEligibilityResultSchema>;

export function matchesParticipantList(list: string[], channelId: string, participantId: string): boolean {
  if (!list || list.length === 0 || !participantId) {
    return false;
  }
  const cleanParticipantId = participantId.trim();
  const scopedParticipantId = `${channelId.trim()}:${cleanParticipantId}`;
  return list.some((item) => {
    const cleanItem = item.trim();
    return cleanItem === cleanParticipantId || cleanItem === scopedParticipantId;
  });
}

function senderMatchesList(list: string[], channelId: string, sender: ReplyEligibilitySenderContext): boolean {
  const ids: string[] = [];
  if (sender.id && sender.id.trim().length > 0) {
    ids.push(sender.id.trim());
  }
  if (sender.participantIdentity?.participantId && sender.participantIdentity.participantId.trim().length > 0) {
    ids.push(sender.participantIdentity.participantId.trim());
  }
  return ids.some((id) => matchesParticipantList(list, channelId, id));
}

/**
 * Evaluates message reply eligibility following the strict precedence hierarchy:
 * 1. Hard gates (global switches, channel status, conversation status, message direction, self-replies)
 * 2. Verified classification (thread and sender kinds must be known and verified, identity channel-scoped)
 * 3. Source controls (direct vs group thread reply switches)
 * 4. PERSON list mode (EVERYONE_EXCEPT or ONLY_SELECTED)
 * 5. Page / non-person controls (explicitly enabled for PAGE and NON_PERSON senders)
 * 6. Group verified-mention requirement (group threads require verified bot mention)
 * 7. Eligible
 */
export function evaluateReplyEligibility(rawInput: ReplyEligibilityInput): ReplyEligibilityResult {
  const input = ReplyEligibilityInputSchema.parse(rawInput);
  const now = input.now ?? new Date();

  // --------------------------------------------------------------------------
  // 1. HARD GATES
  // --------------------------------------------------------------------------
  if (!input.settings.autoReplyEnabled) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "AUTO_REPLY_DISABLED",
      reason: "Automated replies are disabled globally in system settings.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { autoReplyEnabled: false },
    };
  }

  if (input.settings.pauseIntakeProcessing) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "INTAKE_PAUSED",
      reason: "Intake processing is paused in system settings.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { pauseIntakeProcessing: true },
    };
  }

  if (input.channel.isSuspended) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "CHANNEL_SUSPENDED",
      reason: "Channel account is suspended.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { channelId: input.channel.id, isSuspended: true },
    };
  }

  if (input.channel.isPaused) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "CHANNEL_PAUSED",
      reason: "Channel account is paused.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { channelId: input.channel.id, isPaused: true },
    };
  }

  if (input.thread.isBlocked) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "CONVERSATION_BLOCKED",
      reason: "Conversation is marked as blocked.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { threadId: input.thread.id, isBlocked: true },
    };
  }

  if (input.thread.manualMode) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "CONVERSATION_MANUAL_MODE",
      reason: "Conversation is currently in manual operator mode.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { threadId: input.thread.id, manualMode: true },
    };
  }

  if (input.message.direction !== "INBOUND") {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "DIRECTION_NOT_INBOUND",
      reason: "Only inbound messages are eligible for automated reply.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { direction: input.message.direction },
    };
  }

  if (input.message.actor === "AI" || input.message.actor === "MANUAL_OWNER") {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "SELF_MESSAGE",
      reason: "Message was generated by local system actor or manual owner.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { actor: input.message.actor },
    };
  }

  const senderId = input.sender.id?.trim();
  const channelId = input.channel.id.trim();
  const botParticipantId = input.channel.botParticipantId?.trim();
  if (
    (senderId && senderId === channelId) ||
    (senderId && botParticipantId && senderId === botParticipantId)
  ) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "SELF_MESSAGE",
      reason: "Message sender matches local channel/bot identity.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: { senderId, channelId, botParticipantId },
    };
  }

  // --------------------------------------------------------------------------
  // 2. VERIFIED CLASSIFICATION
  // --------------------------------------------------------------------------
  if (input.thread.kind === "UNKNOWN") {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "UNKNOWN_THREAD_KIND",
      reason: "Thread kind is unknown and must fail closed.",
      precedenceStep: "VERIFIED_CLASSIFICATION",
      evaluatedAt: now,
      details: { threadKind: input.thread.kind },
    };
  }

  if (input.thread.reliability !== "VERIFIED") {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "UNVERIFIED_THREAD_CLASSIFICATION",
      reason: "Thread classification is unverified and must fail closed.",
      precedenceStep: "VERIFIED_CLASSIFICATION",
      evaluatedAt: now,
      details: { threadKind: input.thread.kind, reliability: input.thread.reliability },
    };
  }

  if (input.sender.kind === "UNKNOWN") {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "UNKNOWN_SENDER_KIND",
      reason: "Sender kind is unknown and must fail closed.",
      precedenceStep: "VERIFIED_CLASSIFICATION",
      evaluatedAt: now,
      details: { senderKind: input.sender.kind },
    };
  }

  if (input.sender.reliability !== "VERIFIED") {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "UNVERIFIED_SENDER_CLASSIFICATION",
      reason: "Sender classification is unverified and must fail closed.",
      precedenceStep: "VERIFIED_CLASSIFICATION",
      evaluatedAt: now,
      details: { senderKind: input.sender.kind, reliability: input.sender.reliability },
    };
  }

  const hasParticipantId = Boolean(
    (input.sender.id && input.sender.id.trim().length > 0) ||
    (input.sender.participantIdentity?.participantId && input.sender.participantIdentity.participantId.trim().length > 0)
  );
  if (!hasParticipantId) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "UNVERIFIED_PARTICIPANT_IDENTITY",
      reason: "Sender has no identifiable participant ID.",
      precedenceStep: "VERIFIED_CLASSIFICATION",
      evaluatedAt: now,
      details: { senderId: input.sender.id },
    };
  }

  if (input.sender.participantIdentity) {
    if (input.sender.participantIdentity.channelAccountId !== input.channel.id) {
      return {
        decision: "INELIGIBLE",
        eligible: false,
        reasonCode: "UNVERIFIED_PARTICIPANT_IDENTITY",
        reason: "Participant identity is scoped to a different channel account.",
        precedenceStep: "VERIFIED_CLASSIFICATION",
        evaluatedAt: now,
        details: {
          identityChannelAccountId: input.sender.participantIdentity.channelAccountId,
          channelAccountId: input.channel.id,
        },
      };
    }

    if (!input.sender.participantIdentity.isVerified) {
      return {
        decision: "INELIGIBLE",
        eligible: false,
        reasonCode: "UNVERIFIED_PARTICIPANT_IDENTITY",
        reason: "Participant identity is not verified.",
        precedenceStep: "VERIFIED_CLASSIFICATION",
        evaluatedAt: now,
        details: { isVerified: false },
      };
    }
  }

  // --------------------------------------------------------------------------
  // 3. SOURCE CONTROLS
  // --------------------------------------------------------------------------
  if (input.thread.kind === "DIRECT" && !input.settings.directRepliesEnabled) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "DIRECT_REPLIES_DISABLED",
      reason: "Direct message replies are disabled in settings.",
      precedenceStep: "SOURCE_CONTROLS",
      evaluatedAt: now,
      details: { directRepliesEnabled: false },
    };
  }

  if (input.thread.kind === "GROUP" && !input.settings.groupRepliesEnabled) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "GROUP_REPLIES_DISABLED",
      reason: "Group message replies are disabled in settings.",
      precedenceStep: "SOURCE_CONTROLS",
      evaluatedAt: now,
      details: { groupRepliesEnabled: false },
    };
  }

  // --------------------------------------------------------------------------
  // 4. PERSON LIST MODE
  // --------------------------------------------------------------------------
  if (input.sender.kind === "PERSON") {
    if (input.settings.replyMode === "EVERYONE_EXCEPT") {
      if (senderMatchesList(input.settings.excludedParticipantIds, input.channel.id, input.sender)) {
        return {
          decision: "INELIGIBLE",
          eligible: false,
          reasonCode: "PERSON_EXCLUDED",
          reason: "Participant is in the exclusion list.",
          precedenceStep: "PERSON_LIST_MODE",
          evaluatedAt: now,
          details: { replyMode: input.settings.replyMode },
        };
      }
    } else if (input.settings.replyMode === "ONLY_SELECTED") {
      if (!senderMatchesList(input.settings.selectedParticipantIds, input.channel.id, input.sender)) {
        return {
          decision: "INELIGIBLE",
          eligible: false,
          reasonCode: "PERSON_NOT_SELECTED",
          reason: "Participant is not in the selected allowlist.",
          precedenceStep: "PERSON_LIST_MODE",
          evaluatedAt: now,
          details: { replyMode: input.settings.replyMode },
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // 5. PAGE / NON-PERSON CONTROLS
  // --------------------------------------------------------------------------
  if (input.sender.kind === "PAGE" && !input.settings.pageRepliesEnabled) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "PAGE_REPLIES_DISABLED",
      reason: "Replies to Facebook Page senders are disabled.",
      precedenceStep: "PAGE_NON_PERSON_CONTROLS",
      evaluatedAt: now,
      details: { senderKind: input.sender.kind, pageRepliesEnabled: false },
    };
  }

  if (input.sender.kind === "NON_PERSON" && !input.settings.nonPersonRepliesEnabled) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "NON_PERSON_REPLIES_DISABLED",
      reason: "Replies to non-person senders are disabled.",
      precedenceStep: "PAGE_NON_PERSON_CONTROLS",
      evaluatedAt: now,
      details: { senderKind: input.sender.kind, nonPersonRepliesEnabled: false },
    };
  }

  // --------------------------------------------------------------------------
  // 6. GROUP VERIFIED-MENTION REQUIREMENT
  // --------------------------------------------------------------------------
  if (input.thread.kind === "GROUP" && input.settings.requireGroupMention) {
    const candidateBotIds = [
      input.channel.botParticipantId,
      input.channel.id,
    ].filter((id): id is string => Boolean(id && id.trim().length > 0));

    const botMentions = (input.message.mentions ?? []).filter((m) => {
      const idMatch = candidateBotIds.length > 0 && candidateBotIds.includes(m.entityId);
      const urlMatch = Boolean(
        input.channel.botProfileUrl &&
          m.profileUrl &&
          m.profileUrl.trim().toLowerCase() === input.channel.botProfileUrl.trim().toLowerCase()
      );
      return idMatch || urlMatch;
    });

    if (botMentions.length === 0) {
      return {
        decision: "INELIGIBLE",
        eligible: false,
        reasonCode: "GROUP_MENTION_REQUIRED",
        reason: "Group message does not mention the bot account.",
        precedenceStep: "GROUP_MENTION_REQUIREMENT",
        evaluatedAt: now,
        details: { totalMentions: input.message.mentions?.length ?? 0 },
      };
    }

    const hasVerifiedMention = botMentions.some((m) => m.isVerified);
    if (!hasVerifiedMention) {
      return {
        decision: "INELIGIBLE",
        eligible: false,
        reasonCode: "GROUP_MENTION_UNVERIFIED",
        reason: "Bot mention in group message is not verified.",
        precedenceStep: "GROUP_MENTION_REQUIREMENT",
        evaluatedAt: now,
        details: { botMentionsCount: botMentions.length },
      };
    }
  }

  // --------------------------------------------------------------------------
  // 7. ELIGIBLE
  // --------------------------------------------------------------------------
  return {
    decision: "ELIGIBLE",
    eligible: true,
    reasonCode: "ELIGIBLE",
    reason: "Message is eligible for automated reply.",
    precedenceStep: "ELIGIBLE",
    evaluatedAt: now,
    details: {
      channelId: input.channel.id,
      threadKind: input.thread.kind,
      senderKind: input.sender.kind,
      replyMode: input.settings.replyMode,
    },
  };
}
