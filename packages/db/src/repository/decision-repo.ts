import { eq, and, desc } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { replyEligibilityDecisions } from "../schema/index.js";
import { sanitizeReadableSnapshot } from "@messenger/contracts";

export interface RecordDecisionParams {
  channelAccountId: string;
  conversationId?: string | null;
  inboundMessageId: string;
  evaluationMode?: "LIVE" | "SHADOW";
  decision: "ELIGIBLE" | "INELIGIBLE";
  eligible: boolean;
  reasonCode: string;
  reason: string;
  precedenceStep: string;
  details?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  evaluatedAt?: Date;
}

export class ReplyEligibilityDecisionRepository {
  constructor(private db: Database) {}

  /**
   * Records reply eligibility decision with readable reason snapshot free of raw internal IDs.
   */
  async recordDecision(params: RecordDecisionParams, tx?: DatabaseOrTx) {
    const { readableReason, sanitizedDetails } = sanitizeReadableSnapshot(params.reason, params.details);
    const sanitizedSnapshot = params.snapshot
      ? sanitizeReadableSnapshot("", params.snapshot).sanitizedDetails
      : {};

    const evaluationMode = params.evaluationMode ?? "LIVE";
    const evaluatedAt = params.evaluatedAt ?? new Date();
    const executor = tx ?? this.db;

    const [row] = await executor
      .insert(replyEligibilityDecisions)
      .values({
        channelAccountId: params.channelAccountId,
        conversationId: params.conversationId ?? null,
        inboundMessageId: params.inboundMessageId,
        evaluationMode,
        decision: params.decision,
        eligible: params.eligible,
        reasonCode: params.reasonCode,
        reason: readableReason,
        precedenceStep: params.precedenceStep,
        details: sanitizedDetails,
        snapshot: sanitizedSnapshot,
        evaluatedAt,
      })
      .onConflictDoUpdate({
        target: [replyEligibilityDecisions.inboundMessageId, replyEligibilityDecisions.evaluationMode],
        set: {
          conversationId: params.conversationId ?? null,
          decision: params.decision,
          eligible: params.eligible,
          reasonCode: params.reasonCode,
          reason: readableReason,
          precedenceStep: params.precedenceStep,
          details: sanitizedDetails,
          snapshot: sanitizedSnapshot,
          evaluatedAt,
        },
      })
      .returning();

    return row!;
  }

  async getDecisionForInbound(
    inboundMessageId: string,
    evaluationMode: "LIVE" | "SHADOW" = "LIVE",
    tx?: DatabaseOrTx
  ) {
    const executor = tx ?? this.db;
    const rows = await executor
      .select()
      .from(replyEligibilityDecisions)
      .where(
        and(
          eq(replyEligibilityDecisions.inboundMessageId, inboundMessageId),
          eq(replyEligibilityDecisions.evaluationMode, evaluationMode)
        )
      )
      .limit(1);

    return rows[0] || null;
  }

  async getDecisionsForConversation(conversationId: string, limit = 20) {
    return await this.db
      .select()
      .from(replyEligibilityDecisions)
      .where(eq(replyEligibilityDecisions.conversationId, conversationId))
      .orderBy(desc(replyEligibilityDecisions.evaluatedAt))
      .limit(limit);
  }

  async getRecentDecisions(channelAccountId: string, limit = 50) {
    return await this.db
      .select()
      .from(replyEligibilityDecisions)
      .where(eq(replyEligibilityDecisions.channelAccountId, channelAccountId))
      .orderBy(desc(replyEligibilityDecisions.evaluatedAt))
      .limit(limit);
  }
}

export const DecisionRepository = ReplyEligibilityDecisionRepository;
