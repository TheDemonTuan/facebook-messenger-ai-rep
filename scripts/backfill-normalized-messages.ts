import { getDb, messages, conversationEvents, type Database } from "../packages/db/src/index.js";
import { eq, gt, and, asc } from "drizzle-orm";

export interface BackfillOptions {
  dryRun?: boolean;
  batchSize?: number;
  cursor?: string;
  channelAccountId?: string;
  audit?: boolean;
}

export interface BackfillSummary {
  mode: "DRY-RUN" | "APPLIED";
  totalScanned: number;
  contaminatedCount: number;
  cleanedCount: number;
  quarantinedCount: number;
  v1UpgradedCount: number;
  skippedCleanCount: number;
  auditEntries: Array<{
    messageId: string;
    externalMessageId: string;
    action: "CLEANED" | "QUARANTINED" | "V1_UPGRADED";
    oldText: string;
    newText: string;
    reasons: string[];
  }>;
}

const UI_CONTAMINATION_PATTERNS = [
  /Profile\s+Mute\s+Search\s+Chat\s+info\s+Customize\s+chat\s+Media,\s+files\s+and\s+links\s+Privacy\s+&\s+support.*$/i,
  /Active\s+now\s+Profile\s+Mute\s+Search.*$/i,
  /Profile\s+Mute\s+Search.*$/i,
  /Media,\s+files\s+and\s+links\s+Privacy\s+&\s+support.*$/i,
  /Enter,\s+Message\s+sent.*$/i,
];

/**
 * Detects whether a message text contains known legacy parser UI contamination,
 * strips the extraneous UI elements, or marks full UI artifacts for quarantine.
 */
export function cleanContaminatedText(text: string): {
  cleanedText: string;
  isContaminated: boolean;
  isQuarantined: boolean;
  reasons: string[];
} {
  if (!text) {
    return { cleanedText: "", isContaminated: false, isQuarantined: false, reasons: [] };
  }

  let workingText = text;
  let isContaminated = false;
  const reasons: string[] = [];

  for (const pattern of UI_CONTAMINATION_PATTERNS) {
    if (pattern.test(workingText)) {
      isContaminated = true;
      reasons.push(`MATCHED_PATTERN_${pattern.source.slice(0, 20)}`);
      workingText = workingText.replace(pattern, "").trim();
    }
  }

  // If the text was 100% UI contamination without any customer speech
  if (isContaminated && workingText.length === 0) {
    return {
      cleanedText: "",
      isContaminated: true,
      isQuarantined: true,
      reasons: [...reasons, "FULL_UI_ARTIFACT_QUARANTINED"],
    };
  }

  return {
    cleanedText: workingText,
    isContaminated,
    isQuarantined: false,
    reasons,
  };
}

/**
 * Runs historical message normalization backfill in dry-run or apply mode.
 * GUARANTEES:
 * 1. Default mode is DRY-RUN (0 database modifications).
 * 2. Absolutely NEVER increments or modifies conversations.inboundVersion.
 * 3. Absolutely NEVER creates jobs (no debounce, no ai jobs).
 * 4. Absolutely NEVER creates turns, outbox entries, or outbound replies.
 * 5. Processes in batches using cursor-based pagination.
 * 6. Emits structured audit entries.
 */
