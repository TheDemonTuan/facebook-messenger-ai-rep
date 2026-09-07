import { eq, and, or, desc, sql, gte, isNull, inArray, notInArray } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  customers,
  conversations,
  messages,
  inboundMessages,
  messageMedia,
  participants,
  conversationQueue,
  conversationEvents,
  jobs,
  outboxEvents,
  turns,
  outboundActions,
  aiRuns,
} from "../schema/index.js";
import {
  type InboundMessagePayload,
  type ConversationStatus,
  type ReplyEligibilityResult,
  type ReplyEligibilityDecisionRecord,
  type MessagePart,
  type NormalizedContent,
  type MessageEventKind,
  type ContentStatus,
  normalizeMessageContent,
  isMeaningfulContent,
} from "@messenger/contracts";
import { createHash } from "node:crypto";
import { ReplyPolicyService } from "../service/reply-policy-service.js";
import { ConversationControlService } from "../service/conversation-control-service.js";

export interface InboundIngestResult {
  isDuplicate: boolean;
  conversationId: string;
  inboundVersion: number;
  messageId: string;
  inboundMessageId?: string;
  eligibility?: ReplyEligibilityResult;
  decision?: ReplyEligibilityDecisionRecord | null;
  disposition?: "FULL_PROCESS" | "TRACK_NO_REPLY" | "DROP";
  dropped?: boolean;
  reasonCode?: string;
  isUpdate?: boolean;
  contentRevision?: number;
  eventKind?: string;
  contentStatus?: string;
  parts?: MessagePart[];
  text?: string;
}

export interface InboundIngestOptions {
  debounceMs?: number;
  dedupeWindowMs?: number;
  evaluationMode?: "LIVE" | "SHADOW";
  humanInboundResponseWaitMs?: number;
}

export class ConversationRepository {
  private replyPolicyService: ReplyPolicyService;
  private controlService: ConversationControlService;

  constructor(
    private db: Database,
    replyPolicyService?: ReplyPolicyService,
    controlService?: ConversationControlService
  ) {
    this.replyPolicyService = replyPolicyService ?? new ReplyPolicyService(db);
    this.controlService = controlService ?? new ConversationControlService(db);
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
    // Stage 0: Reject empty meaningless message
    const incomingParts = payload.parts ?? payload.content?.parts;
    if (!isMeaningfulContent({ text: payload.text, parts: incomingParts, eventKind: payload.eventKind })) {
      return {
        isDuplicate: false,
        dropped: true,
        disposition: "DROP",
        reasonCode: "EMPTY_MEANINGLESS_MESSAGE",
        conversationId: "",
        inboundVersion: 0,
        messageId: "",
      };
    }

    const textHash = createHash("sha256").update((payload.text || "").trim()).digest("hex");
    const now = payload.timestamp ?? new Date();

    // Stage 1: Pre-persist eligibility gate (if db supports select; skips in minimal transaction-only test doubles)
    let existingConvRow: {
      id: string;
      isBlocked: boolean;
      manualMode: boolean;
      replyControlMode: string;
      humanHoldUntil: Date | null;
      threadKind: string;
      reliability: string;
      inboundVersion: number;
      controlEpoch: number;
    } | null = null;
    let pre: import("../service/reply-policy-service.js").PrePersistEligibilityResult | null = null;

    if (typeof (this.db as unknown as { select?: unknown }).select === "function") {
      try {
        const rows = await this.db
          .select({
            id: conversations.id,
            isBlocked: conversations.isBlocked,
            manualMode: conversations.manualMode,
            replyControlMode: conversations.replyControlMode,
            humanHoldUntil: conversations.humanHoldUntil,
            threadKind: conversations.threadKind,
            reliability: conversations.reliability,
            inboundVersion: conversations.inboundVersion,
            controlEpoch: conversations.controlEpoch,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.channelAccountId, payload.channelAccountId),
              eq(conversations.externalThreadId, payload.externalThreadId)
            )
          )
          .limit(1);
        if (rows.length > 0 && rows[0]) {
          existingConvRow = rows[0];
        }
      } catch {
        // Mock / fallback
      }

      if (existingConvRow) {
        try {
          const normalized = await this.controlService.normalizeForInbound(existingConvRow.id, now);
          if (normalized) {
            existingConvRow.replyControlMode = normalized.mode;
            existingConvRow.humanHoldUntil = normalized.holdUntil;
            existingConvRow.controlEpoch = normalized.epoch;
            existingConvRow.manualMode = normalized.mode !== "AUTO";
          }
        } catch {
          // Mock fallback
        }
      }

      pre = await this.replyPolicyService.evaluatePrePersist({
        channelAccountId: payload.channelAccountId,
        payload,
        existingConversation: existingConvRow,
        now,
      });

      if (pre.disposition === "DROP") {
        return {
          isDuplicate: false,
          dropped: true,
          disposition: "DROP",
          reasonCode: pre.reasonCode,
          conversationId: existingConvRow?.id ?? "",
          inboundVersion: existingConvRow?.inboundVersion ?? 0,
          messageId: "",
          eligibility: pre.policyResult,
        };
      }
    }

