import { eq, and, sql, notInArray } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { outboundActions, conversations, messages } from "../schema/index.js";
import type { OutboundActionStatus, SenderActor } from "@messenger/contracts";
import { createHash } from "node:crypto";

export interface CreateOutboundActionParams {
  channelAccountId: string;
  conversationId: string;
  turnId?: string;
  inboundVersion: number;
  responseIndex: number;
  text: string;
  actor: SenderActor;
  claimToken?: string;
  ownerToken?: string;
  fencingToken?: number;
  fencingEpoch?: number;
}

export interface TransitionActionOptions {
  ownerToken?: string;
  fencingEpoch?: number;
  externalMessageRef?: string;
  errorMessage?: string;
  unconfirmedReason?: string;
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
   * Deterministically generates action_id: sha256(channelAccountId + conversationId + inboundVersion + responseIndex)
   */
  static computeActionId(
    channelAccountId: string,
    conversationId: string,
    inboundVersion: number,
    responseIndex: number
  ): string {
    const raw = `${channelAccountId}:${conversationId}:${inboundVersion}:${responseIndex}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Idempotently creates an action.
   * If action already exists in a terminal state (CONFIRMED, CANCELLED), does NOT overwrite.
   */
  async createAction(params: CreateOutboundActionParams, tx?: DatabaseOrTx) {
    const executor = tx || this.db;
    const actionId = OutboundRepository.computeActionId(
      params.channelAccountId,
      params.conversationId,
      params.inboundVersion,
      params.responseIndex
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
}
