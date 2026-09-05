import type { JobExecutionContext } from "@messenger/db";
import type { OutboxRepository } from "@messenger/db";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";

export interface OutboxHandlerDeps {
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
}

export function createOutboxHandler(deps: OutboxHandlerDeps) {
  const { outboxRepo, broadcaster } = deps;

  return async function handleOutbox(_context?: JobExecutionContext): Promise<Record<string, unknown>> {
    // 1. Claim a batch of ready pending events
    const events = await outboxRepo.claimBatch(50, 30);

    if (events.length === 0) {
      return { processed: 0 };
    }

    const processedIds: string[] = [];

    for (const ev of events) {
      try {
        await broadcaster.broadcast(ev.eventType, ev.payload, ev.id);
        processedIds.push(ev.id);
      } catch (err) {
        console.error(`[OutboxHandler] Failed to dispatch outbox event ${ev.id}:`, err);
        await outboxRepo.failEvent(ev.id, (err as Error).message, 10);
      }
    }

    if (processedIds.length > 0) {
      await outboxRepo.completeBatch(processedIds);
    }

    return { processed: processedIds.length, totalClaimed: events.length };
  };
}
