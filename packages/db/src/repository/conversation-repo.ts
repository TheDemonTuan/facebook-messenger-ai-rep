import { eq, and, desc, sql, gte, isNull, inArray, notInArray } from "drizzle-orm";
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
  turns,
  outboundActions,
} from "../schema/index.js";
import type {
  InboundMessagePayload,
  ConversationStatus,
  ReplyEligibilityResult,
  ReplyEligibilityDecisionRecord,
} from "@messenger/contracts";
import { createHash } from "node:crypto";
import { ReplyPolicyService } from "../service/reply-policy-service.js";

export interface InboundIngestResult {
  isDuplicate: boolean;
  conversationId: string;
  inboundVersion: number;
  messageId: string;
  inboundMessageId?: string;
  eligibility?: ReplyEligibilityResult;
  decision?: ReplyEligibilityDecisionRecord | null;
}

export interface InboundIngestOptions {
  debounceMs?: number;
  dedupeWindowMs?: number;
  evaluationMode?: "LIVE" | "SHADOW";
}

export class ConversationRepository {
  private replyPolicyService: ReplyPolicyService;

  constructor(private db: Database, replyPolicyService?: ReplyPolicyService) {
    this.replyPolicyService = replyPolicyService ?? new ReplyPolicyService(db);
  }

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

      // 2. Sender resolution includes payload.senderParticipantId when trusted/valid
      const externalThreadIdTrimmed = payload.externalThreadId.trim();
      let senderParticipantId: string | null = null;
      if (payload.participantIdentity?.participantId) {
        const cleanPId = payload.participantIdentity.participantId.trim();
        if (cleanPId && cleanPId !== externalThreadIdTrimmed) {
          senderParticipantId = cleanPId;
        }
      } else if (payload.senderParticipantId) {
        const cleanPId = payload.senderParticipantId.trim();
        if (cleanPId && cleanPId !== externalThreadIdTrimmed) {
          senderParticipantId = cleanPId;
        }
      } else if (payload.senderExternalId) {
        const cleanSenderId = payload.senderExternalId.trim();
        if (cleanSenderId && cleanSenderId !== externalThreadIdTrimmed) {
          senderParticipantId = cleanSenderId;
        }
      }

