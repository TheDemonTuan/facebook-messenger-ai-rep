import type { Database, SettingsRepository } from "@messenger/db";
import {
  conversations,
  customers,
  inboundMessages,
  participants,
  replyPolicyMembers,
  resolveParticipantId,
} from "@messenger/db";
import {
  eq,
  and,
  or,
  inArray,
  notInArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";

export interface PolicyAudienceFilterResult {
  isPolicyEmpty: boolean;
  conditions: SQL[];
}

export function extractParticipantIds(
  list: (string | null | undefined)[],
  channelAccountId: string
): string[] {
  const ids = new Set<string>();
  for (const item of list) {
    if (!item) continue;
    const clean = item.trim();
    if (!clean) continue;
    ids.add(clean);
    if (clean.includes(":")) {
      const [chan, ...rest] = clean.split(":");
      const raw = rest.join(":");
      if (chan === channelAccountId && raw) {
        ids.add(raw.trim());
      }
    } else {
      ids.add(`${channelAccountId}:${clean}`);
    }
    if (clean.startsWith("ppl_")) {
      const resolved = resolveParticipantId(clean, channelAccountId);
      if (resolved) {
        ids.add(resolved);
        ids.add(`${channelAccountId}:${resolved}`);
      }
    }
  }
  return Array.from(ids);
}

export async function getPolicyAudienceConditions(
  db: Database,
  settingsRepo: SettingsRepository,
  channelAccountId: string
): Promise<PolicyAudienceFilterResult> {
  const settingsData = await settingsRepo.getSettings(channelAccountId);
  const s = settingsData?.settings;

  const conditions: SQL[] = [eq(conversations.channelAccountId, channelAccountId)];

  if (!s) {
    return { isPolicyEmpty: false, conditions };
  }

  // 1. Source Controls: Thread Kinds (Direct vs Group)
  const directRepliesEnabled = s.directRepliesEnabled !== false;
  const groupRepliesEnabled = s.groupRepliesEnabled === true;

  const allowedThreadKinds: string[] = [];
  if (directRepliesEnabled) {
    allowedThreadKinds.push("DIRECT");
  }
  if (groupRepliesEnabled) {
    allowedThreadKinds.push("GROUP");
  }

  if (allowedThreadKinds.length === 0) {
    return { isPolicyEmpty: true, conditions: [] };
  }

  // Strict allowed thread kinds: UNKNOWN fails closed, no fallback to DIRECT
  conditions.push(inArray(conversations.threadKind, allowedThreadKinds));

  // 2. Page & Non-Person Sender Controls
  const pageRepliesEnabled = s.pageRepliesEnabled === true;
  const nonPersonRepliesEnabled = s.nonPersonRepliesEnabled === true;

  if (!pageRepliesEnabled) {
    conditions.push(
      sql`${conversations.id} NOT IN (
        SELECT ${inboundMessages.conversationId}
        FROM ${inboundMessages}
        WHERE ${eq(inboundMessages.channelAccountId, channelAccountId)}
          AND ${eq(inboundMessages.senderKind, "PAGE")}
      )`
    );
    conditions.push(
      or(
        isNull(customers.externalCustomerId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${participants}
          WHERE ${eq(participants.channelAccountId, channelAccountId)}
            AND ${eq(participants.participantId, customers.externalCustomerId)}
            AND ${eq(participants.senderKind, "PAGE")}
        )`
      )!
    );
  }

  if (!nonPersonRepliesEnabled) {
    conditions.push(
      sql`${conversations.id} NOT IN (
        SELECT ${inboundMessages.conversationId}
        FROM ${inboundMessages}
        WHERE ${eq(inboundMessages.channelAccountId, channelAccountId)}
          AND ${eq(inboundMessages.senderKind, "NON_PERSON")}
      )`
    );
    conditions.push(
      or(
        isNull(customers.externalCustomerId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${participants}
          WHERE ${eq(participants.channelAccountId, channelAccountId)}
            AND ${eq(participants.participantId, customers.externalCustomerId)}
            AND ${eq(participants.senderKind, "NON_PERSON")}
        )`
      )!
    );
  }

  // 3. Person List Mode: ONLY_SELECTED vs EVERYONE_EXCEPT
  if (s.replyMode === "ONLY_SELECTED") {
    const policyRows = await db
      .select({ participantId: replyPolicyMembers.participantId })
      .from(replyPolicyMembers)
      .where(
        and(
          eq(replyPolicyMembers.channelAccountId, channelAccountId),
          eq(replyPolicyMembers.policyMode, "INCLUDE")
        )
      );

    const effectiveSelectedIds = extractParticipantIds(
      [
        ...(s.selectedParticipantIds || []),
        ...policyRows.map((r) => r.participantId),
      ],
      channelAccountId
    );

    if (effectiveSelectedIds.length === 0) {
      return { isPolicyEmpty: true, conditions: [] };
    }

    // Match verified participant identity:
    // (a) Direct conversation with verified customer/participant
    // (b) Or conversation with verified inbound message sender
    // NEVER match externalThreadId as a person!
    conditions.push(
      or(
        and(
          eq(conversations.threadKind, "DIRECT"),
          inArray(customers.externalCustomerId, effectiveSelectedIds),
          or(
            eq(conversations.reliability, "VERIFIED"),
            sql`EXISTS (
              SELECT 1 FROM ${participants}
              WHERE ${eq(participants.channelAccountId, channelAccountId)}
                AND ${eq(participants.participantId, customers.externalCustomerId)}
                AND (${eq(participants.isVerified, true)} OR ${eq(participants.reliability, "VERIFIED")})
            )`,
            sql`EXISTS (
              SELECT 1 FROM ${inboundMessages}
              WHERE ${eq(inboundMessages.conversationId, conversations.id)}
                AND ${eq(inboundMessages.senderReliability, "VERIFIED")}
            )`
          )
        ),
        sql`${conversations.id} IN (
          SELECT ${inboundMessages.conversationId}
          FROM ${inboundMessages}
          WHERE ${eq(inboundMessages.channelAccountId, channelAccountId)}
            AND (${inArray(inboundMessages.senderParticipantId, effectiveSelectedIds)}
               OR ${inArray(inboundMessages.senderExternalId, effectiveSelectedIds)})
            AND ${eq(inboundMessages.senderReliability, "VERIFIED")}
        )`
      )!
    );
  } else if (s.replyMode === "EVERYONE_EXCEPT") {
    const policyRows = await db
      .select({ participantId: replyPolicyMembers.participantId })
      .from(replyPolicyMembers)
      .where(
        and(
          eq(replyPolicyMembers.channelAccountId, channelAccountId),
          eq(replyPolicyMembers.policyMode, "EXCLUDE")
        )
      );

    const effectiveExcludedIds = extractParticipantIds(
      [
        ...(s.excludedParticipantIds || []),
        ...policyRows.map((r) => r.participantId),
      ],
      channelAccountId
    );

    if (effectiveExcludedIds.length > 0) {
      conditions.push(
        or(
          isNull(customers.externalCustomerId),
          notInArray(customers.externalCustomerId, effectiveExcludedIds)
        )!
      );
      conditions.push(
        sql`${conversations.id} NOT IN (
          SELECT ${inboundMessages.conversationId}
          FROM ${inboundMessages}
          WHERE ${eq(inboundMessages.channelAccountId, channelAccountId)}
            AND (${inArray(inboundMessages.senderParticipantId, effectiveExcludedIds)}
               OR ${inArray(inboundMessages.senderExternalId, effectiveExcludedIds)})
            AND ${eq(inboundMessages.senderReliability, "VERIFIED")}
        )`
      );
    }
  }

  return { isPolicyEmpty: false, conditions };
}
