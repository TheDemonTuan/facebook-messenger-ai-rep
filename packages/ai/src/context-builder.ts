import type { SystemSettings } from "@messenger/contracts";
import type { ConversationMessageItem } from "./persona.js";

export interface ContextBuilderOptions {
  customerName?: string | null;
  customerSummary?: string | null;
  settings: SystemSettings;
  now?: Date;
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
      if (part.type === "IMAGE" || part.type === "VOICE" || part.type === "VIDEO" || part.type === "AUDIO") {
        tokens += 50;
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
 * Builds a lean, budgeted conversation context for AI generation according to PLAN_TOI_UU_MESSENGER_AI.
 * 1. Guarantees strict chronological ordering (oldest -> newest) so the latest customer question is always last.
 * 2. Filters out stale messages beyond contextHistoryMaxAgeHours (default 24h), while preserving the latest inbound.
 * 3. Enforces per-sender quota (contextMaxMessagesPerSender, default 6).
 * 4. Enforces inbound quota (contextMaxInboundMessages, default 6) and total quota (contextMaxMessages, default 12).
 * 5. Budgets input tokens safely, ensuring long system personas do not starve conversation history.
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

  // 5. Token budgeting:
  // The system persona + business profile is defined by the shop owner and can be 5,000+ tokens.
  // We allocate an additional message headroom of at least 4,096 tokens so system persona never starves history.
  const systemTokens = estimateTextTokens(settings.aiSystemPersona) + estimateTextTokens(settings.businessProfile) + 100;
  const effectiveMaxInputTokens = Math.max(systemTokens + 4096, maxInputTokens, 16384);

  let totalEstimatedTokens = chronological.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    systemTokens
  );

  // If over budget, drop oldest history, but NEVER drop the latest inbound message
  while (totalEstimatedTokens > effectiveMaxInputTokens && chronological.length > 1) {
    const oldestIndex = chronological.findIndex((m, idx) => idx < chronological.length - 1);
    if (oldestIndex === -1) break;
    const [dropped] = chronological.splice(oldestIndex, 1);
    if (dropped) {
      droppedBudgetCount++;
      totalEstimatedTokens -= estimateMessageTokens(dropped);
    } else {
      break;
    }
  }

  return {
    messages: chronological,
    manifest: {
      totalEvaluated: rawMessages.length,
      selectedCount: chronological.length,
      droppedStaleCount,
      droppedSenderQuotaCount,
      droppedBudgetCount,
      estimatedTokens: totalEstimatedTokens,
    },
  };
}
