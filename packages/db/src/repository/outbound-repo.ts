import { eq, and, sql, notInArray, inArray, gte } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { outboundActions, conversations, messages } from "../schema/index.js";
import type { OutboundActionStatus, SenderActor } from "@messenger/contracts";
import { createHash } from "node:crypto";

function normalizeTextForMatch(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CreateOutboundActionParams {
  channelAccountId: string;
  conversationId: string;
  turnId?: string;
  sourceAiRunId?: string;
  inboundVersion: number;
  responseIndex: number;
  text: string;
  actor: SenderActor;
  claimToken?: string;
  ownerToken?: string;
  fencingToken?: number;
  fencingEpoch?: number;
  controlEpoch?: number;
}

export interface TransitionActionOptions {
  ownerToken?: string;
  fencingEpoch?: number;
  externalMessageRef?: string;
  errorMessage?: string;
  unconfirmedReason?: string;
  metadata?: Record<string, unknown>;
}

const TERMINAL_STATUSES: OutboundActionStatus[] = ["CONFIRMED", "SENT", "CANCELLED", "ABORTED"];

const VALID_TRANSITIONS: Record<string, OutboundActionStatus[]> = {
  PENDING: ["TYPING", "CANCELLED", "FAILED", "ABORTED"],
  TYPING: ["SEND_INTENT", "SENDING", "CANCELLED", "FAILED", "ABORTED", "PENDING"],
  SEND_INTENT: ["CONFIRMED", "SEND_UNCERTAIN", "FAILED", "SENT", "UNCONFIRMED"],
  SEND_UNCERTAIN: ["CONFIRMED", "RETRY_APPROVED"],
  RETRY_APPROVED: ["PENDING"],
  CONFIRMED: [],
  CANCELLED: [],
  FAILED: ["PENDING"],
  // Legacy support
  SENDING: ["CONFIRMED", "SENT", "SEND_UNCERTAIN", "FAILED", "UNCONFIRMED"],
  SENT: [],
  ABORTED: [],
  UNCONFIRMED: ["CONFIRMED", "RETRY_APPROVED"],
};

export class OutboundRepository {
  constructor(private db: Database) {}

  /**
   * Deterministically generates action_id: sha256(channelAccountId + conversationId + inboundVersion + responseIndex + [nonceOrActor])
   */
  static computeActionId(
    channelAccountId: string,
    conversationId: string,
    inboundVersion: number,
    responseIndex: number,
    nonceOrActor?: string
  ): string {
    const raw = nonceOrActor
      ? `${channelAccountId}:${conversationId}:${inboundVersion}:${responseIndex}:${nonceOrActor}`
      : `${channelAccountId}:${conversationId}:${inboundVersion}:${responseIndex}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Idempotently creates an action.
   * If action already exists in a terminal state (CONFIRMED, CANCELLED), does NOT overwrite.
   */
  async createAction(params: CreateOutboundActionParams & { intentId?: string }, tx?: DatabaseOrTx) {
    const executor = tx || this.db;
    const actionNonce =
      params.intentId ||
      (params.actor && params.actor !== "AI" ? `${params.actor}:${Date.now()}` : undefined);
    const actionId = OutboundRepository.computeActionId(
      params.channelAccountId,
      params.conversationId,
      params.inboundVersion,
      params.responseIndex,
      actionNonce
    );
    const textHash = createHash("sha256").update(params.text.trim()).digest("hex");
    const owner = params.ownerToken || params.claimToken || null;
    const epoch = params.fencingEpoch ?? params.fencingToken ?? 0;

    // Check if exists and is terminal
    const [existing] = await executor
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.actionId, actionId))
      .limit(1);

    if (existing) {
      if (TERMINAL_STATUSES.includes(existing.status as OutboundActionStatus)) {
        return existing; // Terminal state is immutable
      }

      const [updated] = await executor
        .update(outboundActions)
        .set({
          text: params.text,
          textHash,
          status: "PENDING",
          ownerToken: owner,
          claimToken: owner,
          fencingEpoch: epoch,
          fencingToken: epoch,
          metadata: { controlEpoch: params.controlEpoch ?? 0 },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(outboundActions.actionId, actionId),
            notInArray(outboundActions.status, TERMINAL_STATUSES)
          )
        )
        .returning();

      return updated || existing;
    }

    const [row] = await executor
      .insert(outboundActions)
      .values({
        channelAccountId: params.channelAccountId,
        conversationId: params.conversationId,
        turnId: params.turnId || null,
        sourceAiRunId: params.sourceAiRunId || null,
        actionId,
        inboundVersion: params.inboundVersion,
        responseIndex: params.responseIndex,
        text: params.text,
        textHash,
        actor: params.actor,
        status: "PENDING",
        claimToken: owner,
        ownerToken: owner,
        fencingToken: epoch,
        fencingEpoch: epoch,
        metadata: { controlEpoch: params.controlEpoch ?? 0 },
      })
      .returning();

    return row;
  }

  async getActionById(actionId: string, tx?: DatabaseOrTx) {
    const executor = tx || this.db;
    const rows = await executor
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.actionId, actionId))
      .limit(1);
    return rows[0] || null;
  }

  /**
   * Centralized state machine transition with CAS.
   * Rejects invalid transitions or attempts to mutate terminal states.
   */
  async transitionStatus(
    actionId: string,
    expectedStatus: OutboundActionStatus,
    nextStatus: OutboundActionStatus,
    options: TransitionActionOptions = {},
    tx?: DatabaseOrTx
  ) {
    const allowed = VALID_TRANSITIONS[expectedStatus] || [];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`Invalid outbound action transition from ${expectedStatus} to ${nextStatus}`);
    }

    const executor = tx || this.db;
    const now = new Date();
    const updateData: Partial<typeof outboundActions.$inferInsert> = {
      status: nextStatus,
      updatedAt: now,
      ...(options.externalMessageRef ? { externalMessageRef: options.externalMessageRef } : {}),
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
      ...(options.unconfirmedReason ? { unconfirmedReason: options.unconfirmedReason } : {}),
    };

    if (nextStatus === "TYPING") {
      updateData.startedTypingAt = now;
    } else if (nextStatus === "SEND_INTENT" || nextStatus === "SENDING") {
      updateData.startedSendingAt = now;
    } else if (nextStatus === "CONFIRMED" || nextStatus === "SENT") {
      updateData.confirmedAt = now;
    }

    const conditions = [
      eq(outboundActions.actionId, actionId),
      eq(outboundActions.status, expectedStatus),
    ];

    if (options.ownerToken) {
      conditions.push(
        sql`(${outboundActions.ownerToken} = ${options.ownerToken} OR ${outboundActions.claimToken} = ${options.ownerToken} OR ${outboundActions.ownerToken} IS NULL)`
      );
    }
    if (options.fencingEpoch !== undefined) {
      conditions.push(
        sql`(${outboundActions.fencingEpoch} = ${options.fencingEpoch} OR ${outboundActions.fencingToken} = ${options.fencingEpoch} OR ${outboundActions.fencingEpoch} = 0)`
      );
    }

    const [updated] = await executor
      .update(outboundActions)
      .set(updateData)
      .where(and(...conditions))
      .returning();

    return updated || null;
  }

  /**
   * Generic status update with compatibility fallback
   */
  async updateStatus(
    actionId: string,
    status: OutboundActionStatus,
    extra?: {
      externalMessageRef?: string;
      errorMessage?: string;
      unconfirmedReason?: string;
      ownerToken?: string;
      fencingEpoch?: number;
    },
    tx?: DatabaseOrTx
  ) {
    const current = await this.getActionById(actionId, tx);
    if (!current) throw new Error(`Action not found: ${actionId}`);

    if (TERMINAL_STATUSES.includes(current.status as OutboundActionStatus)) {
      return current;
    }

    return await this.transitionStatus(
      actionId,
      current.status as OutboundActionStatus,
      status,
      extra,
      tx
    );
  }

  /**
   * Transitions from SEND_INTENT to SEND_UNCERTAIN fail-closed.
   */
  async markSendUncertain(
    actionId: string,
    unconfirmedReason: string,
    options: TransitionActionOptions = {},
    tx?: DatabaseOrTx
  ) {
    const current = await this.getActionById(actionId, tx);
    if (!current) return null;

    if (TERMINAL_STATUSES.includes(current.status as OutboundActionStatus)) {
      return current;
    }

    return await this.transitionStatus(
      actionId,
      current.status as OutboundActionStatus,
      "SEND_UNCERTAIN",
      {
        ...options,
        unconfirmedReason,
      },
      tx
    );
  }

  /**
   * Operator reconcile for SEND_UNCERTAIN action.
   * Can either confirm sent or approve retry.
   */
  async reconcileUncertain(
    actionId: string,
    decision: "CONFIRM" | "RETRY_APPROVED",
    externalMessageRef?: string,
    tx?: DatabaseOrTx
  ) {
    const current = await this.getActionById(actionId, tx);
    if (!current || current.status !== "SEND_UNCERTAIN") {
      throw new Error(`Cannot reconcile action: status is not SEND_UNCERTAIN (current: ${current?.status})`);
    }

    if (decision === "CONFIRM") {
      return await this.confirmSent(actionId, externalMessageRef, {}, tx);
    } else {
      const updated = await this.transitionStatus(actionId, "SEND_UNCERTAIN", "RETRY_APPROVED", {}, tx);
      if (updated) {
        return await this.transitionStatus(actionId, "RETRY_APPROVED", "PENDING", {}, tx);
      }
      return null;
    }
  }

  /**
   * Confirms send: marks outboundAction CONFIRMED, records message row and updates conversation lastOutboundAt.
   */
  async confirmSent(
    actionId: string,
    externalMessageRef?: string,
    options: TransitionActionOptions = {},
    tx?: DatabaseOrTx
  ) {
    const executor = (tx || this.db) as Database;

    return await executor.transaction(async (innerTx) => {
      const now = new Date();
      const [action] = await innerTx
        .select()
        .from(outboundActions)
        .where(eq(outboundActions.actionId, actionId))
        .limit(1);

      if (!action) throw new Error(`Outbound action not found: ${actionId}`);

      // If already CONFIRMED/SENT, idempotently return
      if (action.status === "CONFIRMED" || action.status === "SENT") {
        return action;
      }

      // Update action status to CONFIRMED
      const [updated] = await innerTx
        .update(outboundActions)
        .set({
          status: "CONFIRMED",
          confirmedAt: now,
          externalMessageRef: externalMessageRef || action.externalMessageRef,
          ...(options?.metadata
            ? {
                metadata: {
                  ...((action.metadata as Record<string, unknown>) || {}),
                  ...options.metadata,
                },
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(outboundActions.id, action.id))
        .returning();

      // Insert outbound message row
      const externalMsgId = externalMessageRef || `outbound-${action.actionId}`;
      await innerTx
        .insert(messages)
        .values({
          channelAccountId: action.channelAccountId,
          conversationId: action.conversationId,
          externalMessageId: externalMsgId,
          direction: "OUTBOUND",
          actor: action.actor,
          text: action.text,
          textHash: action.textHash,
          inboundVersion: action.inboundVersion,
          responseIndex: action.responseIndex,
          timestamp: now,
          contentSchemaVersion: 2,
          content: {
            contentSchemaVersion: 2,
            contentRevision: 1,
            contentStatus: "READY",
            parts: [{ type: "TEXT", text: action.text }],
            text: action.text,
          },
          contentStatus: "READY",
          contentRevision: 1,
          contentQuality: "TRUSTED",
          eventKind: "MESSAGE_CREATED",
        })
        .onConflictDoNothing();

      // Update conversation
      await innerTx
        .update(conversations)
        .set({
          lastOutboundAt: now,
          unreadCount: 0,
          updatedAt: now,
        })
        .where(eq(conversations.id, action.conversationId));

      return updated || action;
    });
  }

  /**
   * Fetches pending outbound actions ordered by creation time.
   */
  async getPendingActions(channelAccountId: string, limit = 20, tx?: DatabaseOrTx) {
    const executor = tx || this.db;
    return await executor
      .select()
      .from(outboundActions)
      .where(
        and(
          eq(outboundActions.channelAccountId, channelAccountId),
          eq(outboundActions.status, "PENDING")
        )
      )
      .orderBy(outboundActions.createdAt)
      .limit(limit);
  }

  /**
   * Abort remaining pending actions for a conversation if inbound version advanced
   */
  async abortStaleActions(conversationId: string, currentInboundVersion: number, tx?: DatabaseOrTx) {
    const executor = tx || this.db;
    return await executor
      .update(outboundActions)
      .set({
        status: "CANCELLED",
        errorMessage: `Cancelled due to new inbound version (${currentInboundVersion})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundActions.conversationId, conversationId),
          sql`${outboundActions.inboundVersion} < ${currentInboundVersion}`,
          notInArray(outboundActions.status, TERMINAL_STATUSES)
        )
      );
  }

  /**
   * Durable bot identity check: verifies if an observed outgoing bubble was produced by the bot,
   * checking durable outbound action records and message history (survives process restart).
   */
  async isBotOutbound(params: {
    channelAccountId: string;
    externalMessageRef?: string;
    text?: string;
    externalThreadId?: string;
  }, tx?: DatabaseOrTx): Promise<boolean> {
    const executor = tx || this.db;
    const { channelAccountId, externalMessageRef, text, externalThreadId } = params;

    // 1. Check if externalMessageRef matches an outbound action or bot message
    if (externalMessageRef) {
      const actions = await executor
        .select({ id: outboundActions.id })
        .from(outboundActions)
        .where(
          and(
            eq(outboundActions.channelAccountId, channelAccountId),
            eq(outboundActions.externalMessageRef, externalMessageRef)
          )
        )
        .limit(1);
      if (actions.length > 0) return true;

      const msgs = await executor
        .select({ id: messages.id, actor: messages.actor, direction: messages.direction })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, channelAccountId),
            eq(messages.externalMessageId, externalMessageRef)
          )
        )
        .limit(1);
      if (msgs.length > 0 && msgs[0]?.actor === "AI" && msgs[0]?.direction === "OUTBOUND") return true;
    }

    // 2. Strong text match against recent bot actions scoped to the exact thread (if available) or channel.
    // Require exact trimmed or exact normalized text match. Never assume bot outbound based on thread alone!
    if (text && text.trim().length > 0) {
      const trimmedText = text.trim();
      const normActual = normalizeTextForMatch(trimmedText);
      const recentThreshold = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes

      if (externalThreadId) {
        const matching = await executor
          .select({ id: outboundActions.id, text: outboundActions.text })
          .from(outboundActions)
          .innerJoin(conversations, eq(outboundActions.conversationId, conversations.id))
          .where(
            and(
              eq(outboundActions.channelAccountId, channelAccountId),
              eq(outboundActions.actor, "AI"),
              eq(conversations.externalThreadId, externalThreadId),
              inArray(outboundActions.status, ["SENT", "CONFIRMED", "SEND_UNCERTAIN"]),
              gte(outboundActions.createdAt, recentThreshold)
            )
          )
          .limit(25);

        for (const m of matching) {
          if (m.text.trim().toLowerCase() === trimmedText.toLowerCase()) return true;
          const normExpected = normalizeTextForMatch(m.text);
          if (normExpected && normActual && normExpected === normActual) return true;
        }
      } else {
        const matching = await executor
          .select({ id: outboundActions.id, text: outboundActions.text })
          .from(outboundActions)
          .where(
            and(
              eq(outboundActions.channelAccountId, channelAccountId),
              eq(outboundActions.actor, "AI"),
              inArray(outboundActions.status, ["SENT", "CONFIRMED", "SEND_UNCERTAIN"]),
              gte(outboundActions.createdAt, recentThreshold)
            )
          )
          .limit(25);

        for (const m of matching) {
          if (m.text.trim().toLowerCase() === trimmedText.toLowerCase()) return true;
          const normExpected = normalizeTextForMatch(m.text);
          if (normExpected && normActual && normExpected === normActual) return true;
        }
      }
    }

    return false;
  }
}