    return await this.db.transaction(async (tx) => {
      // 1. Primary dedupe & update check: stable externalMessageId remains primary
      const existingMsg = await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          inboundVersion: messages.inboundVersion,
          contentRevision: messages.contentRevision,
          contentStatus: messages.contentStatus,
          text: messages.text,
          eventKind: messages.eventKind,
          eventTimestamp: messages.eventTimestamp,
          timestamps: messages.timestamps,
          content: messages.content,
        })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, payload.channelAccountId),
            eq(messages.externalMessageId, payload.externalMessageId)
          )
        )
        .limit(1);

      if (existingMsg.length > 0 && existingMsg[0]) {
        const existing = existingMsg[0];
        const eventKind = payload.eventKind ?? existing.eventKind ?? "MESSAGE_CREATED";

        // A. Message Unsent / Recalled
        if (eventKind === "MESSAGE_UNSENT") {
          const newRevision = (existing.contentRevision || 1) + 1;
          await tx
            .update(messages)
            .set({
              contentStatus: "UNAVAILABLE",
              eventKind: "MESSAGE_UNSENT",
              contentRevision: newRevision,
            })
            .where(eq(messages.id, existing.id));

          return {
            isDuplicate: false,
            isUpdate: true,
            conversationId: existing.conversationId,
            inboundVersion: existing.inboundVersion,
            messageId: existing.id,
            contentRevision: newRevision,
            eventKind: "MESSAGE_UNSENT",
            contentStatus: "UNAVAILABLE",
          };
        }

        // B. Message Edited
        if (eventKind === "MESSAGE_EDITED") {
          const newRevision = (existing.contentRevision || 1) + 1;
          const normalized = normalizeMessageContent(payload);
          const newText = payload.text || "";
          const newTextHash = createHash("sha256").update(newText.trim()).digest("hex");
          const newContentHash = createHash("sha256").update(JSON.stringify(normalized.parts)).digest("hex");

          await tx
            .update(messages)
            .set({
              text: newText,
              textHash: newTextHash,
              content: normalized as unknown as Record<string, unknown>,
              contentRevision: newRevision,
              contentStatus: normalized.contentStatus,
              contentHash: newContentHash,
              eventKind: "MESSAGE_EDITED",
            })
            .where(eq(messages.id, existing.id));

          return {
            isDuplicate: false,
            isUpdate: true,
            conversationId: existing.conversationId,
            inboundVersion: existing.inboundVersion,
            messageId: existing.id,
            contentRevision: newRevision,
            eventKind: "MESSAGE_EDITED",
            contentStatus: normalized.contentStatus,
            parts: normalized.parts,
            text: newText,
          };
        }

        // C. Metadata Enrichment (e.g. late event timestamp or refreshed media)
        const hasBetterTimestamp = !existing.eventTimestamp && Boolean(payload.timestamps?.facebookEvent?.timestamp || payload.eventTimestamp);
        const hasBetterStatus = existing.contentStatus === "PENDING" && payload.contentStatus && payload.contentStatus !== "PENDING";
        const hasNewParts = Array.isArray(payload.parts) && payload.parts.length > 0;

        if (hasBetterTimestamp || hasBetterStatus || hasNewParts) {
          const newRevision = (existing.contentRevision || 1) + (hasNewParts ? 1 : 0);
          const normalized = normalizeMessageContent({
            text: payload.text || existing.text,
            parts: payload.parts,
            content: payload.content,
            contentStatus: (payload.contentStatus as ContentStatus) ?? (existing.contentStatus as ContentStatus),
            contentRevision: newRevision,
          });

          const updateFields: Record<string, unknown> = {
            contentRevision: newRevision,
            contentStatus: normalized.contentStatus,
            content: normalized as unknown as Record<string, unknown>,
          };
          if (payload.timestamps?.facebookEvent?.timestamp || payload.eventTimestamp) {
            updateFields.eventTimestamp = payload.timestamps?.facebookEvent?.timestamp ?? payload.eventTimestamp;
            updateFields.timestampProvenance = "FACEBOOK_EVENT";
          }
          if (payload.timestamps) {
            updateFields.timestamps = payload.timestamps as unknown as Record<string, unknown>;
          }

          await tx.update(messages).set(updateFields).where(eq(messages.id, existing.id));

          return {
            isDuplicate: false,
            isUpdate: true,
            conversationId: existing.conversationId,
            inboundVersion: existing.inboundVersion,
            messageId: existing.id,
            contentRevision: newRevision,
            eventKind,
            contentStatus: normalized.contentStatus,
            parts: normalized.parts,
            text: existing.text,
          };
        }

        // D. Exact duplicate with no new enrichment
        return {
          isDuplicate: true,
          isUpdate: false,
          conversationId: existing.conversationId,
          inboundVersion: existing.inboundVersion,
          messageId: existing.id,
        };
      }

      // 2. Sender resolution includes payload.senderParticipantId when trusted/valid
      const externalThreadIdTrimmed = payload.externalThreadId.trim();
      const isVerifiedDirectParticipant =
        payload.threadKind === "DIRECT" &&
        payload.threadReliability === "VERIFIED" &&
        payload.participantIdentity?.isVerified === true;
      const isAllowedParticipantId = (id: string): boolean =>
        Boolean(id) && (id !== externalThreadIdTrimmed || isVerifiedDirectParticipant);

      let senderParticipantId: string | null = null;
      if (payload.participantIdentity?.participantId) {
        const cleanPId = payload.participantIdentity.participantId.trim();
        if (isAllowedParticipantId(cleanPId)) {
          senderParticipantId = cleanPId;
        }
      } else if (payload.senderParticipantId) {
        const cleanPId = payload.senderParticipantId.trim();
        if (isAllowedParticipantId(cleanPId)) {
          senderParticipantId = cleanPId;
        }
      } else if (payload.senderExternalId) {
        const cleanSenderId = payload.senderExternalId.trim();
        if (isAllowedParticipantId(cleanSenderId)) {
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
          title: conversations.title,
          replyControlMode: conversations.replyControlMode,
          controlEpoch: conversations.controlEpoch,
          humanHoldUntil: conversations.humanHoldUntil,
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

      // Scoped duplicate check for WEAK identities only (never drop distinct verified source IDs)
      const isWeakIdentity =
        payload.normalization?.identityQuality === "UNVERIFIED" ||
        payload.externalMessageId.startsWith("weak:") ||
        payload.externalMessageId.startsWith("fallback:") ||
        payload.externalMessageId.startsWith("temp:");

      const dedupeWindowMs = options?.dedupeWindowMs ?? 5000;
      const windowStart = new Date(Date.now() - dedupeWindowMs);

      if (isWeakIdentity && existingConv.length > 0 && existingConv[0]) {
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
      const existingTitle = existingConv[0]?.title?.trim() || null;
      const candidateTitle = payload.customerName?.trim() || null;
      const threadTitle = candidateTitle && (!existingTitle || candidateTitle.length >= existingTitle.length)
        ? candidateTitle
        : existingTitle;

      // 3. Customer resolution: never infer person from thread ID.
      // If thread is a group, or externalCustomerId equals externalThreadId without verified participant, customerId remains null.
      let customerId: string | null = null;
      const externalCustId = payload.externalCustomerId?.trim();
      const canInferPerson = !isGroup && Boolean(externalCustId) && (externalCustId !== externalThreadIdTrimmed || isVerifiedDirectParticipant);

      const avatarUrl =
        (payload.participantIdentity?.metadata?.avatarUrl as string | undefined) ||
        (payload as { avatarUrl?: string | null }).avatarUrl ||
        null;

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
          const updateFields: { name?: string; avatarUrl?: string; updatedAt: Date } = {
            updatedAt: new Date(),
          };
          if (payload.customerName) {
            const [currentCustomer] = await tx
              .select({ name: customers.name })
              .from(customers)
              .where(eq(customers.id, customerId))
              .limit(1);
            const currentName = currentCustomer?.name?.trim() || "";
            const candidateName = payload.customerName.trim();
            if (!currentName || candidateName.length >= currentName.length) {
              updateFields.name = candidateName;
            }
          }
          if (avatarUrl) updateFields.avatarUrl = avatarUrl;
          await tx
            .update(customers)
            .set(updateFields)
            .where(eq(customers.id, customerId));
        } else {
          const [newCustomer] = await tx
            .insert(customers)
            .values({
              channelAccountId: payload.channelAccountId,
              externalCustomerId: externalCustId,
              name: payload.customerName || null,
              avatarUrl,
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
        isAllowedParticipantId(payload.participantIdentity!.participantId.trim());

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
            avatarUrl,
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
              ...(avatarUrl ? { avatarUrl } : {}),
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

      const normalizedContent = normalizeMessageContent(payload);
      const contentHash = createHash("sha256").update(JSON.stringify(normalizedContent.parts)).digest("hex");
      const eventKind = payload.eventKind ?? "MESSAGE_CREATED";
      const contentStatus = normalizedContent.contentStatus ?? "READY";
      const contentRevision = normalizedContent.contentRevision ?? 1;
      const parserVersion = payload.parserVersion ?? (normalizedContent.normalization?.parserVersion || null);
      const contentQuality = payload.contentQuality ?? "TRUSTED";

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
          contentSchemaVersion: 2,
          content: normalizedContent as unknown as Record<string, unknown>,
          contentStatus,
          contentRevision,
          contentHash,
          eventKind,
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
          metadata: payload.senderDisplayName
            ? { senderDisplayName: payload.senderDisplayName }
            : {},
          contentSchemaVersion: 2,
          content: normalizedContent as unknown as Record<string, unknown>,
          contentStatus,
          contentRevision,
          contentHash,
          parserVersion,
          contentQuality,
          eventKind,
        })
        .returning({ id: messages.id });
      if (!newMsg) throw new Error("Failed to insert message");

      // Insert media records for ownership & ref tracking if present
      if (normalizedContent.parts && normalizedContent.parts.length > 0) {
        for (const part of normalizedContent.parts) {
          if ("media" in part && part.media) {
            try {
              await tx.insert(messageMedia).values({
                channelAccountId: payload.channelAccountId,
                conversationId,
                messageId: newMsg.id,
                mediaRefId: part.media.mediaId,
                role: part.media.role || "ATTACHMENT",
                mimeType: part.media.mimeType || null,
                byteSize: part.media.byteSize || null,
                width: part.media.width || null,
                height: part.media.height || null,
                durationMs: part.media.durationMs || null,
                sourceUrl: part.media.sourceUrl || null,
                storagePath: part.media.storagePath || null,
                status: part.media.status || "READY",
                metadata: {},
              }).onConflictDoNothing();
            } catch {
              // Ignore in mock or unique conflict
            }
          } else if (part.type === "SHARE" && part.previewMedia) {
            try {
              await tx.insert(messageMedia).values({
                channelAccountId: payload.channelAccountId,
                conversationId,
                messageId: newMsg.id,
                mediaRefId: part.previewMedia.mediaId,
                role: "SHARE_PREVIEW",
                mimeType: part.previewMedia.mimeType || null,
                status: part.previewMedia.status || "READY",
                metadata: {},
              }).onConflictDoNothing();
            } catch {
              // Ignore in mock
            }
          }
        }
      }
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

      // If in ONLY_SELECTED mode and person is not selected, do not persist unnecessary message records to keep DB light
      if (evalResult.result.reasonCode === "PERSON_NOT_SELECTED") {
        await tx.delete(messages).where(eq(messages.id, newMsg.id));
        if (existingConv.length > 0 && existingConv[0]) {
          await tx
            .update(conversations)
            .set({ unreadCount: sql`GREATEST(0, ${conversations.unreadCount} - 1)` })
            .where(eq(conversations.id, conversationId));
        } else {
          await tx
            .update(conversations)
            .set({ unreadCount: 0 })
            .where(eq(conversations.id, conversationId));
        }
      }

      const isBlocked = Boolean(existingConv[0]?.isBlocked);
      const currentMode = (existingConv[0]?.replyControlMode || existingConvRow?.replyControlMode || "AUTO") as string;
      const isHumanSession = currentMode === "HUMAN_SESSION";
      const isEligibleLive = evaluationMode === "LIVE" && evalResult.result.eligible && !isManual && !isBlocked && currentMode === "AUTO";

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
      } else if (isHumanSession && evaluationMode === "LIVE" && !isBlocked) {
        const waitMs = options?.humanInboundResponseWaitMs ?? 60_000;
        const availableAt = new Date(Date.now() + waitMs);
        await tx
          .insert(jobs)
          .values({
            channelAccountId: payload.channelAccountId,
            queue: "default",
            jobType: "human-fallback",
            priority: 0,
            status: "READY",
            availableAt,
            payload: {
              channelAccountId: payload.channelAccountId,
              conversationId,
              inboundVersion: newInboundVersion,
              controlEpoch: existingConv[0]?.controlEpoch ?? existingConvRow?.controlEpoch ?? 0,
              expectedMode: "HUMAN_SESSION",
            },
            idempotencyKey: `human-fallback:${payload.channelAccountId}:${conversationId}:${newInboundVersion}`,
          })
          .onConflictDoUpdate({
            target: jobs.idempotencyKey,
            set: {
              availableAt,
              status: "READY",
              updatedAt: new Date(),
            },
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
        disposition: pre?.disposition || "FULL_PROCESS",
        dropped: false,
        parts: normalizedContent.parts,
        contentStatus: normalizedContent.contentStatus,
        contentRevision: 1,
        eventKind,
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

  /**
   * Updates an existing message with enrichment, edit, or unsend.
   * Does NOT bump conversation inboundVersion and does NOT create a new inbound message.
   */
  async updateMessageEnrichment(params: {
    channelAccountId: string;
    externalMessageId: string;
    eventKind?: MessageEventKind;
    text?: string;
    parts?: MessagePart[];
    content?: NormalizedContent;
    contentStatus?: ContentStatus;
    contentRevision?: number;
    timestamps?: Record<string, unknown>;
    eventTimestamp?: Date | null;
  }): Promise<{
    isUpdated: boolean;
    messageId?: string;
    conversationId?: string;
    contentRevision?: number;
    eventKind?: string;
    contentStatus?: string;
    parts?: MessagePart[];
    text?: string;
  }> {
    return await this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          contentRevision: messages.contentRevision,
          contentStatus: messages.contentStatus,
          text: messages.text,
          eventKind: messages.eventKind,
          content: messages.content,
        })
        .from(messages)
        .where(
          and(
            eq(messages.channelAccountId, params.channelAccountId),
            eq(messages.externalMessageId, params.externalMessageId)
          )
        )
        .limit(1);

      if (!existingRows || existingRows.length === 0 || !existingRows[0]) {
        return { isUpdated: false };
      }

      const existing = existingRows[0];
      const newRevision = (params.contentRevision ?? existing.contentRevision) + 1;
      const eventKind = params.eventKind ?? existing.eventKind ?? "MESSAGE_CREATED";
      let contentStatus = (params.contentStatus as string) ?? existing.contentStatus ?? "READY";
      if (eventKind === "MESSAGE_UNSENT") {
        contentStatus = "UNAVAILABLE";
      }

      const newText = params.text !== undefined ? params.text : existing.text;
      const newTextHash = createHash("sha256").update(newText.trim()).digest("hex");
      const normalized = normalizeMessageContent({
        text: newText,
        parts: params.parts,
        content: params.content,
        contentStatus: contentStatus as ContentStatus,
        contentRevision: newRevision,
      });
      const newContentHash = createHash("sha256").update(JSON.stringify(normalized.parts)).digest("hex");

      const updateData: Record<string, unknown> = {
        text: newText,
        textHash: newTextHash,
        content: normalized as unknown as Record<string, unknown>,
        contentRevision: newRevision,
        contentStatus,
        contentHash: newContentHash,
        eventKind,
      };

      if (params.eventTimestamp !== undefined) {
        updateData.eventTimestamp = params.eventTimestamp;
        updateData.timestampProvenance = "FACEBOOK_EVENT";
      }
      if (params.timestamps !== undefined) {
        updateData.timestamps = params.timestamps;
      }

      await tx.update(messages).set(updateData).where(eq(messages.id, existing.id));

      return {
        isUpdated: true,
        messageId: existing.id,
        conversationId: existing.conversationId,
        contentRevision: newRevision,
        eventKind,
        contentStatus,
        parts: normalized.parts,
        text: newText,
      };
    });
  }

  async getRecentMessages(conversationId: string, limit = 20) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.timestamp), desc(messages.id))
      .limit(limit);

    return rows.map((row) => {
      let resolvedParts: MessagePart[] = [];
      const content = row.content as { parts?: MessagePart[] } | null;
      if (content && Array.isArray(content.parts) && content.parts.length > 0) {
        resolvedParts = content.parts;
      } else if (row.text && row.text.trim().length > 0) {
        resolvedParts = [{ type: "TEXT", text: row.text }];
      }

      return {
        ...row,
        parts: resolvedParts,
        contentStatus: row.contentStatus ?? "READY",
        contentRevision: row.contentRevision ?? 1,
        eventKind: row.eventKind ?? "MESSAGE_CREATED",
      };
    });
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
        humanHoldUntil: manualMode ? undefined : null,
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

  async setHumanHold(conversationId: string, holdDurationMs: number = 120_000): Promise<void> {
    await this.controlService.acquireOrRefreshSession(conversationId, { holdDurationMs });
  }

  async clearHumanHold(conversationId: string): Promise<void> {
    await this.controlService.release(conversationId);
  }

  async getConversationByThread(channelAccountId: string, threadIdOrRef: string) {
    const trimmed = threadIdOrRef.trim();
    const rows = await this.db
      .select({
        conversation: conversations,
        customer: customers,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(
        and(
          eq(conversations.channelAccountId, channelAccountId),
          or(
            eq(conversations.externalThreadId, trimmed),
            eq(conversations.externalThreadRef, trimmed),
            sql`${conversations.externalThreadRef} LIKE ${`%${trimmed}%`}`
          )
        )
      )
      .limit(1);

    if (rows.length === 0 || !rows[0]) return null;
    return rows[0];
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

  /**
   * Prunes messages older than retentionDays.
   */
  async cleanOldMessages(retentionDays = 30): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${messages}
      WHERE created_at < clock_timestamp() - (${retentionDays} || ' days')::interval
      RETURNING id;
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]) || [];
    return rows.length;
  }

  /**
   * Prunes ai_runs older than retentionDays.
   */
  async cleanOldAiRuns(retentionDays = 30): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${aiRuns}
      WHERE created_at < clock_timestamp() - (${retentionDays} || ' days')::interval
      RETURNING id;
    `);
    const rows = (result as unknown as { rows?: unknown[] }).rows || (result as unknown as unknown[]) || [];
    return rows.length;
  }
}
