import fs from "node:fs";
import {
  getDb,
  getSql,
  closeDb,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";
import { getRedis, closeRedis, AppQueues } from "@messenger/queue";
import { getEnv } from "@messenger/config";
import { checkAiHealth } from "@messenger/ai";
import { AiWorkerService } from "./worker.js";

async function main() {
  const env = getEnv();
  const db = getDb();
  const redis = getRedis();
  const queues = new AppQueues(redis);

  const convRepo = new ConversationRepository(db);
  const queueRepo = new QueueRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);

  console.log("Checking AI Gateway connectivity...");
  const { settings } = await settingsRepo.getSettings(env.DEFAULT_CHANNEL_ACCOUNT_ID);
  const health = await checkAiHealth({
    baseURL: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
  });
  console.log(`[AI Health] ${health.message}`);

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

  const HEARTBEAT_FILE = "/tmp/healthy";
  const heartbeatInterval = setInterval(async () => {
    try {
      if (!workerService.active) return;
      const ping = await redis.ping();
      await getSql().unsafe("SELECT 1");
      if (ping === "PONG") {
        fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString());
      }
    } catch (err) {
      console.warn("[AI Worker] Health check failed:", err);
    }
  }, 5000);

  try {
    fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString());
  } catch {}

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down AI worker service...`);
    clearInterval(heartbeatInterval);
    try { fs.unlinkSync(HEARTBEAT_FILE); } catch {}
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
