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
  canonicalizeFacebookUrl,
  extractFacebookEntityId,
  isApprovedFacebookUrl,
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
  thread: ReplyEligibilityThreadContextSchema.default(() => ReplyEligibilityThreadContextSchema.parse({})),
  sender: ReplyEligibilitySenderContextSchema.default(() => ReplyEligibilitySenderContextSchema.parse({})),
  message: ReplyEligibilityMessageContextSchema.default(() => ReplyEligibilityMessageContextSchema.parse({})),
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
  evaluationMode: z.enum(["LIVE", "SHADOW"]).optional(),
});
export type ReplyEligibilityResult = z.infer<typeof ReplyEligibilityResultSchema>;

export function getHumanReadableReason(reasonCode: string, fallback?: string): string {
  switch (reasonCode) {
    case "AUTO_REPLY_DISABLED":
      return "Đã tắt tự động phản hồi trong cài đặt.";
    case "INTAKE_PAUSED":
      return "Đang tạm dừng tiếp nhận tin nhắn mới.";
    case "CHANNEL_SUSPENDED":
      return "Kênh kết nối Messenger đang bị tạm khóa / đình chỉ.";
    case "CHANNEL_PAUSED":
      return "Kênh kết nối Messenger đang tạm dừng.";
    case "CONVERSATION_BLOCKED":
      return "Cuộc trò chuyện này đã bị chặn.";
    case "CONVERSATION_MANUAL_MODE":
      return "Hội thoại đang ở chế độ nhân viên hỗ trợ trực tiếp.";
    case "STALE_INBOUND_VERSION":
      return "Phiên bản tin nhắn đã cũ, đã có tin nhắn mới hơn.";
    case "DIRECTION_NOT_INBOUND":
      return "Tin nhắn không phải gửi đến từ khách hàng.";
    case "SELF_MESSAGE":
      return "Tin nhắn xuất phát từ chính tài khoản bot.";
    case "UNKNOWN_THREAD_KIND":
      return "Loại hội thoại không xác định (tự động bỏ qua).";
    case "UNVERIFIED_THREAD_CLASSIFICATION":
      return "Phân loại hội thoại chưa được xác minh an toàn.";
    case "UNKNOWN_SENDER_KIND":
      return "Loại người gửi không xác định (tự động bỏ qua).";
    case "UNVERIFIED_SENDER_CLASSIFICATION":
      return "Danh tính người gửi chưa được xác minh an toàn.";
    case "UNVERIFIED_PARTICIPANT_IDENTITY":
      return "Định danh người gửi chưa được xác minh hợp lệ.";
    case "DIRECT_REPLIES_DISABLED":
      return "Đã tắt tự động trả lời tin nhắn trực tiếp.";
    case "GROUP_REPLIES_DISABLED":
      return "Đã tắt tự động trả lời trong nhóm chat.";
    case "PERSON_EXCLUDED":
      return "Người gửi nằm trong danh sách loại trừ phản hồi.";
    case "PERSON_NOT_SELECTED":
      return "Người gửi không nằm trong danh sách được chỉ định trả lời.";
    case "PAGE_REPLIES_DISABLED":
      return "Đã tắt tự động trả lời tin nhắn từ Trang Facebook.";
    case "NON_PERSON_REPLIES_DISABLED":
      return "Đã tắt tự động trả lời tin nhắn phi cá nhân / bot.";
    case "GROUP_MENTION_REQUIRED":
      return "Tin nhắn trong nhóm cần được gắn thẻ (@mention) chính xác tên bot.";
    case "GROUP_MENTION_UNVERIFIED":
      return "Thẻ gắn trong nhóm chưa được xác minh hợp lệ.";
    case "ELIGIBLE":
      return "Đủ điều kiện phản hồi tự động.";
    default:
      return fallback || reasonCode;
  }
}

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

  // Self-message detection: inspect ALL candidate stable IDs and profile URLs
  const candidateSenderIds = new Set<string>();
  if (input.sender.id && input.sender.id.trim().length > 0) {
    candidateSenderIds.add(input.sender.id.trim());
    const extracted = extractFacebookEntityId(input.sender.id);
    if (extracted) candidateSenderIds.add(extracted);
  }
  if (
    input.sender.participantIdentity?.participantId &&
    input.sender.participantIdentity.participantId.trim().length > 0
  ) {
    candidateSenderIds.add(input.sender.participantIdentity.participantId.trim());
    const extracted = extractFacebookEntityId(input.sender.participantIdentity.participantId);
    if (extracted) candidateSenderIds.add(extracted);
  }

  const candidateBotIds = new Set<string>();
  if (input.channel.id && input.channel.id.trim().length > 0) {
    candidateBotIds.add(input.channel.id.trim());
    const extracted = extractFacebookEntityId(input.channel.id);
    if (extracted) candidateBotIds.add(extracted);
  }
  if (input.channel.botParticipantId && input.channel.botParticipantId.trim().length > 0) {
    candidateBotIds.add(input.channel.botParticipantId.trim());
    const extracted = extractFacebookEntityId(input.channel.botParticipantId);
    if (extracted) candidateBotIds.add(extracted);
  }

  let isSelfIdMatch = false;
  for (const sId of candidateSenderIds) {
    if (candidateBotIds.has(sId)) {
      isSelfIdMatch = true;
      break;
    }
  }

  let isSelfUrlMatch = false;
  if (input.channel.botProfileUrl && input.sender.participantIdentity?.profileUrl) {
    const canonicalBotUrl = canonicalizeFacebookUrl(input.channel.botProfileUrl);
    const canonicalSenderUrl = canonicalizeFacebookUrl(input.sender.participantIdentity.profileUrl);
    if (canonicalBotUrl && canonicalSenderUrl && canonicalBotUrl === canonicalSenderUrl) {
      isSelfUrlMatch = true;
    }
  }

  if (isSelfIdMatch || isSelfUrlMatch) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "SELF_MESSAGE",
      reason: "Message sender matches local channel/bot identity.",
      precedenceStep: "HARD_GATES",
      evaluatedAt: now,
      details: {
        candidateSenderIds: Array.from(candidateSenderIds),
        candidateBotIds: Array.from(candidateBotIds),
        isSelfIdMatch,
        isSelfUrlMatch,
      },
    };
  }

  // --------------------------------------------------------------------------
  // 2. VERIFIED CLASSIFICATION (Fail-Closed on any missing/unverified evidence)
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

  const hasParticipantId = candidateSenderIds.size > 0;
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

  if (
    input.thread.externalThreadId &&
    ((input.sender.id && input.sender.id.trim() === input.thread.externalThreadId.trim()) ||
      (input.sender.participantIdentity?.participantId &&
        input.sender.participantIdentity.participantId.trim() === input.thread.externalThreadId.trim()))
  ) {
    return {
      decision: "INELIGIBLE",
      eligible: false,
      reasonCode: "UNVERIFIED_PARTICIPANT_IDENTITY",
      reason: "Thread ID cannot be used as participant identity.",
      precedenceStep: "VERIFIED_CLASSIFICATION",
      evaluatedAt: now,
      details: { externalThreadId: input.thread.externalThreadId },
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
    const canonicalBotUrl = input.channel.botProfileUrl
      ? canonicalizeFacebookUrl(input.channel.botProfileUrl)
      : null;

    const botMentions = (input.message.mentions ?? []).filter((m) => {
      // Identity matching is strictly limited to stable IDs and canonical Facebook profile URLs.
      // Text / alias matching (m.mentionText) is NEVER permitted for identity verification.
      const mentionEntityId = m.entityId ? m.entityId.trim() : "";
      const extractedMentionId = extractFacebookEntityId(mentionEntityId);

      let idMatch = false;
      if (mentionEntityId && candidateBotIds.has(mentionEntityId)) {
        idMatch = true;
      } else if (extractedMentionId && candidateBotIds.has(extractedMentionId)) {
        idMatch = true;
      }

      let urlMatch = false;
      if (m.profileUrl) {
        const canonicalMentionUrl = canonicalizeFacebookUrl(m.profileUrl);
        if (canonicalMentionUrl && canonicalBotUrl && canonicalMentionUrl === canonicalBotUrl) {
          urlMatch = true;
        } else {
          // If mention URL contains an entity ID matching bot candidates and is an approved Facebook URL
          const extractedUrlId = extractFacebookEntityId(m.profileUrl);
          if (extractedUrlId && candidateBotIds.has(extractedUrlId) && isApprovedFacebookUrl(m.profileUrl)) {
            urlMatch = true;
          }
        }
      }

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

    const hasVerifiedMention = botMentions.some((m) => m.isVerified === true);
    if (!hasVerifiedMention) {
      return {
        decision: "INELIGIBLE",
        eligible: false,
        reasonCode: "GROUP_MENTION_UNVERIFIED",
        reason: "Bot mention in group message lacks verified evidence.",
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
