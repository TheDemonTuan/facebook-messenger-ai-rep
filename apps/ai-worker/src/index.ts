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
import { getRedis, closeRedis, AppQueues } from "@messenger/queue";
import { checkAiHealth } from "@messenger/ai";
import { AiWorkerService } from "./worker.js";

async function main() {
  console.log("Checking AI Gateway connectivity...");
  const health = await checkAiHealth();
  console.log(`[AI Health] ${health.message}`);

  const db = getDb();
  const redis = getRedis();
  const queues = new AppQueues(redis);

  const convRepo = new ConversationRepository(db);
  const queueRepo = new QueueRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);

  const workerService = new AiWorkerService(
    db,
    redis,
    queues,
    convRepo,
    queueRepo,
    outboundRepo,
    eventRepo,
    settingsRepo,
    incidentRepo
  );

  workerService.start();

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down AI worker service...`);
    await workerService.stop();
    await queues.close();
    await closeRedis();
    await closeDb();
    console.log("AI worker service stopped cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error starting AI worker service:", err);
  process.exit(1);
});
