import { eq, and, lte, gt, asc, sql, isNull, or } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  conversationQueue,
  conversations,
  customers,
  channelAccounts,
} from "../schema/index.js";
import type { QueueItemDto } from "@messenger/contracts";
import { randomUUID } from "node:crypto";

export interface ClaimNextOptions {
  leaseDurationMs?: number;
  stickyWindowMs?: number;
  stickyMaxTurns?: number;
  stickyMaxDurationMs?: number;
}

export interface ClaimResult {
  queueId: string;
  conversationId: string;
  externalThreadId: string;
  externalThreadRef: string;
  inboundVersion: number;
  claimToken: string;
  fencingToken: number;
  leaseExpiresAt: Date;
  isSticky: boolean;
  stickyTurns: number;
}

export class QueueRepository {
  constructor(private db: Database) {}

  /**
   * Enforces single-agent processing:
   * Returns null if channel is PAUSED/SUSPENDED, or if another conversation is actively CLAIMED.
   * If a sticky eligible conversation is ready, claims it first; otherwise takes the earliest FIFO item whose debounce expired (readyAt <= now).
   */
  async claimNext(
    channelAccountId: string,
    options: ClaimNextOptions = {}
  ): Promise<ClaimResult | null> {
    const leaseDurationMs = options.leaseDurationMs || 30000;
    const stickyMaxTurns = options.stickyMaxTurns || 3;
    const stickyMaxDurationMs = options.stickyMaxDurationMs || 120000;
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      // 1. Check channel status
      const [channel] = await tx
        .select({
          status: channelAccounts.status,
          isSuspended: channelAccounts.isSuspended,
          isPaused: channelAccounts.isPaused,
        })
        .from(channelAccounts)
        .where(eq(channelAccounts.id, channelAccountId))
        .limit(1);

      if (!channel || channel.isSuspended || channel.isPaused || channel.status !== "RUNNING") {
        return null;
      }

      // 2. Check if another conversation currently has an active valid lease
      const activeClaim = await tx
        .select({ id: conversationQueue.id })
        .from(conversationQueue)
        .where(
          and(
            eq(conversationQueue.channelAccountId, channelAccountId),
            gt(conversationQueue.leaseExpiresAt, now)
          )
        )
        .limit(1);

      if (activeClaim.length > 0) {
        return null; // A conversation is currently being actively served
      }

      // 3. Find candidates whose debounce timer expired (ready_at <= now)
      // Check if there are any other conversations waiting in queue to determine fairness/yield
      const waitingCountRes = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationQueue)
        .where(
          and(
            eq(conversationQueue.channelAccountId, channelAccountId),
            lte(conversationQueue.readyAt, now)
          )
        );
      const waitingCount = waitingCountRes[0]?.count || 0;

      // 4. Check for sticky eligible item
      let targetRow: typeof conversationQueue.$inferSelect | undefined;

      if (waitingCount > 1) {
        // When others are waiting, enforce strict limits on sticky:
        const stickyCandidates = await tx
          .select()
          .from(conversationQueue)
          .where(
            and(
              eq(conversationQueue.channelAccountId, channelAccountId),
              lte(conversationQueue.readyAt, now),
              gt(conversationQueue.continuationEligibleUntil, now),
              eq(conversationQueue.yieldRequired, false),
              lte(conversationQueue.stickyTurns, stickyMaxTurns)
            )
          )
          .limit(1);

        const cand = stickyCandidates[0];
        if (cand) {
          const startedAt = cand.stickyStartedAt ? new Date(cand.stickyStartedAt).getTime() : now.getTime();
          const duration = now.getTime() - startedAt;
          if (cand.stickyTurns >= stickyMaxTurns || duration >= stickyMaxDurationMs) {
            // Must yield to others!
            await tx
              .update(conversationQueue)
              .set({ yieldRequired: true, continuationEligibleUntil: null })
              .where(eq(conversationQueue.id, cand.id));
          } else {
            targetRow = cand;
          }
        }
      }

      // If no sticky row selected, pick FIFO by readyAt among QUEUED conversations
      if (!targetRow) {
        const fifoCandidates = await tx
          .select({
            queue: conversationQueue,
          })
          .from(conversationQueue)
          .innerJoin(conversations, eq(conversationQueue.conversationId, conversations.id))
          .where(
            and(
              eq(conversationQueue.channelAccountId, channelAccountId),
              eq(conversations.status, "QUEUED"),
              eq(conversations.manualMode, false),
              eq(conversations.isBlocked, false),
              lte(conversationQueue.readyAt, now),
              or(
                isNull(conversationQueue.leaseExpiresAt),
                lte(conversationQueue.leaseExpiresAt, now)
              )
            )
          )
          .orderBy(asc(conversationQueue.readyAt))
          .limit(1);

        targetRow = fifoCandidates[0]?.queue;
      }

