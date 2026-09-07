import { getDb, conversations, messages, inboundMessages, aiRuns, conversationEvents, replyPolicyMembers } from "@messenger/db";
import { SettingsRepository } from "@messenger/db";
import { eq, inArray, sql } from "drizzle-orm";

async function main() {
  const isApply = process.argv.includes("--apply");
  const isDryRun = !isApply || process.argv.includes("--dry-run");

  console.log(`[Prune Script] Starting out-of-scope conversation cleanup (mode: ${isApply ? "APPLY" : "DRY-RUN"})...`);

  const db = getDb();
  const settingsRepo = new SettingsRepository(db);

  // Scan all conversations
  const allConversations = await db.select().from(conversations);
  console.log(`[Prune Script] Total conversations in database: ${allConversations.length}`);

  let outOfScopeCount = 0;
  let affectedMessagesCount = 0;
  let affectedInboundCount = 0;
  let affectedAiRunsCount = 0;
  let affectedEventsCount = 0;
  const conversationIdsToDelete: string[] = [];

  for (const conv of allConversations) {
    // Check if conversation has any manual owner reply or confirmed AI outbound
    const outbounds = await db
      .select({ id: messages.id, actor: messages.actor })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));

    const hasHumanReply = outbounds.some((m) => m.actor === "MANUAL_OWNER");
    const hasAiReply = outbounds.some((m) => m.actor === "AI");

    // Protect conversations with business value (Section 30)
    if (hasHumanReply || hasAiReply || conv.summary || conv.manualMode) {
      continue;
    }

    // Check settings for channel
    let settings = null;
    try {
      const res = await settingsRepo.getSettings(conv.channelAccountId);
      settings = res.settings;
    } catch {
      // defaults
    }

    if (!settings) continue;

    // Check scope: ONLY_SELECTED mode with unselected thread, or disabled group
    let isOutOfScope = false;
    if (conv.threadKind === "GROUP" && !settings.groupRepliesEnabled) {
      isOutOfScope = true;
    } else if (settings.replyMode === "ONLY_SELECTED") {
      const selected = new Set(settings.selectedParticipantIds || []);
      if (conv.externalCustomerId && !selected.has(conv.externalCustomerId)) {
        isOutOfScope = true;
      }
    }

    if (isOutOfScope) {
      outOfScopeCount++;
      conversationIdsToDelete.push(conv.id);

      const msgCount = outbounds.length;
      affectedMessagesCount += msgCount;

      const inbounds = await db
        .select({ id: inboundMessages.id })
        .from(inboundMessages)
        .where(eq(inboundMessages.conversationId, conv.id));
      affectedInboundCount += inbounds.length;

      const runs = await db
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(eq(aiRuns.conversationId, conv.id));
      affectedAiRunsCount += runs.length;

      const events = await db
        .select({ id: conversationEvents.id })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, conv.id));
      affectedEventsCount += events.length;
    }
  }

  console.log("\n=== PRUNE REPORT ===");
  console.log(`Conversations scanned:   ${allConversations.length}`);
  console.log(`Out-of-scope candidates: ${outOfScopeCount}`);
  console.log(`Messages affected:       ${affectedMessagesCount}`);
  console.log(`Inbound rows affected:   ${affectedInboundCount}`);
  console.log(`AI runs affected:        ${affectedAiRunsCount}`);
  console.log(`Events affected:         ${affectedEventsCount}`);
  const estimatedBytes = (affectedMessagesCount * 500) + (affectedInboundCount * 1000) + (outOfScopeCount * 400);
  console.log(`Estimated bytes reclaim: ~${Math.round(estimatedBytes / 1024)} KB`);

  if (isApply && conversationIdsToDelete.length > 0) {
    console.log(`\n[Prune Script] Applying deletion for ${conversationIdsToDelete.length} conversations...`);
    for (const id of conversationIdsToDelete) {
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    console.log("[Prune Script] Deletion complete.");
  } else if (!isApply) {
    console.log("\n[Prune Script] DRY-RUN complete. No rows were deleted. Run with --apply to execute.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[Prune Script] Fatal error:", err);
  process.exit(1);
});