export async function runBackfill(
  options: BackfillOptions = {},
  customDb?: Database
): Promise<BackfillSummary> {
  const isApply = process.argv.includes("--apply");
  const dryRun = options.dryRun !== undefined ? options.dryRun : !isApply || process.argv.includes("--dry-run");
  const batchSize = options.batchSize ?? 100;
  const targetChannel = options.channelAccountId;
  const verboseAudit = options.audit ?? process.argv.includes("--audit");

  const db = customDb ?? getDb();

  console.log(`[Backfill Script] Starting message backfill (Mode: ${dryRun ? "DRY-RUN (Safe, no DB writes)" : "APPLIED (Modifies DB)"}, Batch: ${batchSize})...`);

  let currentCursor: string | undefined = options.cursor;
  let totalScanned = 0;
  let contaminatedCount = 0;
  let cleanedCount = 0;
  let quarantinedCount = 0;
  let v1UpgradedCount = 0;
  let skippedCleanCount = 0;

  const auditEntries: BackfillSummary["auditEntries"] = [];
  const maxAuditEntries = verboseAudit ? 50 : 1_000;

  while (true) {
    // 1. Fetch next batch ordered by id asc using cursor
    const conditions = [];
    if (currentCursor) {
      conditions.push(gt(messages.id, currentCursor));
    }
    if (targetChannel) {
      conditions.push(eq(messages.channelAccountId, targetChannel));
    }

    const batch = await db
      .select({
        id: messages.id,
        channelAccountId: messages.channelAccountId,
        conversationId: messages.conversationId,
        externalMessageId: messages.externalMessageId,
        text: messages.text,
        content: messages.content,
        contentSchemaVersion: messages.contentSchemaVersion,
        contentStatus: messages.contentStatus,
        contentRevision: messages.contentRevision,
        inboundVersion: messages.inboundVersion,
      })
      .from(messages)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(messages.id))
      .limit(batchSize);

    if (batch.length === 0) {
      break;
    }

    totalScanned += batch.length;

    for (const msg of batch) {
      const isLegacyV1 = !msg.contentSchemaVersion || msg.contentSchemaVersion < 2 || !msg.content;
      const cleanResult = cleanContaminatedText(msg.text || "");

      if (!isLegacyV1 && !cleanResult.isContaminated) {
        skippedCleanCount++;
        continue;
      }

      if (cleanResult.isContaminated) {
        contaminatedCount++;
        if (cleanResult.isQuarantined) {
          quarantinedCount++;
        } else {
          cleanedCount++;
        }
      } else if (isLegacyV1) {
        v1UpgradedCount++;
      }

      const action: "CLEANED" | "QUARANTINED" | "V1_UPGRADED" = cleanResult.isQuarantined
        ? "QUARANTINED"
        : cleanResult.isContaminated
        ? "CLEANED"
        : "V1_UPGRADED";

      const effectiveText = cleanResult.cleanedText;
      const existingContent = (msg.content as { parts?: unknown[] }) || {};
      const existingParts = Array.isArray(existingContent.parts) ? existingContent.parts : [];

      const newParts = effectiveText
        ? [{ type: "TEXT", text: effectiveText }, ...existingParts.filter((p: unknown) => (p as { type?: string }).type !== "TEXT")]
        : existingParts.filter((p: unknown) => (p as { type?: string }).type !== "TEXT");

      const newContentStatus = cleanResult.isQuarantined ? "QUARANTINED" : "READY";
      const nextRevision = (msg.contentRevision || 1) + 1;

      const newContent = {
        contentSchemaVersion: 2,
        contentRevision: nextRevision,
        contentStatus: newContentStatus,
        parts: newParts,
        text: effectiveText,
        normalization: {
          parserVersion: "backfill-v2",
          warnings: cleanResult.reasons,
        },
      };

      if (auditEntries.length < maxAuditEntries) {
        auditEntries.push({
          messageId: msg.id,
          externalMessageId: msg.externalMessageId,
          action,
          oldText: msg.text,
          newText: effectiveText,
          reasons: cleanResult.reasons,
        });
      }

      if (!dryRun) {
        // Execute update to messages row WITHOUT bumping inboundVersion and WITHOUT creating jobs
        await db
          .update(messages)
          .set({
            text: effectiveText,
            content: newContent,
            contentSchemaVersion: 2,
            contentStatus: newContentStatus,
            contentRevision: nextRevision,
          })
          .where(eq(messages.id, msg.id));

        // Insert audit trail into conversationEvents
        await db.insert(conversationEvents).values({
          channelAccountId: msg.channelAccountId,
          conversationId: msg.conversationId,
          type: "BACKFILL_AUDIT",
          actor: "SYSTEM",
          inboundVersion: msg.inboundVersion,
          payload: {
            messageId: msg.id,
            externalMessageId: msg.externalMessageId,
            action,
            oldText: msg.text,
            newText: effectiveText,
            reasons: cleanResult.reasons,
          },
        });
      }
    }

    currentCursor = batch[batch.length - 1]!.id;

    if (batch.length < batchSize) {
      break;
    }
  }

  console.log(`[Backfill Script] Completed ${dryRun ? "DRY-RUN" : "APPLY"}:`);
  console.log(`  - Total messages scanned: ${totalScanned}`);
  console.log(`  - Contaminated messages detected: ${contaminatedCount}`);
  console.log(`    * Cleaned & retained user text: ${cleanedCount}`);
  console.log(`    * Quarantined (100% UI artifacts): ${quarantinedCount}`);
  console.log(`  - Legacy v1 upgraded to v2: ${v1UpgradedCount}`);
  console.log(`  - Already clean v2 skipped: ${skippedCleanCount}`);

  if (verboseAudit && auditEntries.length > 0) {
    console.log(`\n--- Audit Entries (${auditEntries.length} total) ---`);
    for (const entry of auditEntries.slice(0, 50)) {
      console.log(`[${entry.action}] msg=${entry.messageId} | old="${entry.oldText.slice(0, 40)}" -> new="${entry.newText.slice(0, 40)}" | reasons=${entry.reasons.join(",")}`);
    }
    if (auditEntries.length > 50) {
      console.log(`... and ${auditEntries.length - 50} more entries.`);
    }
  }

  return {
    mode: dryRun ? "DRY-RUN" : "APPLIED",
    totalScanned,
    contaminatedCount,
    cleanedCount,
    quarantinedCount,
    v1UpgradedCount,
    skippedCleanCount,
    auditEntries,
  };
}

// CLI execution check
if (process.argv[1]?.includes("backfill-normalized-messages")) {
  runBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Backfill Script] Fatal error:", err);
      process.exit(1);
    });
}
