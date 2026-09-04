import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getEnv } from "@messenger/config";
import {
  getDb,
  closeDb,
  UserRepository,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";
import { getRedis, closeRedis, AppQueues } from "@messenger/queue";
import { SseBroadcaster } from "./sse/broadcaster.js";
import { verifyCloudflareAccess } from "./auth/cloudflare.js";
import { createAuthMiddleware } from "./auth/session.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createInboxRoutes } from "./routes/inbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function buildServer() {
  const env = getEnv();
  const db = getDb();
  const redis = getRedis();
  const queues = new AppQueues(redis);
  const broadcaster = new SseBroadcaster();

  const userRepo = new UserRepository(db);
  const convRepo = new ConversationRepository(db);
  const queueRepo = new QueueRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);

  const requireAuth = createAuthMiddleware(userRepo);

  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  await fastify.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await fastify.register(fastifyCookie, {
    secret: env.SESSION_SECRET,
  });

  // Cloudflare Access Hook
  fastify.addHook("onRequest", async (request, reply) => {
    // Exclude static assets from CF validation if desired, or validate on all
    if (request.url.startsWith("/api") || request.url.startsWith("/events")) {
      const allowed = await verifyCloudflareAccess(request, reply);
      if (!allowed) return;
    }
  });

  // Health endpoint
  fastify.get("/health", async (_request, reply) => {
    try {
      const ping = await redis.ping();
      return reply.send({
        status: "ok",
        redis: ping === "PONG",
        database: true,
        channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
        timestamp: new Date(),
      });
    } catch (err) {
      return reply.status(503).send({ status: "unhealthy", error: (err as Error).message });
    }
  });

  // SSE Events stream
  fastify.get("/events", async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;

    const lastEventId = request.headers["last-event-id"] as string | undefined;
    broadcaster.addClient(reply, lastEventId);
  });

  // Mount API route plugins
  await fastify.register(createAuthRoutes(userRepo));
  await fastify.register(
    createAdminRoutes({
      db,
      queueRepo,
      settingsRepo,
      incidentRepo,
      eventRepo,
      broadcaster,
      requireAuth,
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    })
  );
  await fastify.register(
    createInboxRoutes({
      db,
      queues,
      convRepo,
      queueRepo,
      outboundRepo,
      eventRepo,
      broadcaster,
      requireAuth,
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    })
  );

  // Serve Dashboard Static Files if present
  const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");
  if (fs.existsSync(dashboardDist)) {
    console.log(`Serving static dashboard from ${dashboardDist}`);
    await fastify.register(fastifyStatic, {
      root: dashboardDist,
      prefix: "/",
    });

    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/events")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return { fastify, queues, broadcaster };
}

async function start() {
  const env = getEnv();
  const { fastify, queues, broadcaster } = await buildServer();

  try {
    await fastify.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 Control Plane running at http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down Control Plane...`);
    broadcaster.close();
    await fastify.close();
    await queues.close();
    await closeRedis();
    await closeDb();
    console.log("Control Plane exited cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run if called as entrypoint
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  start();
}
