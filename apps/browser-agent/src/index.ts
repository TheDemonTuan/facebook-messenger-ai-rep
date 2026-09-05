import fs from "node:fs";
import {
  getDb,
  getSql,
  closeDb,
  ConversationRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
  JobRepository,
  channelAccounts,
} from "@messenger/db";
import { eq } from "drizzle-orm";
import { getEnv } from "@messenger/config";
import { PlaywrightMessengerAdapter } from "./messenger-adapter.js";
import { SenderWorkerService } from "./sender-worker.js";

async function main() {
  const env = getEnv();
  const db = getDb();
  const sql = getSql();

  const convRepo = new ConversationRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);
  const jobRepo = new JobRepository(db);

  let initialTimeZone = "Asia/Ho_Chi_Minh";
  try {
    const s = await settingsRepo.getSettings(env.DEFAULT_CHANNEL_ACCOUNT_ID);
    if (s?.settings?.businessTimeZone) {
      initialTimeZone = s.settings.businessTimeZone;
    }
  } catch (err) {
    console.warn("[Browser Agent] Failed to read initial businessTimeZone from settings:", err);
  }

  const adapter = new PlaywrightMessengerAdapter({
    profileDir: env.BROWSER_PROFILE_DIR,
    headless: env.BROWSER_HEADLESS,
    channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    timeZone: initialTimeZone,
  });

  console.log("Initializing PostgreSQL-foundation Browser Agent...");
  await adapter.init();

  const senderWorker = new SenderWorkerService(
    db,
    null,
    adapter,
    null,
    convRepo,
    null,
    outboundRepo,
    eventRepo,
    settingsRepo,
    incidentRepo,
    jobRepo,
    sql
  );

  senderWorker.start();

  // Listen for DOM degradation: fail-closed suspend, no Date.now
  if (typeof adapter.onDegradedDom === "function") {
    adapter.onDegradedDom(async (reason: string) => {
      console.error(`[Browser Agent] Handling DOM_DEGRADED: ${reason}`);
      await db
        .update(channelAccounts)
        .set({
          status: "DEGRADED",
          isSuspended: true,
          statusReason: `DOM_DEGRADED: ${reason}`,
          updatedAt: new Date(),
        })
        .where(eq(channelAccounts.id, env.DEFAULT_CHANNEL_ACCOUNT_ID));

      await incidentRepo.createIncident({
        channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
        type: "DOM_CHANGED",
        title: "Facebook Messenger DOM degraded: missing stable message identity",
        description: reason,
        metadata: { reason },
        autoSuspendChannel: true,
      });
    });
  }

  // Wire inbound observer (runs continuously, independent of sender typing)
  await adapter.observeInbound(async (inbound) => {
    console.log(`[Browser Agent] Inbound received from ${inbound.externalCustomerId}: "${inbound.text.slice(0, 30)}..."`);

    let debounceMs = 3000;
    try {
      const s = await settingsRepo.getSettings(inbound.channelAccountId);
      if (s?.settings?.businessTimeZone && typeof adapter.setTimeZone === "function") {
        const needsRecreation = adapter.setTimeZone(s.settings.businessTimeZone);
        if (needsRecreation && typeof adapter.reinitializeContext === "function") {
          console.log(`[Browser Agent] Timezone changed to ${s.settings.businessTimeZone}, reinitializing context...`);
          await adapter.reinitializeContext();
        }
      }
      if (s?.settings?.debounceMs) {
        debounceMs = s.settings.debounceMs;
      }
    } catch (err) {
      console.warn("[Browser Agent] Failed to read settings, defaulting to 3000ms:", err);
    }

    // Ingest into PostgreSQL atomically with debounce job enqueued/updated
    const result = await convRepo.ingestInboundMessage(inbound, { debounceMs });
    if (result.isDuplicate) {
      console.log(`[Browser Agent] Deduplicated message ${inbound.externalMessageId}`);
      return;
    }

    if (result.eligibility?.eligible) {
      console.log(`[Browser Agent] Inbound message is ELIGIBLE for reply: debounce scheduled (v${result.inboundVersion})`);
    } else {
      console.log(`[Browser Agent] Inbound message is INELIGIBLE for reply (${result.eligibility?.reasonCode}): ${result.eligibility?.reason}`);
    }

    // Abort stale outbound actions for this conversation
    await outboundRepo.abortStaleActions(result.conversationId, result.inboundVersion);

    // Cancel typing locally in this process
    senderWorker.cancelActiveTyping(result.conversationId, result.inboundVersion);

    // Send PostgreSQL notification to cancel typing across all sender workers
    try {
      await sql.notify(
        "browser_cancel_typing",
        JSON.stringify({
          channelAccountId: inbound.channelAccountId,
          conversationId: result.conversationId,
          inboundVersion: result.inboundVersion,
        })
      );
    } catch (err) {
      console.warn("[Browser Agent] Failed to emit browser_cancel_typing notification:", err);
    }
  });

  const HEARTBEAT_FILE = "/tmp/healthy";
  const heartbeatInterval = setInterval(async () => {
    try {
      const health = await adapter.health();
      if (!health.healthy) return;
      await sql.unsafe("SELECT 1");
      fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString());
    } catch (err) {
      console.warn("[Browser Agent] Health check failed:", err);
    }
  }, 5000);

  try {
    fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString());
  } catch {
    // ignore initial heartbeat write failure
  }

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down Browser Agent...`);
    clearInterval(heartbeatInterval);
    try {
      fs.unlinkSync(HEARTBEAT_FILE);
    } catch {
      // ignore cleanup unlink error
    }
    await senderWorker.stop();
    await adapter.close();
    await closeDb();
    console.log("Browser Agent stopped cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error starting Browser Agent service:", err);
  process.exit(1);
});
