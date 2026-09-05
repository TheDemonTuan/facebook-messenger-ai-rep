import { eq, and, desc, sql, gte } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  customers,
  conversations,
  messages,
  conversationQueue,
  conversationEvents,
  jobs,
  outboxEvents,
} from "../schema/index.js";
import type { InboundMessagePayload, ConversationStatus } from "@messenger/contracts";
import { createHash } from "node:crypto";

export interface InboundIngestResult {
  isDuplicate: boolean;
  conversationId: string;
  inboundVersion: number;
  messageId: string;
}

export interface InboundIngestOptions {
  debounceMs?: number;
}

export class ConversationRepository {
  constructor(private db: Database) {}

  /**
   * Upserts customer, creates or updates conversation, inserts message with dedupe,
   * bumps inbound_version, upserts conversation queue row, atomically enqueues/updates debounce job,
   * and enqueues transactional outbox event.
   */
  async ingestInboundMessage(
    payload: InboundMessagePayload,
    options?: InboundIngestOptions
  ): Promise<InboundIngestResult> {
    const textHash = createHash("sha256").update(payload.text.trim()).digest("hex");

    return await this.db.transaction(async (tx) => {
      // 1. Dedupe check: check if externalMessageId already exists
      const existingMsg = await tx
        .select({ id: messages.id, conversationId: messages.conversationId, inboundVersion: messages.inboundVersion })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, payload.channelAccountId),
            eq(messages.externalMessageId, payload.externalMessageId)
          )
        )
        .limit(1);

      if (existingMsg.length > 0 && existingMsg[0]) {
        return {
          isDuplicate: true,
          conversationId: existingMsg[0].conversationId,
          inboundVersion: existingMsg[0].inboundVersion,
          messageId: existingMsg[0].id,
        };
      }

