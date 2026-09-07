import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { conversations, conversationQueue, outboundActions } from "../schema/index.js";
import type { ReplyControlMode } from "@messenger/contracts";

const HUMAN_MODES: ReplyControlMode[] = [
  "HUMAN_DRAFT",
  "HUMAN_SESSION",
  "HUMAN_PINNED",
  "REVIEW_HOLD",
];

export interface ConversationControl {
  mode: ReplyControlMode;
  epoch: number;
  holdUntil: Date | null;
  suppressedThroughInboundVersion: number;
}

export class ConversationControlService {
  constructor(private db: Database) {}

  async get(conversationId: string, tx?: DatabaseOrTx): Promise<ConversationControl | null> {
    const executor = tx ?? this.db;
    const [conversation] = await executor
      .select({
        mode: conversations.replyControlMode,
        epoch: conversations.controlEpoch,
        holdUntil: conversations.humanHoldUntil,
        suppressedThroughInboundVersion: conversations.suppressedThroughInboundVersion,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) return null;
    return {
      mode: (conversation.mode || "AUTO") as ReplyControlMode,
      epoch: conversation.epoch ?? 0,
      holdUntil: conversation.holdUntil ?? null,
      suppressedThroughInboundVersion: conversation.suppressedThroughInboundVersion ?? 0,
    };
  }

  async canAiReply(
    conversationId: string,
    expectedEpoch: number,
    inboundVersion: number,
    tx?: DatabaseOrTx
  ): Promise<boolean> {
    const control = await this.get(conversationId, tx);
    return Boolean(
      control &&
        control.mode === "AUTO" &&
        control.epoch === expectedEpoch &&
        inboundVersion > control.suppressedThroughInboundVersion
    );
  }

  async acquirePinned(conversationId: string, userId?: string | null): Promise<ConversationControl> {
    return this.transitionHuman(conversationId, "HUMAN_PINNED", null, "MANUAL_TAKEOVER", userId);
  }

  async acquireSession(
    conversationId: string,
    options: { userId?: string | null; outboundRef?: string | null; holdDurationMs?: number } = {}
  ): Promise<ConversationControl> {
    return this.transitionHuman(
      conversationId,
      "HUMAN_SESSION",
      new Date(Date.now() + (options.holdDurationMs ?? 30 * 60 * 1000)),
      "HUMAN_OUTBOUND",
      options.userId,
      options.outboundRef
    );
  }

  async acquireReviewHold(
    conversationId: string,
    reason: string = "OUTBOUND_UNATTRIBUTED"
  ): Promise<ConversationControl> {
    return this.transitionHuman(conversationId, "REVIEW_HOLD", null, reason);
  }

  async acquireDraft(
    conversationId: string,
    leaseId: string,
    userId?: string | null,
    leaseDurationMs: number = 60_000
  ): Promise<ConversationControl> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ inboundVersion: conversations.inboundVersion, controlEpoch: conversations.controlEpoch })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!current) throw new Error(`Conversation ${conversationId} not found`);

      const epoch = current.controlEpoch + 1;
      await tx
        .update(conversations)
        .set({
          replyControlMode: "HUMAN_DRAFT",
          controlEpoch: epoch,
          controlReason: "DRAFT_LEASE",
          controlChangedAt: now,
          controlledByUserId: userId ?? null,
          draftLeaseId: leaseId,
          draftLeaseExpiresAt: expiresAt,
          manualMode: true,
          status: "MANUAL",
          suppressedThroughInboundVersion: current.inboundVersion,
          updatedAt: now,
        })
        .where(eq(conversations.id, conversationId));
      await this.cancelQueuedAi(conversationId, tx);
      return { mode: "HUMAN_DRAFT", epoch, holdUntil: null, suppressedThroughInboundVersion: current.inboundVersion };
    });
  }

  async release(conversationId: string, userId?: string | null): Promise<ConversationControl> {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ controlEpoch: conversations.controlEpoch, suppressedThroughInboundVersion: conversations.suppressedThroughInboundVersion })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!current) throw new Error(`Conversation ${conversationId} not found`);
      const epoch = current.controlEpoch + 1;
      await tx
        .update(conversations)
        .set({
          replyControlMode: "AUTO",
          controlEpoch: epoch,
          controlReason: "MANUAL_RELEASE",
          controlChangedAt: now,
          controlledByUserId: userId ?? null,
          manualMode: false,
          status: "WAITING_CUSTOMER",
          humanHoldUntil: null,
          draftLeaseId: null,
          draftLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(conversations.id, conversationId));
      return { mode: "AUTO", epoch, holdUntil: null, suppressedThroughInboundVersion: current.suppressedThroughInboundVersion };
    });
  }

  async expireSessionIfDue(conversationId: string, now: Date = new Date()): Promise<ConversationControl | null> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          mode: conversations.replyControlMode,
          controlEpoch: conversations.controlEpoch,
          humanHoldUntil: conversations.humanHoldUntil,
          suppressedThroughInboundVersion: conversations.suppressedThroughInboundVersion,
          draftLeaseExpiresAt: conversations.draftLeaseExpiresAt,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!current) return null;

      const isExpiredSession = current.mode === "HUMAN_SESSION" && current.humanHoldUntil && current.humanHoldUntil <= now;
      const isExpiredDraft = current.mode === "HUMAN_DRAFT" && current.draftLeaseExpiresAt && current.draftLeaseExpiresAt <= now;
      if (!isExpiredSession && !isExpiredDraft) {
        return {
          mode: current.mode as ReplyControlMode,
          epoch: current.controlEpoch,
          holdUntil: current.humanHoldUntil,
          suppressedThroughInboundVersion: current.suppressedThroughInboundVersion,
        };
      }

      const epoch = current.controlEpoch + 1;
      await tx
        .update(conversations)
        .set({
          replyControlMode: "AUTO",
          controlEpoch: epoch,
          controlReason: isExpiredDraft ? "DRAFT_LEASE_EXPIRED" : "HUMAN_SESSION_EXPIRED",
          controlChangedAt: now,
          manualMode: false,
          status: "WAITING_CUSTOMER",
          humanHoldUntil: null,
          draftLeaseId: null,
          draftLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(conversations.id, conversationId));
      return { mode: "AUTO", epoch, holdUntil: null, suppressedThroughInboundVersion: current.suppressedThroughInboundVersion };
    });
  }

  private async transitionHuman(
    conversationId: string,
    mode: ReplyControlMode,
    holdUntil: Date | null,
    reason: string,
    userId?: string | null,
    outboundRef?: string | null
  ): Promise<ConversationControl> {
    if (!HUMAN_MODES.includes(mode)) throw new Error(`Invalid human control mode ${mode}`);
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ inboundVersion: conversations.inboundVersion, controlEpoch: conversations.controlEpoch })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!current) throw new Error(`Conversation ${conversationId} not found`);
      const epoch = current.controlEpoch + 1;
      await tx
        .update(conversations)
        .set({
          replyControlMode: mode,
          controlEpoch: epoch,
          controlReason: reason,
          controlChangedAt: now,
          controlledByUserId: userId ?? null,
          lastHumanOutboundAt: outboundRef ? now : undefined,
          lastHumanOutboundRef: outboundRef ?? undefined,
          humanSessionLastActivityAt: mode === "HUMAN_SESSION" ? now : undefined,
          humanHoldUntil: holdUntil,
          draftLeaseId: null,
          draftLeaseExpiresAt: null,
          manualMode: true,
          status: "MANUAL",
          suppressedThroughInboundVersion: current.inboundVersion,
          updatedAt: now,
        })
        .where(eq(conversations.id, conversationId));
      await this.cancelQueuedAi(conversationId, tx);
      return { mode, epoch, holdUntil, suppressedThroughInboundVersion: current.inboundVersion };
    });
  }

  private async cancelQueuedAi(conversationId: string, tx: DatabaseOrTx): Promise<void> {
    await tx
      .update(outboundActions)
      .set({ status: "CANCELLED", errorMessage: "Cancelled because human reply control acquired", updatedAt: new Date() })
      .where(
        and(
          eq(outboundActions.conversationId, conversationId),
          eq(outboundActions.actor, "AI"),
          inArray(outboundActions.status, ["PENDING", "TYPING"])
        )
      );
    await tx.delete(conversationQueue).where(eq(conversationQueue.conversationId, conversationId));
  }
}
