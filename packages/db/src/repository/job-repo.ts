import { eq, and, sql, inArray } from "drizzle-orm";
import type { Database, DatabaseOrTx } from "../client.js";
import { jobs } from "../schema/index.js";
import type { JobStatus } from "@messenger/contracts";

export interface EnqueueJobOptions {
  channelAccountId: string;
  queue?: string;
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
  idempotencyKey?: string;
}

export interface ClaimJobOptions {
  queue?: string | string[];
  ownerToken: string;
  leaseDurationSeconds?: number;
}

export class JobRepository {
  constructor(private db: Database) {}

  /**
   * Atomically enqueues a job into the jobs table.
   * If idempotencyKey is provided, deduplicates on conflict.
   */
  async enqueue(options: EnqueueJobOptions, tx?: DatabaseOrTx): Promise<typeof jobs.$inferSelect> {
    const executor = tx || this.db;
    const now = options.availableAt || new Date();

    const insertValues = {
      channelAccountId: options.channelAccountId,
      queue: options.queue || "default",
      jobType: options.jobType,
      payload: options.payload || {},
      status: "READY" as JobStatus,
      priority: options.priority || 0,
      maxAttempts: options.maxAttempts ?? 3,
      availableAt: now,
      idempotencyKey: options.idempotencyKey || null,
    };

    if (options.idempotencyKey) {
      const [row] = await executor
        .insert(jobs)
        .values(insertValues)
        .onConflictDoNothing({ target: jobs.idempotencyKey })
        .returning();

      if (!row) {
        const [existing] = await executor
          .select()
          .from(jobs)
          .where(eq(jobs.idempotencyKey, options.idempotencyKey))
          .limit(1);
        if (!existing) {
          throw new Error(`Failed to find or insert job for idempotency key: ${options.idempotencyKey}`);
        }
        return existing;
      }
      return row;
    }

    const [row] = await executor.insert(jobs).values(insertValues).returning();
    if (!row) {
      throw new Error("Failed to insert job");
    }
    return row;
  }

  /**
   * Atomic claim using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Monotonically increments fencing_epoch, sets owner_token, status RUNNING and locked_until lease.
   */
  async claimNext(options: ClaimJobOptions, tx?: DatabaseOrTx): Promise<typeof jobs.$inferSelect | null> {
    const executor = tx || this.db;
    const leaseSeconds = options.leaseDurationSeconds || 60;
    const queues = Array.isArray(options.queue)
      ? options.queue
      : options.queue
        ? [options.queue]
        : [];

    const queueFilter = queues.length > 0
      ? sql`AND queue IN (${sql.join(queues.map((q) => sql`${q}`), sql`, `)})`
      : sql``;

    const result = await executor.execute<typeof jobs.$inferSelect>(sql`
      WITH picked AS (
        SELECT id
        FROM ${jobs}
        WHERE status = 'READY'
          AND available_at <= clock_timestamp()
          ${queueFilter}
        ORDER BY priority DESC, available_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${jobs} j
      SET status = 'RUNNING',
          owner_token = ${options.ownerToken},
          fencing_epoch = fencing_epoch + 1,
          locked_until = clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
          attempts = attempts + 1,
          updated_at = clock_timestamp()
      FROM picked
      WHERE j.id = picked.id
      RETURNING j.id, j.channel_account_id as "channelAccountId", j.queue, j.job_type as "jobType",
                j.payload, j.status, j.priority, j.attempts, j.max_attempts as "maxAttempts",
                j.available_at as "availableAt", j.locked_until as "lockedUntil",
                j.owner_token as "ownerToken", j.fencing_epoch as "fencingEpoch",
                j.idempotency_key as "idempotencyKey", j.last_error as "lastError",
                j.created_at as "createdAt", j.updated_at as "updatedAt";
    `);

    const rows = (result as unknown as { rows?: typeof jobs.$inferSelect[] }).rows || (result as unknown as typeof jobs.$inferSelect[]);
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * Heartbeat to renew lease. Requires CAS on owner_token + fencing_epoch.
   */
  async heartbeat(
    jobId: string,
    ownerToken: string,
    fencingEpoch: number,
    leaseDurationSeconds = 60,
    tx?: DatabaseOrTx
  ): Promise<boolean> {
    const executor = tx || this.db;
    const result = await executor.execute(sql`
      UPDATE ${jobs}
      SET locked_until = clock_timestamp() + (${leaseDurationSeconds} || ' seconds')::interval,
          updated_at = clock_timestamp()
      WHERE id = ${jobId}
        AND owner_token = ${ownerToken}
        AND fencing_epoch = ${fencingEpoch}
        AND status = 'RUNNING'
      RETURNING id;
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]);
    return Boolean(rows && rows.length > 0);
  }

  /**
   * Finalize job with success. Requires CAS on owner_token + fencing_epoch.
   */
  async complete(
    jobId: string,
    ownerToken: string,
    fencingEpoch: number,
    resultPayload?: Record<string, unknown>,
    tx?: DatabaseOrTx
  ): Promise<boolean> {
    const executor = tx || this.db;
    const payloadUpdate = resultPayload
      ? sql`, payload = payload || ${JSON.stringify(resultPayload)}::jsonb`
      : sql``;

    const result = await executor.execute(sql`
      UPDATE ${jobs}
      SET status = 'SUCCEEDED',
          locked_until = NULL,
          updated_at = clock_timestamp()
          ${payloadUpdate}
      WHERE id = ${jobId}
        AND owner_token = ${ownerToken}
        AND fencing_epoch = ${fencingEpoch}
        AND status = 'RUNNING'
      RETURNING id;
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]);
    return Boolean(rows && rows.length > 0);
  }

