import type { SystemSettings } from "@messenger/contracts";
import type { ConversationMessageItem } from "./persona.js";

export interface ContextBuilderOptions {
  customerName?: string | null;
  customerSummary?: string | null;
  settings: SystemSettings;
  now?: Date;
}

export interface MediaCoverageManifest {
  totalAttachments: number;
  includedAttachments: number;
  omittedAttachments: number;
  capped: boolean;
}

export interface BuiltContextResult {
  messages: ConversationMessageItem[];
  manifest: {
    totalEvaluated: number;
    selectedCount: number;
    droppedStaleCount: number;
    droppedSenderQuotaCount: number;
    droppedBudgetCount: number;
    estimatedTokens: number;
    mediaCoverage: MediaCoverageManifest;
  };
}

/**
 * Conservative token estimator for Vietnamese & English mixed text.
 * Vietnamese diacritics and BPE tokenization typically consume ~1 token per 2.5 characters.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2.5);
}

export function estimateMessageTokens(m: ConversationMessageItem): number {
  let tokens = estimateTextTokens(m.text);
  if (Array.isArray(m.parts) && m.parts.length > 0) {
    for (const part of m.parts) {
      if (part.type === "IMAGE") {
        tokens += 800; // Standard vision tile budget (~768-800 tokens)
      } else if (part.type === "VOICE" || part.type === "AUDIO") {
        const transcriptText = part.transcript?.text || "";
        tokens += estimateTextTokens(transcriptText) + 50;
      } else if (part.type === "VIDEO") {
        tokens += 400;
      } else if (part.type === "SHARE") {
        tokens += estimateTextTokens(part.title || "") + estimateTextTokens(part.previewText || "") + 20;
      } else if (part.type === "FILE") {
        tokens += estimateTextTokens(part.fileName || "") + 10;
      }
    }
  }
  return tokens + 4;
}

/**
 * Builds a lean, budgeted conversation context for AI generation according to PLAN_TOI_UU_MESSENGER_AI & PR-06.
 * 1. Guarantees strict chronological ordering (oldest -> newest) so the latest customer question is always last.
 * 2. Retains valid media-only messages even if customer provided no accompanying text.
 * 3. Enforces turn-level attachment caps (mediaMaxAttachmentsPerTurn, default 4) with explicit coverage tracking.
 * 4. Filters out stale messages beyond contextHistoryMaxAgeHours (default 24h), while preserving the latest inbound.
 * 5. Enforces per-sender quota (contextMaxMessagesPerSender, default 6) and inbound quota (contextMaxInboundMessages, default 6).
 * 6. Enforces token budgeting by dropping oldest history turns first, never dropping the turn under processing.
 */
