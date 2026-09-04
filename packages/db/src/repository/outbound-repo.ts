import { eq, and, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { outboundActions, conversations, messages } from "../schema/index.js";
import type { OutboundActionStatus, SenderActor } from "@messenger/contracts";
import { createHash } from "node:crypto";

export interface CreateOutboundActionParams {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
  responseIndex: number;
  text: string;
  actor: SenderActor;
  claimToken: string;
  fencingToken: number;
}

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

  async createAction(params: CreateOutboundActionParams) {
    const actionId = OutboundRepository.computeActionId(
      params.channelAccountId,
      params.conversationId,
      params.inboundVersion,
      params.responseIndex
    );
    const textHash = createHash("sha256").update(params.text.trim()).digest("hex");

    const [row] = await this.db
      .insert(outboundActions)
      .values({
        channelAccountId: params.channelAccountId,
        conversationId: params.conversationId,
        actionId,
        inboundVersion: params.inboundVersion,
        responseIndex: params.responseIndex,
        text: params.text,
        textHash,
        actor: params.actor,
        status: "PENDING",
        claimToken: params.claimToken,
        fencingToken: params.fencingToken,
      })
      .onConflictDoUpdate({
        target: outboundActions.actionId,
        set: {
          text: params.text,
          textHash,
          status: "PENDING",
          claimToken: params.claimToken,
          fencingToken: params.fencingToken,
          updatedAt: new Date(),
        },
      })
      .returning();

    return row;
  }

  async getActionById(actionId: string) {
    const rows = await this.db
      .select()
      .from(outboundActions)
      .where(eq(outboundActions.actionId, actionId))
      .limit(1);
    return rows[0] || null;
  }

  async updateStatus(
    actionId: string,
    status: OutboundActionStatus,
    extra?: {
      externalMessageRef?: string;
      errorMessage?: string;
      unconfirmedReason?: string;
    }
  ) {
    const now = new Date();
    const updateData: Partial<typeof outboundActions.$inferInsert> = {
      status,
      updatedAt: now,
      ...(extra?.externalMessageRef ? { externalMessageRef: extra.externalMessageRef } : {}),
      ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
      ...(extra?.unconfirmedReason ? { unconfirmedReason: extra.unconfirmedReason } : {}),
    };

    if (status === "TYPING") {
      updateData.startedTypingAt = now;
    } else if (status === "SENDING") {
      updateData.startedSendingAt = now;
    } else if (status === "SENT") {
      updateData.confirmedAt = now;
    }

    const [updated] = await this.db
      .update(outboundActions)
      .set(updateData)
      .where(eq(outboundActions.actionId, actionId))
      .returning();

    return updated;
  }

  /**
   * Confirms send: marks outboundAction SENT, records message row and updates conversation lastOutboundAt
   */
  async confirmSent(actionId: string, externalMessageRef?: string) {
    return await this.db.transaction(async (tx) => {
      const now = new Date();
      const [action] = await tx
        .select()
        .from(outboundActions)
        .where(eq(outboundActions.actionId, actionId))
        .limit(1);

      if (!action) throw new Error(`Outbound action not found: ${actionId}`);

      // Update action status
      await tx
        .update(outboundActions)
        .set({
          status: "SENT",
          confirmedAt: now,
          externalMessageRef: externalMessageRef || action.externalMessageRef,
          updatedAt: now,
        })
        .where(eq(outboundActions.id, action.id));

      // Insert outbound message row
      const externalMsgId = externalMessageRef || `outbound-${action.actionId}`;
      await tx
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
      await tx
        .update(conversations)
        .set({
          lastOutboundAt: now,
          unreadCount: 0,
          updatedAt: now,
        })
        .where(eq(conversations.id, action.conversationId));

      return action;
    });
  }

  /**
   * Abort remaining pending actions for a conversation if inbound version advanced
   */
  async abortStaleActions(conversationId: string, currentInboundVersion: number) {
    return await this.db
      .update(outboundActions)
      .set({
        status: "ABORTED",
        errorMessage: `Aborted due to new inbound version (${currentInboundVersion})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundActions.conversationId, conversationId),
          sql`${outboundActions.inboundVersion} < ${currentInboundVersion}`,
          sql`${outboundActions.status} IN ('PENDING', 'TYPING')`
        )
      );
  }
}
