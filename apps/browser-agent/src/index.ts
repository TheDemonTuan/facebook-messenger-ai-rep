import {
  getDb,
  closeDb,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";
import {
  getRedis,
  closeRedis,
  AppQueues,
  LeaseManager,
  DebounceManager,
  InboundCoordinator,
} from "@messenger/queue";
import { getEnv } from "@messenger/config";
import { PlaywrightMessengerAdapter } from "./messenger-adapter.js";
import { SenderWorkerService } from "./sender-worker.js";

async function main() {
  const env = getEnv();
  const db = getDb();
  const redis = getRedis();

  const queues = new AppQueues(redis);
  const leaseManager = new LeaseManager(redis);
  const debounceManager = new DebounceManager(redis, queues);

  const convRepo = new ConversationRepository(db);
  const queueRepo = new QueueRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);

  const inboundCoordinator = new InboundCoordinator(
    convRepo,
    eventRepo,
    debounceManager,
    settingsRepo
  );

  const adapter = new PlaywrightMessengerAdapter({
    profileDir: env.BROWSER_PROFILE_DIR,
    headless: env.BROWSER_HEADLESS,
    channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
  });

  console.log("Initializing Browser Agent & Messenger Web adapter...");
  await adapter.init();

  // Wire inbound observation
  await adapter.observeInbound(async (inbound) => {
    console.log(`[Browser Agent] Inbound received from ${inbound.externalCustomerId}: "${inbound.text.slice(0, 30)}..."`);
    await inboundCoordinator.handleInbound(inbound);
  });

  const senderWorker = new SenderWorkerService(
    db,
    redis,
    adapter,
    leaseManager,
    convRepo,
    queueRepo,
    outboundRepo,
    eventRepo,
    settingsRepo,
    incidentRepo
  );

  senderWorker.start();

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down Browser Agent...`);
    await senderWorker.stop();
    await adapter.close();
    await queues.close();
    await closeRedis();
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