      // Advisory transaction lock serialized on thread hash for new threads before conversation exists
      try {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${payload.channelAccountId || ""}), hashtext(${payload.externalThreadId || ""}))`
        );
      } catch {
        // Fallback if DB mock does not support advisory lock
      }

      // Acquire conversation row lock before scoped jitter dedupe to serialize concurrent identical inbound
      const convQuery = tx
        .select({
          id: conversations.id,
          inboundVersion: conversations.inboundVersion,
          manualMode: conversations.manualMode,
          status: conversations.status,
          isBlocked: conversations.isBlocked,
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

      // Scoped duplicate check executed under conversation lock
      const dedupeWindowMs = options?.dedupeWindowMs ?? 5000;
      const windowStart = new Date(Date.now() - dedupeWindowMs);

      if (existingConv.length > 0 && existingConv[0]) {
        const convId = existingConv[0].id;
        const scopedConditions = [
          eq(messages.channelAccountId, payload.channelAccountId),
          eq(messages.conversationId, convId),
          eq(messages.textHash, textHash),
          eq(messages.direction, "INBOUND"),
          gte(messages.timestamp, windowStart),
        ];

        if (senderParticipantId) {
          scopedConditions.push(eq(messages.senderParticipantId, senderParticipantId));
        } else {
          scopedConditions.push(isNull(messages.senderParticipantId));
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
      }

      const threadKind = payload.threadKind ?? "UNKNOWN";
      const isGroup = threadKind === "GROUP";
      const threadReliability = payload.threadReliability ?? "UNVERIFIED";
      const threadTitle = payload.customerName || null;

      // 3. Customer resolution: never infer person from thread ID.
      // If thread is a group, or externalCustomerId equals externalThreadId, customerId remains null.
      let customerId: string | null = null;
      const externalCustId = payload.externalCustomerId?.trim();
      const canInferPerson = !isGroup && Boolean(externalCustId) && externalCustId !== externalThreadIdTrimmed;

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

      // Reconcile ONLY VERIFIED participant evidence (never use externalThreadId as participant)
      const isVerifiedEvidence =
        Boolean(payload.participantIdentity?.isVerified) &&
        Boolean(payload.participantIdentity?.participantId) &&
        payload.participantIdentity!.participantId.trim() !== externalThreadIdTrimmed;

      if (isVerifiedEvidence && payload.participantIdentity) {
        const pId = payload.participantIdentity.participantId.trim();
        const pKind = payload.participantIdentity.senderKind ?? "UNKNOWN";
        const now = new Date();
        await tx
          .insert(participants)
          .values({
            channelAccountId: payload.channelAccountId,
            participantId: pId,
            senderKind: pKind,
            reliability: "VERIFIED",
            isVerified: true,
            profileUrl: payload.participantIdentity.profileUrl ?? null,
            displayName: payload.participantIdentity.displayName ?? null,
            verifiedAt: payload.participantIdentity.verifiedAt ?? now,
            metadata: payload.participantIdentity.metadata ?? {},
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [participants.channelAccountId, participants.participantId],
            set: {
              senderKind: pKind,
              reliability: "VERIFIED",
              isVerified: true,
              ...(payload.participantIdentity.profileUrl ? { profileUrl: payload.participantIdentity.profileUrl } : {}),
              ...(payload.participantIdentity.displayName ? { displayName: payload.participantIdentity.displayName } : {}),
              verifiedAt: payload.participantIdentity.verifiedAt ?? now,
              updatedAt: now,
            },
          });
      }

      let conversationId: string;
      let newInboundVersion: number;
      let isManual: boolean;

      if (existingConv.length > 0 && existingConv[0]) {
        conversationId = existingConv[0].id;
        newInboundVersion = existingConv[0].inboundVersion + 1;
        isManual = existingConv[0].manualMode;

        // Preserve current conversation status before eligibility check (never set DEBOUNCING prematurely)
        const initialStatus: ConversationStatus = isManual
          ? "MANUAL"
          : (existingConv[0].isBlocked ? "BLOCKED" : (existingConv[0].status as ConversationStatus));

        await tx
          .update(conversations)
          .set({
            inboundVersion: newInboundVersion,
            lastInboundAt: payload.timestamp,
            status: initialStatus,
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
            status: "WAITING_CUSTOMER",
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

      // 6. Abort/cancel stale queued/typing/sending work
      // Cancel older debounce jobs for this conversation
      await tx
        .update(jobs)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(jobs.channelAccountId, payload.channelAccountId),
            eq(jobs.queue, "debounce"),
            inArray(jobs.status, ["READY", "RUNNING", "RETRY_WAIT"]),
            sql`payload->>'conversationId' = ${conversationId}`
          )
        );

      // Cancel older AI jobs for this conversation
      await tx
        .update(jobs)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(jobs.channelAccountId, payload.channelAccountId),
            eq(jobs.queue, "ai"),
            inArray(jobs.status, ["READY", "RUNNING", "RETRY_WAIT"]),
            sql`payload->>'conversationId' = ${conversationId}`
          )
        );

      // Cancel older browser send jobs for this conversation
      await tx
        .update(jobs)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(jobs.channelAccountId, payload.channelAccountId),
            eq(jobs.queue, "browser"),
            inArray(jobs.status, ["READY", "RETRY_WAIT"]),
            sql`payload->>'conversationId' = ${conversationId}`
          )
        );

      // Cancel active turns in turns table
      await tx
        .update(turns)
        .set({
          status: "CANCELLED",
          errorMessage: `Superseded by newer inbound version (${newInboundVersion})`,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(turns.channelAccountId, payload.channelAccountId),
            eq(turns.conversationId, conversationId),
            inArray(turns.status, ["PENDING", "THINKING", "DRAFT_READY"])
          )
        );

      // Abort stale outbound actions for this conversation
      await tx
        .update(outboundActions)
        .set({
          status: "CANCELLED",
          errorMessage: `Cancelled due to new inbound version (${newInboundVersion})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(outboundActions.conversationId, conversationId),
            sql`${outboundActions.inboundVersion} < ${newInboundVersion}`,
            notInArray(outboundActions.status, ["CONFIRMED", "CANCELLED", "FAILED", "SENT", "ABORTED"])
          )
        );

      // Delete active conversation queue entry if present
      if (typeof tx.delete === "function") {
        await tx
          .delete(conversationQueue)
          .where(eq(conversationQueue.conversationId, conversationId));
      }

      // 7. Evaluate shared reply eligibility synchronously and persist decision
      const evaluationMode = options?.evaluationMode ?? "LIVE";
      const evalResult = await this.replyPolicyService.evaluateInbound({
        channelAccountId: payload.channelAccountId,
        conversationId,
        inboundMessageId: newInbound?.id ?? "generated-id",
        payload,
        evaluationMode,
        tx,
      });

      const isBlocked = Boolean(existingConv[0]?.isBlocked);
      const isEligibleLive = evaluationMode === "LIVE" && evalResult.result.eligible && !isManual && !isBlocked;

      if (isEligibleLive) {
        const debounceMs = options?.debounceMs ?? 3000;
        const availableAt = new Date(Date.now() + debounceMs);

        await tx
          .update(conversations)
          .set({ status: "DEBOUNCING", updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));

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
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            },
          });

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

        // Record transactional audit event for debounce started
        await tx.insert(conversationEvents).values({
          channelAccountId: payload.channelAccountId,
          conversationId,
          type: "DEBOUNCE_STARTED",
          inboundVersion: newInboundVersion,
          actor: "BROWSER_AGENT",
          payload: { debounceMs },
        });
      } else {
        const nextStatus: ConversationStatus = isManual
          ? "MANUAL"
          : (isBlocked ? "BLOCKED" : "WAITING_CUSTOMER");
        await tx
          .update(conversations)
          .set({ status: nextStatus, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
      }

      // 8. Append conversation event
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

      // 9. Atomically enqueue transactional outbox event
      await tx.insert(outboxEvents).values({
        channelAccountId: payload.channelAccountId,
        conversationId,
        eventType: "inbound:received",
        payload: {
          conversationId,
          inboundVersion: newInboundVersion,
          text: payload.text,
          externalMessageId: payload.externalMessageId,
          eligible: evalResult.result.eligible,
          decision: evalResult.result.decision,
          reasonCode: evalResult.result.reasonCode,
          evaluationMode: evalResult.record.evaluationMode,
        },
      });

      return {
        isDuplicate: false,
        conversationId,
        inboundVersion: newInboundVersion,
        messageId: newMsg.id,
        inboundMessageId: newInbound?.id,
        eligibility: evalResult.result,
        decision: evalResult.record,
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