export function buildLeanConversationContext(
  rawMessages: ConversationMessageItem[],
  options: ContextBuilderOptions
): BuiltContextResult {
  const { settings, now = new Date() } = options;
  const maxAgeHours = settings.contextHistoryMaxAgeHours ?? 24;
  const maxMessages = settings.contextMaxMessages ?? 12;
  const maxInbound = settings.contextMaxInboundMessages ?? 6;
  const maxPerSender = settings.contextMaxMessagesPerSender ?? 6;
  const maxInputTokens = settings.contextMaxInputTokens ?? 4096;
  const maxAttachmentsPerTurn = settings.mediaMaxAttachmentsPerTurn ?? 4;

  const cutoffTime = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000);

  let droppedStaleCount = 0;
  let droppedSenderQuotaCount = 0;
  let droppedBudgetCount = 0;

  // 1. Filter valid non-empty messages (supports text or valid media parts)
  const validMessages = rawMessages.filter((m) => {
    const hasText = Boolean(m.text && m.text.trim());
    const hasParts = Array.isArray(m.parts) && m.parts.length > 0;
    return hasText || hasParts;
  });

  // 2. Sort all messages chronologically (oldest -> newest)
  const sortedAsc = [...validMessages].sort((a, b) => {
    const tA = new Date(a.timestamp || 0).getTime();
    const tB = new Date(b.timestamp || 0).getTime();
    if (tA && tB && tA !== tB) return tA - tB;
    return 0;
  });

  // 3. Work backwards from newest to oldest to pick the most relevant recent exchange
  const candidateFromNewest = [...sortedAsc].reverse();
  const selectedFromNewest: ConversationMessageItem[] = [];

  let inboundCount = 0;
  const senderCounts = new Map<string, number>();

  for (const msg of candidateFromNewest) {
    const isInbound = msg.direction === "INBOUND";
    const senderKey = msg.senderParticipantId || (isInbound ? "customer" : "assistant");

    // The very first inbound message we encounter going backwards is the latest customer message
    const isLatestInbound = isInbound && inboundCount === 0;

    // Check if message is older than the cutoff window
    if (msg.timestamp) {
      const msgTime = new Date(msg.timestamp);
      if (!isNaN(msgTime.getTime()) && msgTime < cutoffTime) {
        // Never drop the latest customer question even if timestamp is skewed
        if (!isLatestInbound) {
          droppedStaleCount++;
          continue;
        }
      }
    }

    if (!isLatestInbound) {
      if (selectedFromNewest.length >= maxMessages) {
        droppedBudgetCount++;
        continue;
      }

      if (isInbound && inboundCount >= maxInbound) {
        droppedBudgetCount++;
        continue;
      }

      const currentSenderCount = senderCounts.get(senderKey) || 0;
      if (currentSenderCount >= maxPerSender) {
        droppedSenderQuotaCount++;
        continue;
      }
    }

    selectedFromNewest.push(msg);
    senderCounts.set(senderKey, (senderCounts.get(senderKey) || 0) + 1);
    if (isInbound) {
      inboundCount++;
    }
  }

  // 4. Restore strict chronological order (oldest -> newest)
  const chronological = [...selectedFromNewest].sort((a, b) => {
    const tA = new Date(a.timestamp || 0).getTime();
    const tB = new Date(b.timestamp || 0).getTime();
    if (tA && tB && tA !== tB) return tA - tB;
    return 0;
  });

  // 5. Enforce attachment caps per turn and calculate media coverage
  let totalAttachments = 0;
  let includedAttachments = 0;
  let omittedAttachments = 0;

  const cappedChronological = chronological.map((msg) => {
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) {
      return msg;
    }

    const mediaParts = msg.parts.filter(
      (p) => p.type === "IMAGE" || p.type === "VOICE" || p.type === "AUDIO" || p.type === "VIDEO"
    );
    totalAttachments += mediaParts.length;

    if (mediaParts.length <= maxAttachmentsPerTurn) {
      includedAttachments += mediaParts.length;
      return msg;
    }

    // Over attachment budget for this turn: keep up to maxAttachmentsPerTurn
    const otherParts = msg.parts.filter(
      (p) => p.type !== "IMAGE" && p.type !== "VOICE" && p.type !== "AUDIO" && p.type !== "VIDEO"
    );
    const keptMediaParts = mediaParts.slice(0, maxAttachmentsPerTurn);
    includedAttachments += keptMediaParts.length;
    omittedAttachments += mediaParts.length - keptMediaParts.length;

    return {
      ...msg,
      parts: [...otherParts, ...keptMediaParts],
    };
  });

  // 6. Token budgeting:
  // Allocate headroom so shop owner persona never starves recent history
  const systemTokens = estimateTextTokens(settings.aiSystemPersona) + estimateTextTokens(settings.businessProfile) + 100;
  const effectiveMaxInputTokens = Math.max(systemTokens + 4096, maxInputTokens, 16384);

  let totalEstimatedTokens = cappedChronological.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    systemTokens
  );

  // If over budget, drop oldest history, but NEVER drop the latest inbound message
  while (totalEstimatedTokens > effectiveMaxInputTokens && cappedChronological.length > 1) {
    const oldestIndex = cappedChronological.findIndex((m, idx) => idx < cappedChronological.length - 1);
    if (oldestIndex === -1) break;
    const [dropped] = cappedChronological.splice(oldestIndex, 1);
    if (dropped) {
      droppedBudgetCount++;
      totalEstimatedTokens -= estimateMessageTokens(dropped);
    } else {
      break;
    }
  }

  return {
    messages: cappedChronological,
    manifest: {
      totalEvaluated: rawMessages.length,
      selectedCount: cappedChronological.length,
      droppedStaleCount,
      droppedSenderQuotaCount,
      droppedBudgetCount,
      estimatedTokens: totalEstimatedTokens,
      mediaCoverage: {
        totalAttachments,
        includedAttachments,
        omittedAttachments,
        capped: omittedAttachments > 0,
      },
    },
  };
}