      if (!targetRow) {
        return null;
      }

      // 5. Claim targetRow
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
      const isSticky = !!targetRow.continuationEligibleUntil && targetRow.stickyTurns > 0;
      const nextStickyTurns = isSticky ? targetRow.stickyTurns + 1 : 1;
      const stickyStartedAt = targetRow.stickyStartedAt || now;

      // Increment attempt counter which also acts as fencing token for this claim
      const fencingToken = targetRow.attempt + 1;

      await tx
        .update(conversationQueue)
        .set({
          claimToken,
          leaseExpiresAt,
          attempt: fencingToken,
          stickyTurns: nextStickyTurns,
          stickyStartedAt,
          updatedAt: now,
        })
        .where(eq(conversationQueue.id, targetRow.id));

      // Update conversation state to CLAIMED
      const [conv] = await tx
        .update(conversations)
        .set({
          status: "CLAIMED",
          claimedAt: now,
          claimToken,
          updatedAt: now,
        })
        .where(eq(conversations.id, targetRow.conversationId))
        .returning({
          externalThreadId: conversations.externalThreadId,
          externalThreadRef: conversations.externalThreadRef,
          inboundVersion: conversations.inboundVersion,
        });

      if (!conv) {
        throw new Error("Target conversation missing during claim");
      }

      return {
        queueId: targetRow.id,
        conversationId: targetRow.conversationId,
        externalThreadId: conv.externalThreadId,
        externalThreadRef: conv.externalThreadRef,
        inboundVersion: conv.inboundVersion,
        claimToken,
        fencingToken,
        leaseExpiresAt,
        isSticky,
        stickyTurns: nextStickyTurns,
      };
    });
  }

  /**
   * Renew lease if claimToken matches.
   */
  async renewLease(conversationId: string, claimToken: string, extendMs = 30000): Promise<boolean> {
    const now = new Date();
    const newExpires = new Date(now.getTime() + extendMs);

    const res = await this.db
      .update(conversationQueue)
      .set({
        leaseExpiresAt: newExpires,
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationQueue.conversationId, conversationId),
          eq(conversationQueue.claimToken, claimToken)
        )
      );

    return res.length > 0;
  }

  /**
   * Release queue item upon turn completion or failure.
   */
  async release(
    conversationId: string,
    claimToken: string,
    options: {
      nextStatus: "WAITING_CUSTOMER" | "BLOCKED" | "ERROR";
      stickyWindowMs?: number;
      keepInQueueForReply?: boolean;
    }
  ): Promise<void> {
    const now = new Date();

    await this.db.transaction(async (tx) => {
      // Clear claim on conversation
      await tx
        .update(conversations)
        .set({
          status: options.nextStatus,
          claimToken: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.claimToken, claimToken)
          )
        );

      // Always remove finished turn from active conversation_queue
      await tx
        .delete(conversationQueue)
        .where(eq(conversationQueue.conversationId, conversationId));
    });
  }

  /**
   * Get formatted queue items for dashboard with position and estimated wait time.
   */
  async getQueueList(channelAccountId: string): Promise<QueueItemDto[]> {
    const rows = await this.db
      .select({
        queue: conversationQueue,
        conv: conversations,
        cust: customers,
      })
      .from(conversationQueue)
      .innerJoin(conversations, eq(conversationQueue.conversationId, conversations.id))
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(
        and(
          eq(conversationQueue.channelAccountId, channelAccountId),
          eq(conversations.status, "QUEUED")
        )
      )
      .orderBy(asc(conversationQueue.readyAt));

    const now = Date.now();
    const avgTurnSeconds = 25; // Moving average estimation baseline

    return rows.map((r, index) => {
      const isSticky = !!r.queue.continuationEligibleUntil && new Date(r.queue.continuationEligibleUntil).getTime() > now;
      return {
        queueId: r.queue.id,
        conversationId: r.conv.id,
        customerName: r.cust?.name || null,
        queuedAt: r.queue.queuedAt,
        readyAt: r.queue.readyAt,
        inboundVersion: r.queue.inboundVersion,
        attempt: r.queue.attempt,
        isSticky,
        stickyTurns: r.queue.stickyTurns,
        yieldRequired: r.queue.yieldRequired,
        position: index + 1,
        estimatedWaitSeconds: index * avgTurnSeconds,
      };
    });
  }

  /**
   * Moves conversation to the very top of queue by setting readyAt to Epoch.
   */
  async prioritizeConversation(conversationId: string): Promise<boolean> {
    const res = await this.db
      .update(conversationQueue)
      .set({
        readyAt: new Date(0),
        updatedAt: new Date(),
      })
      .where(eq(conversationQueue.conversationId, conversationId));
    return res.length > 0;
  }
}
