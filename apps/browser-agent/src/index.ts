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
  TurnRepository,
  OutboxRepository,
  ConversationControlService,
  channelAccounts,
} from "@messenger/db";
import { eq } from "drizzle-orm";
import { getEnv } from "@messenger/config";
import { PlaywrightMessengerAdapter, type BrowserSessionIssue } from "./messenger-adapter.js";
import { SenderWorkerService } from "./sender-worker.js";

async function main() {
  const env = getEnv();
  const db = getDb();
  const sql = getSql();

  const convRepo = new ConversationRepository(db);
  const controlService = new ConversationControlService(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);
  const jobRepo = new JobRepository(db);
  const turnRepo = new TurnRepository(db);
  const outboxRepo = new OutboxRepository(db);

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
    sql,
    undefined,
    turnRepo
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
          lastHealthCheckAt: new Date(),
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

  const sessionIncidentTypes = ["CHECKPOINT", "SESSION_EXPIRED", "INBOX_UNAVAILABLE", "RATE_LIMITED"] as const;

  adapter.onSessionIssue(async (issue: BrowserSessionIssue) => {
    const incidentType =
      issue.kind === "CHECKPOINT"
        ? "CHECKPOINT"
        : issue.kind === "LOGIN_REQUIRED"
          ? "SESSION_EXPIRED"
          : issue.kind === "RATE_LIMITED"
            ? "RATE_LIMITED"
            : "INBOX_UNAVAILABLE";
    const statusReason = `${issue.kind}: ${issue.message}`;
    console.error(`[Browser Agent] Suspending Messenger channel: ${statusReason}`);

    await db
      .update(channelAccounts)
      .set({
        status: "DEGRADED",
        isSuspended: true,
        statusReason,
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channelAccounts.id, env.DEFAULT_CHANNEL_ACCOUNT_ID));

    if (!(await incidentRepo.hasOpenIncident(env.DEFAULT_CHANNEL_ACCOUNT_ID, [incidentType]))) {
      await incidentRepo.createIncident({
        channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
        type: incidentType,
        title:
          issue.kind === "LOGIN_REQUIRED"
            ? "Phiên Facebook đã hết hạn"
            : issue.kind === "CHECKPOINT"
              ? "Facebook yêu cầu xác minh tài khoản"
              : issue.kind === "RATE_LIMITED"
                ? "Facebook giới hạn thao tác do dùng quá nhanh"
                : "Không thể quan sát hộp thư Messenger",
        description: issue.message,
        metadata: { kind: issue.kind },
      });
    }
  });

  adapter.onSessionRecovered(async () => {
    console.log("[Browser Agent] Messenger observer recovered.");
    await db
      .update(channelAccounts)
      .set({
        status: "RUNNING",
        isSuspended: false,
        statusReason: null,
        lastHealthCheckAt: new Date(),
        lastSeenActiveAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channelAccounts.id, env.DEFAULT_CHANNEL_ACCOUNT_ID));
    const resolvedCount = await incidentRepo.resolveOpenIncidentsByType(
      env.DEFAULT_CHANNEL_ACCOUNT_ID,
      [...sessionIncidentTypes],
      "SYSTEM",
      "Messenger đã tự kết nối và quan sát hộp thư trở lại"
    );
    if (resolvedCount > 0) {
      await eventRepo.recordEvent({
        channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
        type: "SESSION_RESUMED",
        payload: { source: "browser_observer" },
      });
    }
  });

  // Register durable bot checker so process restarts do not mistake bot actions for human outbound
  if (typeof adapter.setDurableBotOutboundChecker === "function") {
    adapter.setDurableBotOutboundChecker(async ({ threadId, bubbleId, text }) => {
      return await outboundRepo.checkBotOutboundEvidence({
        channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
        externalMessageRef: bubbleId,
        text,
        externalThreadId: threadId,
      });
    });
  }

  // Wire inbound observer (runs continuously, independent of sender typing)
  await adapter.observeInbound(async (inbound) => {
    console.log(`[Browser Agent] Inbound received from ${inbound.externalCustomerId}: "${inbound.text.slice(0, 30)}..."`);

    let debounceMs = 3000;
    let humanInboundResponseWaitMs = 60_000;
    let autoResumeAfterHuman = true;
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
      if (s?.settings?.humanInboundResponseWaitMs) {
        humanInboundResponseWaitMs = s.settings.humanInboundResponseWaitMs;
      }
      if (typeof s?.settings?.autoResumeAfterHuman === "boolean") {
        autoResumeAfterHuman = s.settings.autoResumeAfterHuman;
      }
    } catch (err) {
      console.warn("[Browser Agent] Failed to read settings, defaulting to 3000ms:", err);
    }

    // Ingest into PostgreSQL atomically with debounce job enqueued/updated
    const result = await convRepo.ingestInboundMessage(inbound, {
      debounceMs,
      humanInboundResponseWaitMs,
      autoResumeAfterHuman,
    });
    if (result.isDuplicate) {
      console.log(`[Browser Agent] Deduplicated message ${inbound.externalMessageId}`);
      return;
    }
    if (result.dropped) {
      console.log(`[Browser Agent] Inbound message DROPPED by eligibility-first gate (${result.reasonCode})`);
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

  // Wire external human outbound listener (detects replies sent on phone/native Messenger)
  if (typeof adapter.onExternalOutbound === "function") {
    adapter.onExternalOutbound(async (outbound) => {
      console.log(
        `[Browser Agent] External human outbound detected in thread ${outbound.threadId}: "${outbound.text.slice(0, 30)}..."`
      );
      try {
        const convResult = await convRepo.getConversationByThread(
          env.DEFAULT_CHANNEL_ACCOUNT_ID,
          outbound.threadId
        );
        if (!convResult) {
          console.warn(
            `[Browser Agent] No conversation matched for external outbound thread ${outbound.threadId}`
          );
          return;
        }

        const convId = convResult.conversation.id;

        // 1. Give the observed human response a configurable control session from settings.
        let holdDurationMs = 120_000;
        let maxSessionMs = 600_000;
        try {
          const s = await settingsRepo.getSettings(env.DEFAULT_CHANNEL_ACCOUNT_ID);
          if (s?.settings?.humanOutboundGraceMs) holdDurationMs = s.settings.humanOutboundGraceMs;
          if (s?.settings?.humanSessionMaxMs) maxSessionMs = s.settings.humanSessionMaxMs;
        } catch (err) {
          console.warn("[Browser Agent] Failed to read settings for human hold, using default 120s:", err);
        }

        const control = await controlService.acquireOrRefreshSession(convId, {
          outboundRef: `messenger:${outbound.threadId}:${outbound.timestamp}`,
          holdDurationMs,
          maxSessionMs,
        });

        // 2. Cancel typing immediately; the control transaction cancels queued AI actions.
        senderWorker.cancelActiveTyping(convId, Number.MAX_SAFE_INTEGER);
        try {
          await sql.notify(
            "browser_cancel_typing",
            JSON.stringify({
              channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
              conversationId: convId,
              inboundVersion: Number.MAX_SAFE_INTEGER,
              controlEpoch: control.epoch,
            })
          );
        } catch (notifyErr) {
          console.warn("[Browser Agent] Failed to emit cancel typing for external outbound:", notifyErr);
        }

        await outboxRepo.enqueue({
          channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
          conversationId: convId,
          eventType: "conversation:takeover",
          payload: {
            conversationId: convId,
            manualMode: true,
            controlEpoch: control.epoch,
          },
        });

        // 3. Record the state transition once; later human messages only refresh the session.
        if (control.changed) {
          await eventRepo.recordEvent({
            channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
            conversationId: convId,
            type: "MANUAL_TAKEOVER",
            actor: "HUMAN_MESSENGER",
            payload: {
              detectedAt: new Date(outbound.timestamp).toISOString(),
              holdDurationMs,
            },
          });
        }
      } catch (err) {
        console.error("[Browser Agent] Error handling external outbound:", err);
      }
    });
  }

  const HEARTBEAT_FILE = "/tmp/healthy";
  const heartbeatInterval = setInterval(async () => {
    try {
      const health = await adapter.health();
      await db
        .update(channelAccounts)
        .set({
          lastHealthCheckAt: health.timestamp,
          ...(health.healthy ? { lastSeenActiveAt: health.timestamp } : {}),
          updatedAt: new Date(),
        })
        .where(eq(channelAccounts.id, env.DEFAULT_CHANNEL_ACCOUNT_ID));
      if (!health.healthy) {
        console.warn(`[Browser Agent] Health check unhealthy: status=${health.status} error=${health.errorMessage || "none"}`);
        return;
      }
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
