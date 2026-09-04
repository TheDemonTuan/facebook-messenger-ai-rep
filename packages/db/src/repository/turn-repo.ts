import { eq, and, sql } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { turns, channelAccounts } from "../schema/index.js";
import type { TurnStatus } from "@messenger/contracts";

export interface CreateTurnParams {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
  metadata?: Record<string, unknown>;
}

export class TurnRepository {
  constructor(private db: Database) {}

  /**
   * Creates or gets existing turn for a conversation and inboundVersion.
   * Guarantees unique (conversationId, inboundVersion).
   */
  async createOrGetTurn(params: CreateTurnParams, tx?: DatabaseOrTx): Promise<typeof turns.$inferSelect> {
    const executor = tx || this.db;

    const [created] = await executor
      .insert(turns)
      .values({
        channelAccountId: params.channelAccountId,
        conversationId: params.conversationId,
        inboundVersion: params.inboundVersion,
        status: "PENDING",
        metadata: params.metadata || {},
      })
      .onConflictDoNothing({
        target: [turns.conversationId, turns.inboundVersion],
      })
      .returning();

    if (created) return created;

    const [existing] = await executor
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.conversationId, params.conversationId),
          eq(turns.inboundVersion, params.inboundVersion)
        )
      )
      .limit(1);

    if (!existing) {
      throw new Error(`Turn could not be created or found for conv=${params.conversationId} v=${params.inboundVersion}`);
    }
    return existing;
  }

  /**
   * Atomic claim of a turn: Sets active_turn_id in channel_accounts and updates turn to THINKING with fencing epoch CAS.
   */
  async claimTurn(
    turnId: string,
    ownerToken: string,
    leaseSeconds = 90,
    tx?: DatabaseOrTx
  ): Promise<typeof turns.$inferSelect | null> {
    const executor = (tx || this.db) as Database;

    return await executor.transaction(async (innerTx) => {
      const [turn] = await innerTx
        .select()
        .from(turns)
        .where(eq(turns.id, turnId))
        .limit(1);

      if (!turn || turn.status !== "PENDING") {
        return null;
      }

      // Check channel active_turn_id and lease
      const now = new Date();
      const [channel] = await innerTx
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.id, turn.channelAccountId))
        .limit(1);

      if (
        channel &&
        channel.activeTurnId &&
        channel.activeTurnId !== turn.id &&
        channel.leaseExpiresAt &&
        channel.leaseExpiresAt > now
      ) {
        // Channel already occupied by another active turn
        return null;
      }

      const nextFencingEpoch = (channel?.fencingEpoch || 0) + 1;
      const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

      // Update channel runtime fields
      await innerTx
        .update(channelAccounts)
        .set({
          activeTurnId: turn.id,
          currentOwnerToken: ownerToken,
          fencingEpoch: nextFencingEpoch,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(eq(channelAccounts.id, turn.channelAccountId));

      // Update turn
      const [updatedTurn] = await innerTx
        .update(turns)
        .set({
          status: "THINKING",
          ownerToken,
          fencingEpoch: nextFencingEpoch,
          startedAt: now,
          updatedAt: now,
        })
        .where(eq(turns.id, turn.id))
        .returning();

      return updatedTurn || null;
    });
  }

  /**
   * Heartbeat to extend active turn lease on channel account.
   */
  async heartbeat(
    channelAccountId: string,
    turnId: string,
    ownerToken: string,
    fencingEpoch: number,
    leaseSeconds = 90
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE ${channelAccounts}
      SET lease_expires_at = clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
          updated_at = clock_timestamp()
      WHERE id = ${channelAccountId}
        AND active_turn_id = ${turnId}
        AND current_owner_token = ${ownerToken}
        AND fencing_epoch = ${fencingEpoch}
      RETURNING id;
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]);
    return Boolean(rows && rows.length > 0);
  }

  /**
   * Strict CAS transition for turn status.
   */
  async transitionStatus(
    turnId: string,
    expectedStatus: TurnStatus,
    nextStatus: TurnStatus,
    ownerToken: string,
    fencingEpoch: number,
    extra?: { errorMessage?: string; metadata?: Record<string, unknown> },
    tx?: DatabaseOrTx
  ): Promise<typeof turns.$inferSelect | null> {
    const executor = tx || this.db;
    const now = new Date();

    const [updated] = await executor
      .update(turns)
      .set({
        status: nextStatus,
        completedAt: ["COMPLETED", "FAILED", "CANCELLED"].includes(nextStatus) ? now : undefined,
        errorMessage: extra?.errorMessage || null,
        metadata: extra?.metadata ? sql`metadata || ${JSON.stringify(extra.metadata)}::jsonb` : undefined,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, turnId),
          eq(turns.status, expectedStatus),
          eq(turns.ownerToken, ownerToken),
          eq(turns.fencingEpoch, fencingEpoch)
        )
      )
      .returning();

    if (updated && ["COMPLETED", "FAILED", "CANCELLED"].includes(nextStatus)) {
      // Clear active_turn_id from channel_accounts if matched
      await executor.execute(sql`
        UPDATE ${channelAccounts}
        SET active_turn_id = NULL,
            current_owner_token = NULL,
            lease_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${updated.channelAccountId}
          AND active_turn_id = ${turnId}
          AND current_owner_token = ${ownerToken}
          AND fencing_epoch = ${fencingEpoch};
      `);
    }

    return updated || null;
  }

  /**
   * Reconciles expired turn leases on channel accounts.
   */
  async reconcileStaleTurns(): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE ${channelAccounts}
      SET active_turn_id = NULL,
          current_owner_token = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE active_turn_id IS NOT NULL
        AND lease_expires_at < clock_timestamp()
      RETURNING id;
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]);
    return rows ? rows.length : 0;
  }

  async getTurnById(turnId: string): Promise<typeof turns.$inferSelect | null> {
    const rows = await this.db.select().from(turns).where(eq(turns.id, turnId)).limit(1);
    return rows[0] || null;
  }

  async cancelTurn(turnId: string, reason?: string, tx?: DatabaseOrTx): Promise<void> {
    const executor = tx || this.db;
    await executor
      .update(turns)
      .set({
        status: "CANCELLED",
        errorMessage: reason || null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(turns.id, turnId));
  }

  async failTurn(
    turnId: string,
    ownerToken: string,
    fencingEpoch: number,
    errorMessage?: string,
    tx?: DatabaseOrTx
  ): Promise<void> {
    await this.transitionStatus(
      turnId,
      "THINKING",
      "FAILED",
      ownerToken,
      fencingEpoch,
      { errorMessage },
      tx
    );
  }
}
