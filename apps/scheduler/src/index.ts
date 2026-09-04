import { getDb, closeDb, ConversationRepository, QueueRepository, EventRepository, SettingsRepository } from "@messenger/db";
import { getRedis, closeRedis, AppQueues, LeaseManager, DebounceManager } from "@messenger/queue";
import { getEnv } from "@messenger/config";
import { SchedulerService } from "./scheduler.js";

async function main() {
  const env = getEnv();
  const db = getDb();
  const redis = getRedis();

  const queues = new AppQueues(redis);
  const leaseManager = new LeaseManager(redis);
  const debounceManager = new DebounceManager(redis, queues);

  const convRepo = new ConversationRepository(db);
  const queueRepo = new QueueRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);

  const scheduler = new SchedulerService(
    db,
    redis,
    queues,
    leaseManager,
    debounceManager,
    convRepo,
    queueRepo,
    eventRepo,
    settingsRepo,
    {
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
      pollIntervalMs: 500,
      leaseDurationMs: 30000,
    }
  );

  await scheduler.start();

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down scheduler service...`);
    await scheduler.stop();
    await queues.close();
    await closeRedis();
    await closeDb();
    console.log("Scheduler service exited cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error starting scheduler service:", err);
  process.exit(1);
});
