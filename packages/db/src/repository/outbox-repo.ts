import { sql, inArray } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { outboxEvents } from "../schema/index.js";

export interface EnqueueOutboxOptions {
  channelAccountId: string;
  conversationId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
  availableAt?: Date;
}

export class OutboxRepository {
  constructor(private db: Database) {}

  /**
   * Enqueues an outbox event, typically within the same transaction as the state mutation.
   */
  async enqueue(options: EnqueueOutboxOptions, tx?: DatabaseOrTx): Promise<typeof outboxEvents.$inferSelect> {
    const executor = tx || this.db;
    const now = options.availableAt || new Date();

    const [row] = await executor
      .insert(outboxEvents)
      .values({
        channelAccountId: options.channelAccountId,
        conversationId: options.conversationId || null,
        eventType: options.eventType,
        payload: options.payload || {},
        status: "PENDING",
        availableAt: now,
      })
      .returning();

    if (!row) {
      throw new Error("Failed to insert outbox event");
    }
    return row;
  }

  /**
   * Claims a batch of ready outbox events using FOR UPDATE SKIP LOCKED.
   */
  async claimBatch(
    batchSize = 50,
    lockDurationSeconds = 30,
    tx?: DatabaseOrTx
  ): Promise<Array<typeof outboxEvents.$inferSelect>> {
    const executor = tx || this.db;

    const result = await executor.execute<typeof outboxEvents.$inferSelect>(sql`
      WITH picked AS (
        SELECT id
        FROM ${outboxEvents}
        WHERE status = 'PENDING'
          AND available_at <= clock_timestamp()
        ORDER BY available_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE ${outboxEvents} o
      SET status = 'PENDING',
          attempts = attempts + 1,
          available_at = clock_timestamp() + (${lockDurationSeconds} || ' seconds')::interval
      FROM picked
      WHERE o.id = picked.id
      RETURNING o.id, o.channel_account_id as "channelAccountId", o.conversation_id as "conversationId",
                o.event_type as "eventType", o.payload, o.status, o.attempts,
                o.available_at as "availableAt", o.processed_at as "processedAt",
                o.error_message as "errorMessage", o.created_at as "createdAt";
    `);

    const rows = (result as unknown as { rows?: typeof outboxEvents.$inferSelect[] }).rows || (result as unknown as typeof outboxEvents.$inferSelect[]);
    return rows || [];
  }

  /**
   * Marks a list of outbox events as PROCESSED.
   */
  async completeBatch(eventIds: string[], tx?: DatabaseOrTx): Promise<number> {
    if (eventIds.length === 0) return 0;
    const executor = tx || this.db;
    const now = new Date();

    const result = await executor
      .update(outboxEvents)
      .set({
        status: "PROCESSED",
        processedAt: now,
      })
      .where(inArray(outboxEvents.id, eventIds))
      .returning({ id: outboxEvents.id });

    return result.length;
  }

  /**
   * Marks an outbox event as FAILED or schedules retry.
   */
  async failEvent(
    eventId: string,
    errorMessage: string,
    retryDelaySeconds?: number,
    tx?: DatabaseOrTx
  ): Promise<void> {
    const executor = tx || this.db;

    if (retryDelaySeconds !== undefined) {
      await executor.execute(sql`
        UPDATE ${outboxEvents}
        SET status = 'PENDING',
            available_at = clock_timestamp() + (${retryDelaySeconds} || ' seconds')::interval,
            error_message = ${errorMessage}
        WHERE id = ${eventId};
      `);
    } else {
      await executor.execute(sql`
        UPDATE ${outboxEvents}
        SET status = 'FAILED',
            error_message = ${errorMessage}
        WHERE id = ${eventId};
      `);
    }
  }

  /**
   * Prunes old processed outbox events older than retentionDays.
   */
  async cleanProcessedEvents(retentionDays = 7, tx?: DatabaseOrTx): Promise<number> {
    const executor = tx || this.db;
    const result = await executor.execute(sql`
      DELETE FROM ${outboxEvents}
      WHERE status = 'PROCESSED'
        AND processed_at < clock_timestamp() - (${retentionDays} || ' days')::interval
      RETURNING id;
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]) || [];
    return rows.length;
  }

  /**
   * Gets outbox events created after a specific event id (cursor) or recent events.
   */
  async getEventsSince(
    channelAccountId: string,
    afterId?: string,
    limit = 50,
    tx?: DatabaseOrTx
  ): Promise<Array<typeof outboxEvents.$inferSelect>> {
    const executor = tx || this.db;
    if (afterId) {
      const result = await executor.execute<typeof outboxEvents.$inferSelect>(sql`
        SELECT * FROM ${outboxEvents}
        WHERE channel_account_id = ${channelAccountId}
          AND created_at > COALESCE((SELECT created_at FROM ${outboxEvents} WHERE id = ${afterId}), '1970-01-01'::timestamptz)
        ORDER BY created_at ASC
        LIMIT ${limit};
      `);
      const rows = (result as unknown as { rows?: typeof outboxEvents.$inferSelect[] }).rows || (result as unknown as typeof outboxEvents.$inferSelect[]);
      return rows || [];
    }

    const result = await executor.execute<typeof outboxEvents.$inferSelect>(sql`
      SELECT * FROM ${outboxEvents}
      WHERE channel_account_id = ${channelAccountId}
      ORDER BY created_at DESC
      LIMIT ${limit};
    `);
    const rows = (result as unknown as { rows?: typeof outboxEvents.$inferSelect[] }).rows || (result as unknown as typeof outboxEvents.$inferSelect[]);
    return (rows || []).slice().reverse();
  }
}
