import { and, eq, inArray, or, lte } from "drizzle-orm";
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
  changed?: boolean;
}

export interface AcquireSessionOptions {
  userId?: string | null;
  outboundRef?: string | null;
  holdDurationMs?: number;
  maxSessionMs?: number;
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
    const mode = (conversation.mode || (conversation as unknown as { replyControlMode?: string }).replyControlMode || "AUTO") as ReplyControlMode;
    const epoch = conversation.epoch ?? (conversation as unknown as { controlEpoch?: number }).controlEpoch ?? 0;
    const holdUntil = conversation.holdUntil ?? (conversation as unknown as { humanHoldUntil?: Date | null }).humanHoldUntil ?? null;
    const suppressedThroughInboundVersion = conversation.suppressedThroughInboundVersion ?? 0;

    return {
      mode,
      epoch,
      holdUntil,
      suppressedThroughInboundVersion,
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

  /**
   * Acquires or refreshes a human session.
   * If already HUMAN_PINNED: keeps pinned mode, updates activity timestamp only.
   * If already HUMAN_SESSION: refreshes holdUntil (capped by maxSessionMs).
   * Otherwise: starts a new HUMAN_SESSION with humanSessionStartedAt = now.
   */
  async acquireOrRefreshSession(
    conversationId: string,
    options: AcquireSessionOptions = {},
    tx?: DatabaseOrTx
  ): Promise<ConversationControl> {
    const holdDurationMs = options.holdDurationMs ?? 120_000;
    const maxSessionMs = options.maxSessionMs ?? 600_000;
    const now = new Date();

    const runInTx = async (dbTx: DatabaseOrTx): Promise<ConversationControl> => {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const [current] = await dbTx
        .select({
          inboundVersion: conversations.inboundVersion,
          controlEpoch: conversations.controlEpoch,
          replyControlMode: conversations.replyControlMode,
          humanSessionStartedAt: conversations.humanSessionStartedAt,
          humanHoldUntil: conversations.humanHoldUntil,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (!current) throw new Error(`Conversation ${conversationId} not found`);

      // 1. If currently HUMAN_PINNED: operator has persistent takeover. Do not downgrade.
      if (current.replyControlMode === "HUMAN_PINNED") {
        await dbTx
          .update(conversations)
          .set({
            lastHumanOutboundAt: now,
            lastHumanOutboundRef: options.outboundRef ?? undefined,
            humanSessionLastActivityAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.controlEpoch, current.controlEpoch)
            )
          );

        await this.cancelQueuedAi(conversationId, dbTx);
        return {
          mode: "HUMAN_PINNED",
          epoch: current.controlEpoch,
          holdUntil: null,
          suppressedThroughInboundVersion: current.inboundVersion,
          changed: false,
        };
      }

      // 2. If already in HUMAN_SESSION: refresh session with cap
      if (current.replyControlMode === "HUMAN_SESSION") {
        const sessionStartedAt = current.humanSessionStartedAt ?? now;
        const maxExpiry = new Date(sessionStartedAt.getTime() + maxSessionMs);
        const targetHold = new Date(now.getTime() + holdDurationMs);
        const finalHoldUntil = targetHold.getTime() > maxExpiry.getTime() ? maxExpiry : targetHold;
        const epoch = current.controlEpoch + 1;

        const updateQuery = dbTx
          .update(conversations)
          .set({
            replyControlMode: "HUMAN_SESSION",
            controlEpoch: epoch,
            controlReason: "HUMAN_OUTBOUND_REFRESH",
            controlChangedAt: now,
            lastHumanOutboundAt: now,
            lastHumanOutboundRef: options.outboundRef ?? null,
            humanSessionLastActivityAt: now,
            humanHoldUntil: finalHoldUntil,
            suppressedThroughInboundVersion: current.inboundVersion,
            manualMode: true,
            status: "MANUAL",
            updatedAt: now,
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.controlEpoch, current.controlEpoch)
            )
          );
        const updated = typeof updateQuery.returning === "function"
          ? await updateQuery.returning({ id: conversations.id })
          : [{ id: conversationId }];

        if (updated.length === 0) {
          if (attempt < maxAttempts) {
            continue;
          }
          const fresh = await this.get(conversationId, dbTx);
          if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
          return fresh;
        }

        await this.cancelQueuedAi(conversationId, dbTx);
        return {
          mode: "HUMAN_SESSION",
          epoch,
          holdUntil: finalHoldUntil,
          suppressedThroughInboundVersion: current.inboundVersion,
          changed: false,
        };
      }

      // 3. New HUMAN_SESSION acquisition
      const targetHold = new Date(now.getTime() + holdDurationMs);
      const epoch = current.controlEpoch + 1;

      const updateQuery = dbTx
        .update(conversations)
        .set({
          replyControlMode: "HUMAN_SESSION",
          controlEpoch: epoch,
          controlReason: "HUMAN_OUTBOUND",
          controlChangedAt: now,
          controlledByUserId: options.userId ?? null,
          lastHumanOutboundAt: now,
          lastHumanOutboundRef: options.outboundRef ?? null,
          humanSessionStartedAt: now,
          humanSessionLastActivityAt: now,
          humanHoldUntil: targetHold,
          draftLeaseId: null,
          draftLeaseExpiresAt: null,
          manualMode: true,
          status: "MANUAL",
          suppressedThroughInboundVersion: current.inboundVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.controlEpoch, current.controlEpoch)
          )
        );
      const updated = typeof updateQuery.returning === "function"
        ? await updateQuery.returning({ id: conversations.id })
        : [{ id: conversationId }];

      if (updated.length === 0) {
        if (attempt < maxAttempts) {
          continue;
        }
        const fresh = await this.get(conversationId, dbTx);
        if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
        return fresh;
      }

      await this.cancelQueuedAi(conversationId, dbTx);
      return {
        mode: "HUMAN_SESSION",
        epoch,
        holdUntil: targetHold,
        suppressedThroughInboundVersion: current.inboundVersion,
        changed: true,
      };
    }
    const fresh = await this.get(conversationId, dbTx);
    if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
    return fresh;
  };