  /**
   * Fail job with error. If attempts < maxAttempts and retryDelaySeconds is given, resets to READY/RETRY_WAIT.
   * Otherwise sets FAILED. Requires CAS on owner_token + fencing_epoch.
   */
  async fail(
    jobId: string,
    ownerToken: string,
    fencingEpoch: number,
    errorMessage: string,
    retryDelaySeconds?: number,
    tx?: DatabaseOrTx
  ): Promise<{ status: "RETRY_WAIT" | "FAILED"; retrying: boolean } | null> {
    const executor = tx || this.db;

    const [existing] = await executor
      .select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.ownerToken, ownerToken),
          eq(jobs.fencingEpoch, fencingEpoch),
          eq(jobs.status, "RUNNING")
        )
      )
      .limit(1);

    if (!existing) return null;

    const canRetry = retryDelaySeconds !== undefined && existing.attempts < existing.maxAttempts;

    if (canRetry) {
      await executor.execute(sql`
        UPDATE ${jobs}
        SET status = 'READY',
            available_at = clock_timestamp() + (${retryDelaySeconds} || ' seconds')::interval,
            locked_until = NULL,
            owner_token = NULL,
            last_error = ${errorMessage},
            updated_at = clock_timestamp()
        WHERE id = ${jobId}
          AND owner_token = ${ownerToken}
          AND fencing_epoch = ${fencingEpoch}
          AND status = 'RUNNING';
      `);
      return { status: "RETRY_WAIT", retrying: true };
    }

    await executor.execute(sql`
      UPDATE ${jobs}
      SET status = 'FAILED',
          locked_until = NULL,
          last_error = ${errorMessage},
          updated_at = clock_timestamp()
      WHERE id = ${jobId}
        AND owner_token = ${ownerToken}
        AND fencing_epoch = ${fencingEpoch}
        AND status = 'RUNNING';
    `);
    return { status: "FAILED", retrying: false };
  }

  /**
   * Reconcile stale jobs: Finds jobs marked RUNNING whose lease expired (locked_until < clock_timestamp()).
   * Recovers eligible jobs back to READY or moves to FAILED if attempts >= max_attempts.
   */
  async reconcileStaleJobs(): Promise<{ recovered: number; failed: number }> {
    const failedResult = await this.db.execute(sql`
      UPDATE ${jobs}
      SET status = 'FAILED',
          locked_until = NULL,
          last_error = 'Lease expired and max attempts exceeded during reconcile',
          updated_at = clock_timestamp()
      WHERE status = 'RUNNING'
        AND locked_until < clock_timestamp()
        AND attempts >= max_attempts
      RETURNING id;
    `);
    const failedRows = (failedResult as unknown as { rows?: unknown[] }).rows || (failedResult as unknown as unknown[]) || [];

    const recoveredResult = await this.db.execute(sql`
      UPDATE ${jobs}
      SET status = 'READY',
          owner_token = NULL,
          locked_until = NULL,
          available_at = clock_timestamp() + interval '5 seconds',
          last_error = 'Lease expired; recovered by reconcile',
          updated_at = clock_timestamp()
      WHERE status = 'RUNNING'
        AND locked_until < clock_timestamp()
        AND attempts < max_attempts
      RETURNING id;
    `);
    const recoveredRows = (recoveredResult as unknown as { rows?: unknown[] }).rows || (recoveredResult as unknown as unknown[]) || [];

    return {
      recovered: recoveredRows.length,
      failed: failedRows.length,
    };
  }

  async getJobById(jobId: string, tx?: DatabaseOrTx): Promise<typeof jobs.$inferSelect | null> {
    const executor = tx || this.db;
    const rows = await executor.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    return rows[0] || null;
  }

  async cancelJob(jobId: string, reason?: string, tx?: DatabaseOrTx): Promise<boolean> {
    const executor = tx || this.db;
    const result = await executor
      .update(jobs)
      .set({
        status: "CANCELLED",
        lastError: reason || "Cancelled by operator/system",
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["READY", "RUNNING", "RETRY_WAIT"])))
      .returning({ id: jobs.id });

    return result.length > 0;
  }
}