      // Also prevent rapid double-ingest jitter (identical text in the same channel within last 5 seconds)
      const fiveSecondsAgo = new Date(Date.now() - 5000);
      const recentIdentical = await tx
        .select({ id: messages.id, conversationId: messages.conversationId, inboundVersion: messages.inboundVersion })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, payload.channelAccountId),
            eq(messages.textHash, textHash),
            eq(messages.direction, "INBOUND"),
            gte(messages.createdAt, fiveSecondsAgo)
          )
        )
        .limit(1);

      if (recentIdentical.length > 0 && recentIdentical[0]) {
        return {
          isDuplicate: true,
          conversationId: recentIdentical[0].conversationId,
          inboundVersion: recentIdentical[0].inboundVersion,
          messageId: recentIdentical[0].id,
        };
      }

      // 2. Ensure customer exists
      let customerId: string;
      const existingCustomer = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.channelAccountId, payload.channelAccountId),
            eq(customers.externalCustomerId, payload.externalCustomerId)
          )
        )
        .limit(1);

      if (existingCustomer.length > 0 && existingCustomer[0]) {
        customerId = existingCustomer[0].id;
        if (payload.customerName) {
          await tx
            .update(customers)
            .set({ name: payload.customerName, updatedAt: new Date() })
            .where(eq(customers.id, customerId));
        }
      } else {
        const [newCustomer] = await tx
          .insert(customers)
          .values({
            channelAccountId: payload.channelAccountId,
            externalCustomerId: payload.externalCustomerId,
            name: payload.customerName || null,
          })
          .returning({ id: customers.id });
        if (!newCustomer) throw new Error("Failed to insert customer");
        customerId = newCustomer.id;
      }

      // 3. Upsert conversation (row-locked to serialize concurrent inbounds for the same thread)
      const convQuery = tx
        .select({
          id: conversations.id,
          inboundVersion: conversations.inboundVersion,
          manualMode: conversations.manualMode,
          status: conversations.status,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelAccountId, payload.channelAccountId),
            eq(conversations.externalThreadId, payload.externalThreadId)
          )
        );

      const lockedConvQuery =
        typeof (convQuery as any).for === "function"
          ? (convQuery as any).for("update")
          : convQuery;

      const existingConv = await lockedConvQuery.limit(1);

      let conversationId: string;
      let newInboundVersion: number;
      let isManual: boolean;

      if (existingConv.length > 0 && existingConv[0]) {
        conversationId = existingConv[0].id;
        newInboundVersion = existingConv[0].inboundVersion + 1;
        isManual = existingConv[0].manualMode;

        const nextStatus: ConversationStatus = isManual ? "MANUAL" : "DEBOUNCING";

        await tx
          .update(conversations)
          .set({
            inboundVersion: newInboundVersion,
            lastInboundAt: payload.timestamp,
            status: nextStatus,
            unreadCount: sql`${conversations.unreadCount} + 1`,
            externalThreadRef: payload.externalThreadRef,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId));
      } else {
        newInboundVersion = 1;
        isManual = false;
        const [newConv] = await tx
          .insert(conversations)
          .values({
            channelAccountId: payload.channelAccountId,
            customerId,
            externalThreadId: payload.externalThreadId,
            externalThreadRef: payload.externalThreadRef,
            status: "DEBOUNCING",
            inboundVersion: newInboundVersion,
            lastInboundAt: payload.timestamp,
            unreadCount: 1,
          })
          .returning({ id: conversations.id });
        if (!newConv) throw new Error("Failed to create conversation");
        conversationId = newConv.id;
      }

      // 4. Insert message
      const [newMsg] = await tx
        .insert(messages)
        .values({
          channelAccountId: payload.channelAccountId,
          conversationId,
          externalMessageId: payload.externalMessageId,
          direction: "INBOUND",
          actor: "SYSTEM",
          text: payload.text,
          textHash,
          inboundVersion: newInboundVersion,
          timestamp: payload.timestamp,
        })
        .returning({ id: messages.id });
      if (!newMsg) throw new Error("Failed to insert message");

      // 5. Upsert conversation queue row & atomically enqueue/update debounce job (if not in manual mode)
      if (!isManual) {
        const debounceMs = options?.debounceMs ?? 3000;
        const availableAt = new Date(Date.now() + debounceMs);

        await tx
          .insert(conversationQueue)
          .values({
            channelAccountId: payload.channelAccountId,
            conversationId,
            inboundVersion: newInboundVersion,
            queuedAt: new Date(),
            readyAt: availableAt,
          })
          .onConflictDoUpdate({
            target: conversationQueue.conversationId,
            set: {
              inboundVersion: newInboundVersion,
              readyAt: availableAt, // Reset debounce timer on new message
              updatedAt: new Date(),
            },
          });

        // Cancel any older READY debounce jobs for this conversation
        await tx
          .update(jobs)
          .set({ status: "CANCELLED", updatedAt: new Date() })
          .where(
            and(
              eq(jobs.channelAccountId, payload.channelAccountId),
              eq(jobs.jobType, "debounce"),
              eq(jobs.status, "READY"),
              sql`payload->>'conversationId' = ${conversationId}`
            )
          );

        // Atomically enqueue/update debounce job in PostgreSQL jobs table with explicit debounce queue
        await tx
          .insert(jobs)
          .values({
            channelAccountId: payload.channelAccountId,
            queue: "debounce",
            jobType: "debounce",
            priority: 0,
            status: "READY",
            availableAt,
            payload: {
              channelAccountId: payload.channelAccountId,
              conversationId,
              inboundVersion: newInboundVersion,
            },
            idempotencyKey: `debounce:${payload.channelAccountId}:${conversationId}:${newInboundVersion}`,
          })
          .onConflictDoUpdate({
            target: jobs.idempotencyKey,
            set: {
              availableAt,
              payload: {
                channelAccountId: payload.channelAccountId,
                conversationId,
                inboundVersion: newInboundVersion,
              },
              status: "READY",
              updatedAt: new Date(),
            },
          });
      }

      // 6. Append conversation event
      await tx.insert(conversationEvents).values({
        channelAccountId: payload.channelAccountId,
        conversationId,
        type: "INBOUND_RECEIVED",
        inboundVersion: newInboundVersion,
        actor: "CUSTOMER",
        payload: {
          externalMessageId: payload.externalMessageId,
          textLength: payload.text.length,
          timestamp: payload.timestamp,
        },
      });

      // 7. Atomically enqueue transactional outbox event
      await tx.insert(outboxEvents).values({
        channelAccountId: payload.channelAccountId,
        conversationId,
        eventType: "inbound:received",
        payload: {
          conversationId,
          inboundVersion: newInboundVersion,
          text: payload.text,
          externalMessageId: payload.externalMessageId,
        },
      });

      return {
        isDuplicate: false,
        conversationId,
        inboundVersion: newInboundVersion,
        messageId: newMsg.id,
      };
    });
  }

  async getConversationById(conversationId: string) {
    const rows = await this.db
      .select({
        conversation: conversations,
        customer: customers,
      })
      .from(conversations)
      .innerJoin(customers, eq(conversations.customerId, customers.id))
      .where(eq(conversations.id, conversationId))
      .limit(1);

    return rows[0] || null;
  }

  async getRecentMessages(conversationId: string, limit = 20) {
    return await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.timestamp))
      .limit(limit);
  }

  async updateStatus(conversationId: string, status: ConversationStatus): Promise<void> {
    await this.db
      .update(conversations)
      .set({ status, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }

  async setManualMode(conversationId: string, manualMode: boolean): Promise<void> {
    const status: ConversationStatus = manualMode ? "MANUAL" : "WAITING_CUSTOMER";
    await this.db
      .update(conversations)
      .set({
        manualMode,
        status,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    if (manualMode) {
      // Remove from active queue if present
      await this.db
        .delete(conversationQueue)
        .where(eq(conversationQueue.conversationId, conversationId));
    }
  }

  async updateSummary(conversationId: string, summary: string, expectedVersion: number): Promise<boolean> {
    const res = await this.db
      .update(conversations)
      .set({
        summary,
        summaryVersion: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.summaryVersion, expectedVersion)
        )
      );
    return res.length > 0;
  }
}
