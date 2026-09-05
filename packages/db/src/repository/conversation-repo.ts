import { eq, and, desc, sql, gte, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  customers,
  conversations,
  messages,
  inboundMessages,
  participants,
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
  inboundMessageId?: string;
}

export interface InboundIngestOptions {
  debounceMs?: number;
  dedupeWindowMs?: number;
}

export class ConversationRepository {
  constructor(private db: Database) {}

  /**
   * Upserts customer (without inferring person from thread ID), creates or updates conversation,
   * inserts message and inbound_message with attribution/provenance, checks scoped duplicate index,
   * bumps inbound_version, upserts conversation queue row, atomically enqueues/updates debounce job,
   * and enqueues transactional outbox event.
   */
  async ingestInboundMessage(
    payload: InboundMessagePayload,
    options?: InboundIngestOptions
  ): Promise<InboundIngestResult> {
    const textHash = createHash("sha256").update(payload.text.trim()).digest("hex");

    return await this.db.transaction(async (tx) => {
      // 1. Primary dedupe check: stable externalMessageId remains primary
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

      // 2. Scoped duplicate query by conversation + nullable sender + text hash/time
      const senderParticipantId = payload.participantIdentity?.participantId?.trim() ?? payload.senderExternalId?.trim() ?? null;
      const dedupeWindowMs = options?.dedupeWindowMs ?? 5000;
      const windowStart = new Date(Date.now() - dedupeWindowMs);

      // Check if conversation already exists to scope duplicate check
      const existingConvRows = await tx
        .select({ id: conversations.id, inboundVersion: conversations.inboundVersion })
        .from(conversations)
        .where(
          and(
            eq(conversations.channelAccountId, payload.channelAccountId),
            eq(conversations.externalThreadId, payload.externalThreadId)
          )
        )
        .limit(1);

      if (existingConvRows.length > 0 && existingConvRows[0]) {
        const convId = existingConvRows[0].id;
        const scopedConditions = [
          eq(messages.channelAccountId, payload.channelAccountId),
          eq(messages.conversationId, convId),
          eq(messages.textHash, textHash),
          eq(messages.direction, "INBOUND"),
          gte(messages.createdAt, windowStart),
        ];

        if (senderParticipantId) {
          scopedConditions.push(eq(messages.senderParticipantId, senderParticipantId));
        }

        const recentDuplicate = await tx
          .select({ id: messages.id, conversationId: messages.conversationId, inboundVersion: messages.inboundVersion })
          .from(messages)
          .where(and(...scopedConditions))
          .limit(1);

        if (recentDuplicate.length > 0 && recentDuplicate[0]) {
          return {
            isDuplicate: true,
            conversationId: recentDuplicate[0].conversationId,
            inboundVersion: recentDuplicate[0].inboundVersion,
            messageId: recentDuplicate[0].id,
          };
        }
      } else {
        // Channel-level identical text fallback check within dedupe window
        const recentChannelIdentical = await tx
          .select({ id: messages.id, conversationId: messages.conversationId, inboundVersion: messages.inboundVersion })
          .from(messages)
          .where(
            and(
              eq(messages.channelAccountId, payload.channelAccountId),
              eq(messages.textHash, textHash),
              eq(messages.direction, "INBOUND"),
              gte(messages.createdAt, windowStart)
            )
          )
          .limit(1);

        if (recentChannelIdentical.length > 0 && recentChannelIdentical[0]) {
          return {
            isDuplicate: true,
            conversationId: recentChannelIdentical[0].conversationId,
            inboundVersion: recentChannelIdentical[0].inboundVersion,
            messageId: recentChannelIdentical[0].id,
          };
        }
      }

      const threadKind = payload.threadKind ?? "UNKNOWN";
      const isGroup = threadKind === "GROUP";
      const threadReliability = payload.threadReliability ?? "UNVERIFIED";
      const threadTitle = payload.customerName || null;

      // 3. Customer resolution: never infer person from thread ID.
      // If thread is a group, or externalCustomerId equals externalThreadId, customerId remains null.
      let customerId: string | null = null;
      const externalCustId = payload.externalCustomerId?.trim();
      const canInferPerson = !isGroup && Boolean(externalCustId) && externalCustId !== payload.externalThreadId.trim();

      if (canInferPerson && externalCustId) {
        const existingCustomer = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.channelAccountId, payload.channelAccountId),
              eq(customers.externalCustomerId, externalCustId)
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
              externalCustomerId: externalCustId,
              name: payload.customerName || null,
            })
            .returning({ id: customers.id });
          if (newCustomer) {
            customerId = newCustomer.id;
          }
        }
      }

      // Upsert participant identity if verified or provided
      if (payload.participantIdentity?.participantId) {
        const pId = payload.participantIdentity.participantId.trim();
        const pVerified = payload.participantIdentity.isVerified ?? false;
        await tx
          .insert(participants)
          .values({
            channelAccountId: payload.channelAccountId,
            participantId: pId,
            senderKind: payload.participantIdentity.senderKind ?? "UNKNOWN",
            reliability: pVerified ? "VERIFIED" : "UNVERIFIED",
            isVerified: pVerified,
            profileUrl: payload.participantIdentity.profileUrl ?? null,
            displayName: payload.participantIdentity.displayName ?? null,
            verifiedAt: pVerified ? (payload.participantIdentity.verifiedAt ?? new Date()) : null,
            metadata: payload.participantIdentity.metadata ?? {},
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [participants.channelAccountId, participants.participantId],
            set: {
              senderKind: payload.participantIdentity.senderKind ?? "UNKNOWN",
              reliability: pVerified ? "VERIFIED" : "UNVERIFIED",
              isVerified: pVerified,
              ...(payload.participantIdentity.profileUrl ? { profileUrl: payload.participantIdentity.profileUrl } : {}),
              ...(payload.participantIdentity.displayName ? { displayName: payload.participantIdentity.displayName } : {}),
              updatedAt: new Date(),
            },
          });
      }

      // 4. Upsert conversation (row-locked to serialize concurrent inbounds for the same thread)
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
        "for" in convQuery && typeof convQuery.for === "function"
          ? convQuery.for("update")
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
            ...(threadKind !== "UNKNOWN" ? { threadKind } : {}),
            ...(threadTitle ? { title: threadTitle } : {}),
            ...(threadReliability === "VERIFIED" ? { reliability: threadReliability } : {}),
            ...(customerId ? { customerId } : {}),
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
            threadKind,
            title: threadTitle,
            reliability: threadReliability,
            inboundVersion: newInboundVersion,
            lastInboundAt: payload.timestamp,
            unreadCount: 1,
          })
          .returning({ id: conversations.id });
        if (!newConv) throw new Error("Failed to create conversation");
        conversationId = newConv.id;
      }

      // 5. Insert messages with real sender attribution & timestamp provenance
      const senderKind = payload.senderKind ?? payload.participantIdentity?.senderKind ?? "UNKNOWN";
      const senderReliability = payload.senderReliability ?? (payload.participantIdentity?.isVerified ? "VERIFIED" : "UNVERIFIED");
      const eventTimestamp = payload.timestamps?.facebookEvent?.timestamp ?? null;
      const observedTimestamp = payload.timestamps?.observed?.timestamp ?? payload.timestamp;
      const timestampProvenance = payload.timestamps?.facebookEvent ? "FACEBOOK_EVENT" : (payload.timestampProvenance ?? "OBSERVED");
      const timestampPrecision = payload.timestamps?.facebookEvent?.precision ?? (payload.timestampPrecision ?? "UNKNOWN");

      const [newInbound] = await tx
        .insert(inboundMessages)
        .values({
          channelAccountId: payload.channelAccountId,
          conversationId,
          sourceMessageId: payload.externalMessageId,
          senderExternalId: payload.senderExternalId ?? senderParticipantId,
          senderParticipantId,
          senderKind,
          senderReliability,
          eventTimestamp,
          observedTimestamp,
          timestampProvenance,
          timestampPrecision,
          timestamps: payload.timestamps ? (payload.timestamps as unknown as Record<string, unknown>) : null,
          text: payload.text,
          textHash,
          inboundVersion: newInboundVersion,
          receivedAt: payload.timestamp,
          rawPayload: { ...payload },
        })
        .returning({ id: inboundMessages.id });

      const [newMsg] = await tx
        .insert(messages)
        .values({
          channelAccountId: payload.channelAccountId,
          conversationId,
          externalMessageId: payload.externalMessageId,
          direction: "INBOUND",
          actor: "SYSTEM",
          senderParticipantId,
          senderKind,
          senderReliability,
          eventTimestamp,
          observedTimestamp,
          timestampProvenance,
          timestampPrecision,
          timestamps: payload.timestamps ? (payload.timestamps as unknown as Record<string, unknown>) : null,
          text: payload.text,
          textHash,
          inboundVersion: newInboundVersion,
          timestamp: payload.timestamp,
        })
        .returning({ id: messages.id });
      if (!newMsg) throw new Error("Failed to insert message");

      // 6. Upsert conversation queue row & atomically enqueue/update debounce job (if not in manual mode)
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
              eq(jobs.queue, "debounce"),
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

      // 7. Append conversation event
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

      // 8. Atomically enqueue transactional outbox event
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
        inboundMessageId: newInbound?.id,
      };
    });
  }

  async findScopedDuplicateMessage(params: {
    channelAccountId: string;
    conversationId: string;
    senderParticipantId?: string | null;
    textHash: string;
    since: Date;
  }): Promise<{ id: string; conversationId: string; inboundVersion: number } | null> {
    const conditions = [
      eq(messages.channelAccountId, params.channelAccountId),
      eq(messages.conversationId, params.conversationId),
      eq(messages.textHash, params.textHash),
      eq(messages.direction, "INBOUND"),
      gte(messages.timestamp, params.since),
    ];

    if (params.senderParticipantId) {
      conditions.push(eq(messages.senderParticipantId, params.senderParticipantId));
    } else {
      conditions.push(isNull(messages.senderParticipantId));
    }

    const rows = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        inboundVersion: messages.inboundVersion,
      })
      .from(messages)
      .where(and(...conditions))
      .limit(1);

    return rows[0] || null;
  }

  async getConversationById(conversationId: string) {
    const rows = await this.db
      .select({
        conversation: conversations,
        customer: customers,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (rows.length === 0 || !rows[0]) return null;

    const row = rows[0];
    const isGroup = row.conversation.threadKind === "GROUP";
    const defaultName = isGroup ? "Nhóm Messenger" : "Khách hàng Messenger";

    const customer = row.customer ?? {
      id: row.conversation.customerId ?? "00000000-0000-0000-0000-000000000000",
      channelAccountId: row.conversation.channelAccountId,
      externalCustomerId: row.conversation.externalThreadId,
      name: row.conversation.title || defaultName,
      avatarUrl: null,
      notes: null,
      createdAt: row.conversation.createdAt,
      updatedAt: row.conversation.updatedAt,
    };

    return {
      conversation: row.conversation,
      customer,
    };
  }

  async getRecentMessages(conversationId: string, limit = 20) {
    return await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.timestamp))
      .limit(limit);
  }

  async updateStatus(
    conversationId: string,
    status: ConversationStatus
  ): Promise<void> {
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: new Date(),
    };
    if (status === "THINKING" || status === "CLAIMED") {
      updateData.claimedAt = new Date();
    } else if (status === "WAITING_CUSTOMER" || status === "QUEUED") {
      updateData.claimedAt = null;
      updateData.claimToken = null;
    }
    await this.db
      .update(conversations)
      .set(updateData)
      .where(eq(conversations.id, conversationId));
  }

  async updateConversationStatus(
    conversationId: string,
    status: ConversationStatus
  ): Promise<void> {
    return this.updateStatus(conversationId, status);
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
