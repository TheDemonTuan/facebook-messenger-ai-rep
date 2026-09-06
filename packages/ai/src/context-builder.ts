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

/**
 * Builds a lean, budgeted conversation context for AI generation according to PLAN_TOI_UU_MESSENGER_AI.
 * 1. Filters out stale messages beyond contextHistoryMaxAgeHours (default 24h).
 * 2. Enforces per-sender quota (contextMaxMessagesPerSender, default 6).
 * 3. Enforces inbound quota (contextMaxInboundMessages, default 6) and total quota (contextMaxMessages, default 12).
 * 4. Budgets input tokens against contextMaxInputTokens (default 4096), preserving the current turn.
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

  // Filter valid and non-stale messages
  const nonStaleMessages: ConversationMessageItem[] = [];
  for (const msg of rawMessages) {
    if (!msg.text || !msg.text.trim()) continue;

    if (msg.timestamp) {
      const msgTime = new Date(msg.timestamp);
      if (!isNaN(msgTime.getTime()) && msgTime < cutoffTime) {
        droppedStaleCount++;
        continue;
      }
    }
    nonStaleMessages.push(msg);
  }

  // Work from newest to oldest to preserve the most recent exchange
  const candidateFromNewest = [...nonStaleMessages].reverse();
  const selectedReversed: ConversationMessageItem[] = [];

  let inboundCount = 0;
  const senderCounts = new Map<string, number>();

  for (let i = 0; i < candidateFromNewest.length; i++) {
    const msg = candidateFromNewest[i]!;
    const isInbound = msg.direction === "INBOUND";
    const senderKey = msg.senderParticipantId || (isInbound ? "customer" : "assistant");

    // Always keep the very latest inbound message regardless of quota
    const isLatestInbound = isInbound && inboundCount === 0;

    if (!isLatestInbound) {
      if (selectedReversed.length >= maxMessages) {
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

    selectedReversed.push(msg);
    senderCounts.set(senderKey, (senderCounts.get(senderKey) || 0) + 1);
    if (isInbound) {
      inboundCount++;
    }
  }

  // Restore chronological order (oldest to newest)
  const chronological = selectedReversed.reverse();

  // Enforce token budget: estimate tokens and drop oldest history if over budget
  let totalEstimatedTokens = chronological.reduce(
    (sum, m) => sum + estimateTextTokens(m.text) + 4, // 4 tokens framing per message
    estimateTextTokens(settings.aiSystemPersona) + estimateTextTokens(settings.businessProfile) + 100
  );

  while (totalEstimatedTokens > maxInputTokens && chronological.length > 1) {
    // Drop the oldest non-latest-inbound message
    const dropped = chronological.shift()!;
    droppedBudgetCount++;
    totalEstimatedTokens -= estimateTextTokens(dropped.text) + 4;
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
