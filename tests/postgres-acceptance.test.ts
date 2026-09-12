import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, getDb, getSql, JobRepository, jobs, conversations, outboundActions, OutboundRepository } from "../packages/db/src/index.js";
import { eq } from "drizzle-orm";

const accountId = process.env.DEFAULT_CHANNEL_ACCOUNT_ID || "personal-messenger";

let hasDb = false;

beforeAll(async () => {
  try {
    await getSql().unsafe("SELECT 1");
    hasDb = true;
  } catch {
    hasDb = false;
  }
});

afterAll(async () => {
  if (hasDb) {
    try {
      await closeDb();
    } catch {
      // ignore
    }
  }
});

describe("PostgreSQL production acceptance", () => {
  it("allows exactly one winner across 100 concurrent claims", async (ctx) => {
    if (!hasDb) return ctx.skip();
    const db = getDb();
    const repo = new JobRepository(db);
    const key = `acceptance-claim-${randomUUID()}`;
    const queued = await repo.enqueue({
      channelAccountId: accountId,
      queue: "acceptance",
      jobType: "RACE",
      idempotencyKey: key,
      maxAttempts: 3,
    });

    const claims = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        new JobRepository(db).claimNext({
          queue: "acceptance",
          ownerToken: `worker-${index}`,
          leaseDurationSeconds: 30,
        })
      )
    );
    const winners = claims.filter((claim) => claim?.id === queued.id);

    expect(winners).toHaveLength(1);
    expect(winners[0]?.fencingEpoch).toBeGreaterThan(0);
  });

  it("rejects stale heartbeat, completion, and failure after a new fence owns the job", async (ctx) => {
    if (!hasDb) return ctx.skip();
    const db = getDb();
    const repo = new JobRepository(db);
    const queued = await repo.enqueue({
      channelAccountId: accountId,
      queue: "acceptance-fence",
      jobType: "FENCE",
      idempotencyKey: `acceptance-fence-${randomUUID()}`,
      maxAttempts: 5,
    });
    const first = await repo.claimNext({ queue: "acceptance-fence", ownerToken: "old-owner", leaseDurationSeconds: 30 });
    expect(first?.id).toBe(queued.id);

    await db
      .update(jobs)
      .set({
        status: "READY",
        ownerToken: null,
        lockedUntil: null,
        availableAt: new Date(0),
      })
      .where(eq(jobs.id, queued.id));

    const second = await repo.claimNext({ queue: "acceptance-fence", ownerToken: "new-owner", leaseDurationSeconds: 30 });
    expect(second?.id).toBe(queued.id);
    expect(second!.fencingEpoch).toBeGreaterThan(first!.fencingEpoch);

    await expect(repo.heartbeat(queued.id, "old-owner", first!.fencingEpoch, 30)).resolves.toBe(false);
    await expect(repo.complete(queued.id, "old-owner", first!.fencingEpoch)).resolves.toBe(false);
    await expect(repo.fail(queued.id, "old-owner", first!.fencingEpoch, "stale failure")).resolves.toBeNull();
    await expect(repo.complete(queued.id, "new-owner", second!.fencingEpoch)).resolves.toBe(true);
  });

  it("deduplicates concurrent enqueue by idempotency key", async (ctx) => {
    if (!hasDb) return ctx.skip();
    const db = getDb();
    const key = `acceptance-idempotency-${randomUUID()}`;
    const rows = await Promise.all(
      Array.from({ length: 50 }, () =>
        new JobRepository(db).enqueue({
          channelAccountId: accountId,
          queue: "acceptance-idempotency",
          jobType: "IDEMPOTENT",
          idempotencyKey: key,
        })
      )
    );

    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([rows[0]!.id]));
    const persisted = await db.select().from(jobs).where(eq(jobs.idempotencyKey, key));
    expect(persisted).toHaveLength(1);
  });

  it("SEND_INTENT -> customer inbound -> action remains SEND_INTENT and confirms cleanly", async (ctx) => {
    if (!hasDb) return ctx.skip();
    const db = getDb();
    const outboundRepo = new OutboundRepository(db);

    const convId = `conv-pg-race-${randomUUID()}`;
    const threadId = `thread-pg-race-${randomUUID()}`;
    const actionId = `act-pg-race-${randomUUID()}`;

    // 1. Create conversation with inboundVersion = 1
    await db.insert(conversations).values({
      id: convId,
      channelAccountId: accountId,
      externalThreadId: threadId,
      inboundVersion: 1,
      replyControlMode: "AUTO",
      manualMode: false,
    });

    // 2. Insert action that has reached SEND_INTENT (Enter pressed)
    await db.insert(outboundActions).values({
      id: randomUUID(),
      channelAccountId: accountId,
      conversationId: convId,
      actionId,
      inboundVersion: 1,
      responseIndex: 0,
      text: "Xin chào quý khách",
      textHash: "hash123",
      actor: "AI",
      status: "SEND_INTENT",
    });

    // 3. Customer replies quickly -> inboundVersion advances to 2, abortStaleActions called
    await outboundRepo.abortStaleActions(convId, 2);

    // 4. Invariant assertion: SEND_INTENT must NOT be cancelled!
    const [freshAction] = await db
      .select({ status: outboundActions.status })
      .from(outboundActions)
      .where(eq(outboundActions.actionId, actionId));

    expect(freshAction?.status).toBe("SEND_INTENT");

    // 5. Delivery verification succeeds -> confirmSent updates to CONFIRMED
    const confirmed = await outboundRepo.confirmSent(actionId, `msg-ref-${actionId}`);
    expect(confirmed.status).toBe("CONFIRMED");

    // 6. Resurrect prevention: if action were CANCELLED, confirmSent must reject
    const cancelledActionId = `act-pg-canc-${randomUUID()}`;
    await db.insert(outboundActions).values({
      id: randomUUID(),
      channelAccountId: accountId,
      conversationId: convId,
      actionId: cancelledActionId,
      inboundVersion: 1,
      responseIndex: 0,
      text: "Tin nhắn bị hủy",
      textHash: "hash456",
      actor: "AI",
      status: "CANCELLED",
    });

    await expect(
      outboundRepo.confirmSent(cancelledActionId, `msg-ref-resurrect`)
    ).rejects.toThrow(/Cannot confirm action/);

    const [stillCancelled] = await db
      .select({ status: outboundActions.status })
      .from(outboundActions)
      .where(eq(outboundActions.actionId, cancelledActionId));
    expect(stillCancelled?.status).toBe("CANCELLED");
  });
});