    if (tx) {
      return runInTx(tx);
    }
    return typeof (this.db as unknown as { transaction?: unknown }).transaction === "function"
      ? this.db.transaction(runInTx)
      : runInTx(this.db);
  }

  async acquireSession(
    conversationId: string,
    options: AcquireSessionOptions = {}
  ): Promise<ConversationControl> {
    return this.acquireOrRefreshSession(conversationId, options);
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
    leaseDurationMs: number = 30_000
  ): Promise<ConversationControl> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    const runInTx = async (tx: DatabaseOrTx) => {
      const [current] = await tx
        .select({
          inboundVersion: conversations.inboundVersion,
          controlEpoch: conversations.controlEpoch,
          replyControlMode: conversations.replyControlMode,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!current) throw new Error(`Conversation ${conversationId} not found`);

      // Do not downgrade HUMAN_PINNED to draft lease
      if (current.replyControlMode === "HUMAN_PINNED") {
        return {
          mode: "HUMAN_PINNED" as ReplyControlMode,
          epoch: current.controlEpoch,
          holdUntil: null,
          suppressedThroughInboundVersion: current.inboundVersion,
          changed: false,
        };
      }

      const epoch = current.controlEpoch + 1;
      const updateQuery = tx
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
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.controlEpoch, current.controlEpoch)
          )
        );
      const updated = typeof updateQuery.returning === "function"
        ? await updateQuery.returning({ id: conversations.id })
        : [{ id: conversationId }];

      if (updated.length === 0) {
        const fresh = await this.get(conversationId, tx);
        if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
        return fresh;
      }

      await this.cancelQueuedAi(conversationId, tx);
      return { mode: "HUMAN_DRAFT" as ReplyControlMode, epoch, holdUntil: expiresAt, suppressedThroughInboundVersion: current.inboundVersion, changed: true };
    };

    return typeof (this.db as unknown as { transaction?: unknown }).transaction === "function"
      ? this.db.transaction(runInTx)
      : runInTx(this.db);
  }

  async release(conversationId: string, userId?: string | null): Promise<ConversationControl> {
    const now = new Date();
    const runInTx = async (tx: DatabaseOrTx): Promise<ConversationControl> => {
      const [current] = await tx
        .select({
          controlEpoch: conversations.controlEpoch,
          suppressedThroughInboundVersion: conversations.suppressedThroughInboundVersion,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!current) throw new Error(`Conversation ${conversationId} not found`);
      const currentEpoch = current.controlEpoch ?? 0;
      const epoch = currentEpoch + 1;
      const suppressedVersion = current.suppressedThroughInboundVersion ?? 0;
      const updateQuery = tx
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
          humanSessionStartedAt: null,
          humanSessionLastActivityAt: null,
          draftLeaseId: null,
          draftLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.controlEpoch, currentEpoch)
          )
        );
      const updated = typeof updateQuery.returning === "function"
        ? await updateQuery.returning({ id: conversations.id })
        : [{ id: conversationId }];

      if (updated.length === 0) {
        const fresh = await this.get(conversationId, tx);
        if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
        return fresh;
      }

      return { mode: "AUTO" as ReplyControlMode, epoch, holdUntil: null, suppressedThroughInboundVersion: suppressedVersion, changed: true };
    };

    return typeof (this.db as unknown as { transaction?: unknown }).transaction === "function"
      ? this.db.transaction(runInTx)
      : runInTx(this.db);
  }

  /**
   * Safely releases a technical REVIEW_HOLD (e.g. SEND_UNCERTAIN) back to AUTO using CAS.
   * Crucial invariant: Only releases if current mode is REVIEW_HOLD and reason matches (default SEND_UNCERTAIN).
   * Must NEVER release HUMAN_PINNED, HUMAN_SESSION, or operator manual modes!
   */
  async releaseTechnicalReviewHold(
    conversationId: string,
    reason = "SEND_UNCERTAIN",
    tx?: DatabaseOrTx
  ): Promise<ConversationControl | null> {
    const now = new Date();
    const runInTx = async (dbTx: DatabaseOrTx): Promise<ConversationControl | null> => {
      const [current] = await dbTx
        .select({
          mode: conversations.replyControlMode,
          controlEpoch: conversations.controlEpoch,
          controlReason: conversations.controlReason,
          suppressedThroughInboundVersion: conversations.suppressedThroughInboundVersion,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (!current) return null;
      const currentMode = (current.mode || (current as unknown as { replyControlMode?: string }).replyControlMode || "AUTO") as ReplyControlMode;
      const currentReason = current.controlReason ?? (current as unknown as { reason?: string }).reason ?? null;
      if (currentMode !== "REVIEW_HOLD" || currentReason !== reason) {
        return {
          mode: currentMode,
          epoch: current.controlEpoch ?? 0,
          holdUntil: null,
          suppressedThroughInboundVersion: current.suppressedThroughInboundVersion ?? 0,
        };
      }

      const epoch = (current.controlEpoch ?? 0) + 1;
      const updateQuery = dbTx
        .update(conversations)
        .set({
          replyControlMode: "AUTO",
          controlEpoch: epoch,
          controlReason: `${reason}_RESOLVED`,
          controlChangedAt: now,
          manualMode: false,
          status: "WAITING_CUSTOMER",
          updatedAt: now,
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.replyControlMode, "REVIEW_HOLD"),
            eq(conversations.controlEpoch, current.controlEpoch ?? 0)
          )
        );

      const updated = typeof (updateQuery as { returning?: unknown }).returning === "function"
        ? await (updateQuery as unknown as { returning: (arg: unknown) => Promise<unknown[]> }).returning({ id: conversations.id })
        : [{ id: conversationId }];

      if (updated.length === 0) {
        return await this.get(conversationId, dbTx);
      }

      return {
        mode: "AUTO",
        epoch,
        holdUntil: null,
        suppressedThroughInboundVersion: current.suppressedThroughInboundVersion ?? 0,
      };
    };

    if (tx) return runInTx(tx);
    return typeof (this.db as unknown as { transaction?: unknown }).transaction === "function"
      ? this.db.transaction(runInTx)
      : runInTx(this.db);
  }

  /**
   * Normalizes conversation control mode before evaluating inbound message policy.
   * Auto-releases expired HUMAN_DRAFT and HUMAN_SESSION back to AUTO.
   * Never auto-releases HUMAN_PINNED or REVIEW_HOLD.
   */
  async normalizeForInbound(
    conversationId: string,
    now: Date = new Date(),
    options?: { maxSessionMs?: number; autoResumeAfterHuman?: boolean },
    tx?: DatabaseOrTx
  ): Promise<ConversationControl | null> {
    const runInTx = async (dbTx: DatabaseOrTx): Promise<ConversationControl | null> => {
      const [current] = await dbTx
        .select({
          mode: conversations.replyControlMode,
          controlEpoch: conversations.controlEpoch,
          controlReason: conversations.controlReason,
          humanHoldUntil: conversations.humanHoldUntil,
          humanSessionStartedAt: conversations.humanSessionStartedAt,
          suppressedThroughInboundVersion: conversations.suppressedThroughInboundVersion,
          draftLeaseExpiresAt: conversations.draftLeaseExpiresAt,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (!current) return null;

      const mode = (current.mode || (current as unknown as { replyControlMode?: string }).replyControlMode || "AUTO") as ReplyControlMode;
      const controlEpoch = current.controlEpoch ?? (current as unknown as { epoch?: number }).epoch ?? 0;
      const humanHoldUntil = current.humanHoldUntil ?? (current as unknown as { holdUntil?: Date | null }).holdUntil ?? null;
      const humanSessionStartedAt = current.humanSessionStartedAt ?? null;
      const draftLeaseExpiresAt = current.draftLeaseExpiresAt ?? null;

      const isExpiredDraft =
        mode === "HUMAN_DRAFT" &&
        Boolean(draftLeaseExpiresAt && draftLeaseExpiresAt <= now);

      const isExpiredSession =
        mode === "HUMAN_SESSION" &&
        Boolean(humanHoldUntil && humanHoldUntil <= now);

      const isMaxExceeded =
        mode === "HUMAN_SESSION" &&
        Boolean(
          options?.maxSessionMs &&
            humanSessionStartedAt &&
            now.getTime() - humanSessionStartedAt.getTime() >= options.maxSessionMs
        );

      if (!isExpiredDraft && !isExpiredSession && !isMaxExceeded) {
        if (mode !== "AUTO") {
          await dbTx
            .update(conversations)
            .set({ manualMode: true, updatedAt: now })
            .where(
              and(
                eq(conversations.id, conversationId),
                eq(conversations.manualMode, false),
                eq(conversations.replyControlMode, mode),
                eq(conversations.controlEpoch, controlEpoch)
              )
            );
        } else {
          await dbTx
            .update(conversations)
            .set({ manualMode: false, updatedAt: now })
            .where(
              and(
                eq(conversations.id, conversationId),
                eq(conversations.manualMode, true),
                eq(conversations.replyControlMode, "AUTO"),
                eq(conversations.controlEpoch, controlEpoch)
              )
            );
        }
        return {
          mode,
          epoch: controlEpoch,
          holdUntil: humanHoldUntil,
          suppressedThroughInboundVersion: current.suppressedThroughInboundVersion ?? 0,
        };
      }

      // Automatic expiry must honor the channel policy. Explicit operator release
      // uses a separate transition and is never blocked by this setting.
      if (options?.autoResumeAfterHuman === false) {
        return {
          mode,
          epoch: controlEpoch,
          holdUntil: humanHoldUntil,
          suppressedThroughInboundVersion: current.suppressedThroughInboundVersion ?? 0,
        };
      }

      // Transition expired human mode back to AUTO
      const epoch = controlEpoch + 1;
      const reason = isExpiredDraft
        ? "DRAFT_LEASE_EXPIRED"
        : isMaxExceeded
        ? "HUMAN_SESSION_MAX_EXCEEDED"
        : "HUMAN_SESSION_EXPIRED";

      const expiryCondition = isExpiredDraft
        ? and(
            eq(conversations.replyControlMode, "HUMAN_DRAFT"),
            eq(conversations.controlEpoch, controlEpoch),
            lte(conversations.draftLeaseExpiresAt, now)
          )
        : and(
            eq(conversations.replyControlMode, "HUMAN_SESSION"),
            eq(conversations.controlEpoch, controlEpoch),
            lte(conversations.humanHoldUntil, now)
          );
      await dbTx
        .update(conversations)
        .set({
          replyControlMode: "AUTO",
          controlEpoch: epoch,
          controlReason: reason,
          controlChangedAt: now,
          manualMode: false,
          status: "WAITING_CUSTOMER",
          humanHoldUntil: null,
          humanSessionStartedAt: null,
          humanSessionLastActivityAt: null,
          draftLeaseId: null,
          draftLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(conversations.id, conversationId), expiryCondition));

      const after = await this.get(conversationId, dbTx);
      if (!after || after.mode !== "AUTO" || after.epoch !== epoch) {
        return after;
      }
      return { ...after, changed: true };
    };

    if (tx) {
      return runInTx(tx);
    }
    return typeof (this.db as unknown as { transaction?: unknown }).transaction === "function"
      ? this.db.transaction(runInTx)
      : runInTx(this.db);
  }

  async expireSessionIfDue(
    conversationId: string,
    now: Date = new Date(),
    options?: { maxSessionMs?: number; autoResumeAfterHuman?: boolean },
    tx?: DatabaseOrTx
  ): Promise<ConversationControl | null> {
    return this.normalizeForInbound(conversationId, now, options, tx);
  }

  /**
   * Periodic safety net to scan and auto-release expired human controls across conversations.
   */
  async expireOverdueHumanSessions(
    now: Date = new Date(),
    limit: number = 100,
    getAutoResumeAfterHuman?: (channelAccountId: string) => Promise<boolean>
  ): Promise<number> {
    const overdue = await this.db
      .select({ id: conversations.id, channelAccountId: conversations.channelAccountId })
      .from(conversations)
      .where(
        or(
          and(
            eq(conversations.replyControlMode, "HUMAN_SESSION"),
            lte(conversations.humanHoldUntil, now)
          ),
          and(
            eq(conversations.replyControlMode, "HUMAN_DRAFT"),
            lte(conversations.draftLeaseExpiresAt, now)
          )
        )
      )
      .limit(limit);

    let expiredCount = 0;
    for (const row of overdue) {
      try {
        const autoResumeAfterHuman = getAutoResumeAfterHuman
          ? await getAutoResumeAfterHuman(row.channelAccountId)
          : true;
        const before = await this.get(row.id);
        const normalized = await this.normalizeForInbound(row.id, now, { autoResumeAfterHuman });
        if (before?.mode !== normalized?.mode) expiredCount++;
      } catch (err) {
        console.warn(`[ConversationControlService] Failed to normalize conversation ${row.id}:`, err);
      }
    }
    return expiredCount;
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
    const runInTx = async (tx: DatabaseOrTx): Promise<ConversationControl> => {
      const maxAttempts = mode === "REVIEW_HOLD" ? 1 : 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const [current] = await tx
          .select({
            inboundVersion: conversations.inboundVersion,
            controlEpoch: conversations.controlEpoch,
            replyControlMode: conversations.replyControlMode,
            humanHoldUntil: conversations.humanHoldUntil,
            draftLeaseExpiresAt: conversations.draftLeaseExpiresAt,
          })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!current) throw new Error(`Conversation ${conversationId} not found`);

        // Human takeover precedence: if attempting to enter technical REVIEW_HOLD,
        // but conversation is currently under active human control (HUMAN_PINNED, active HUMAN_SESSION, or active HUMAN_DRAFT),
        // human takeover PREVAILS fail-safe. Do not overwrite human control!
        if (mode === "REVIEW_HOLD") {
          const isPinned = current.replyControlMode === "HUMAN_PINNED";
          const isActiveSession =
            current.replyControlMode === "HUMAN_SESSION" &&
            Boolean(current.humanHoldUntil && current.humanHoldUntil > now);
          const isActiveDraft =
            current.replyControlMode === "HUMAN_DRAFT" &&
            Boolean(current.draftLeaseExpiresAt && current.draftLeaseExpiresAt > now);
          if (isPinned || isActiveSession || isActiveDraft) {
            return {
              mode: current.replyControlMode as ReplyControlMode,
              epoch: current.controlEpoch,
              holdUntil: isActiveDraft ? current.draftLeaseExpiresAt : current.humanHoldUntil,
              suppressedThroughInboundVersion: current.inboundVersion,
              changed: false,
            };
          }
        }

        const epoch = current.controlEpoch + 1;
        const updateQuery = tx
          .update(conversations)
          .set({
            replyControlMode: mode,
            controlEpoch: epoch,
            controlReason: reason,
            controlChangedAt: now,
            controlledByUserId: userId ?? null,
            lastHumanOutboundAt: outboundRef ? now : undefined,
            lastHumanOutboundRef: outboundRef ?? undefined,
            humanSessionStartedAt: mode === "HUMAN_SESSION" ? now : undefined,
            humanSessionLastActivityAt: mode === "HUMAN_SESSION" ? now : undefined,
            humanHoldUntil: holdUntil,
            draftLeaseId: null,
            draftLeaseExpiresAt: null,
            manualMode: true,
            status: "MANUAL",
            suppressedThroughInboundVersion: current.inboundVersion,
            updatedAt: now,
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.controlEpoch, current.controlEpoch)
            )
          );
        const updated = typeof updateQuery.returning === "function"
          ? await updateQuery.returning({ id: conversations.id })
          : [{ id: conversationId }];

        if (updated.length === 0) {
          if (attempt < maxAttempts) {
            continue;
          }
          const fresh = await this.get(conversationId, tx);
          if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
          return fresh;
        }

        await this.cancelQueuedAi(conversationId, tx);
        return { mode, epoch, holdUntil, suppressedThroughInboundVersion: current.inboundVersion, changed: true };
      }

      const fresh = await this.get(conversationId, tx);
      if (!fresh) throw new Error(`Conversation ${conversationId} not found`);
      return fresh;
    };

    return typeof (this.db as unknown as { transaction?: unknown }).transaction === "function"
      ? this.db.transaction(runInTx)
      : runInTx(this.db);
  }

  private async cancelQueuedAi(conversationId: string, tx: DatabaseOrTx): Promise<void> {
    // Crucial invariant: NEVER cancel actions that have reached SEND_INTENT!
    // Enter has already been pressed; cancelling SEND_INTENT destroys send audit and delivery ambiguity.
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
    if (typeof tx.delete === "function") {
      await tx
        .delete(conversationQueue)
        .where(eq(conversationQueue.conversationId, conversationId));
    }
  }
}
