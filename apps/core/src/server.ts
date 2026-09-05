import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getEnv } from "@messenger/config";
import {
  getDb,
  UserRepository,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
  JobRepository,
  TurnRepository,
  OutboxRepository,
  type Database,
} from "@messenger/db";
import { AiReplyGenerator } from "@messenger/ai";
import { OutboxBroadcaster } from "./sse/outbox-broadcaster.js";
import { verifyCloudflareAccess } from "./auth/cloudflare.js";
import { createAuthMiddleware } from "./auth/session.js";
import { verifySameOrigin } from "./security/origin-guard.js";
import { InMemoryRateLimiter } from "./security/rate-limiter.js";
import { CoreJobService } from "./jobs/scheduler.js";
import { createHealthRoutes } from "./routes/health.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createBrowserRoutes } from "./routes/browser.js";
import { createEventsRoutes } from "./routes/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CoreServerOptions {
  db?: Database;
  enableJobRunner?: boolean;
}

export interface CoreServerContext {
  fastify: FastifyInstance;
  broadcaster: OutboxBroadcaster;
  jobService: CoreJobService;
  rateLimiter: InMemoryRateLimiter;
  db: Database;
  repos: {
    userRepo: UserRepository;
    convRepo: ConversationRepository;
    queueRepo: QueueRepository;
    outboundRepo: OutboundRepository;
    eventRepo: EventRepository;
    settingsRepo: SettingsRepository;
    incidentRepo: IncidentRepository;
    jobRepo: JobRepository;
    turnRepo: TurnRepository;
    outboxRepo: OutboxRepository;
  };
}

export async function buildCoreServer(options: CoreServerOptions = {}): Promise<CoreServerContext> {
  const env = getEnv();
  const db = options.db || getDb();

  // Repositories
  const userRepo = new UserRepository(db);
  const convRepo = new ConversationRepository(db);
  const queueRepo = new QueueRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const eventRepo = new EventRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const incidentRepo = new IncidentRepository(db);
  const jobRepo = new JobRepository(db);
  const turnRepo = new TurnRepository(db);
  const outboxRepo = new OutboxRepository(db);

  const aiGenerator = new AiReplyGenerator();
  const broadcaster = new OutboxBroadcaster(outboxRepo);
  const rateLimiter = new InMemoryRateLimiter({ maxRequests: 120, windowMs: 60000 });

  const jobService = new CoreJobService({
    db,
    jobRepo,
    turnRepo,
    convRepo,
    outboundRepo,
    settingsRepo,
    incidentRepo,
    eventRepo,
    outboxRepo,
    broadcaster,
    aiGenerator,
  });

  const requireAuth = createAuthMiddleware(userRepo);

  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL || "info",
    },
  });

  // CORS
  await fastify.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  // Cookie
  await fastify.register(fastifyCookie, {
    secret: env.SESSION_SECRET || "default-secret-key-32-chars-long-core!",
  });

  // Security Hooks: Cloudflare Access, Rate Limit, Same-Origin
  fastify.addHook("onRequest", async (request, reply) => {
    // 1. Rate Limiting on API requests
    if (request.url.startsWith("/api") || request.url.startsWith("/events")) {
      const allowedRate = await rateLimiter.checkRateLimit(request, reply);
      if (!allowedRate) return;
    }

    // 2. Same-Origin check on mutating requests
    const allowedOrigin = await verifySameOrigin(request, reply);
    if (!allowedOrigin) return;

    // 3. Cloudflare Access validation on API & SSE
    if (request.url.startsWith("/api") || request.url.startsWith("/events")) {
      const allowedCf = await verifyCloudflareAccess(request, reply);
      if (!allowedCf) return;
    }
  });

  // Health probe routes
  await fastify.register(createHealthRoutes({ db }));

  // SSE Stream routes
  await fastify.register(
    createEventsRoutes({
      broadcaster,
      requireAuth,
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    })
  );

  // Authentication routes
  await fastify.register(createAuthRoutes({ userRepo, requireAuth }));

  // Admin & Settings routes
  await fastify.register(
    createAdminRoutes({
      db,
      queueRepo,
      settingsRepo,
      incidentRepo,
      eventRepo,
      jobRepo,
      broadcaster,
      requireAuth,
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    })
  );

  // Inbox & Conversation routes
  await fastify.register(
    createInboxRoutes({
      db,
      convRepo,
      queueRepo,
      outboundRepo,
      jobRepo,
      eventRepo,
      outboxRepo,
      broadcaster,
      requireAuth,
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    })
  );

  // Browser Agent contract routes
  await fastify.register(
    createBrowserRoutes({
      db,
      convRepo,
      outboundRepo,
      jobRepo,
      eventRepo,
      settingsRepo,
      outboxRepo,
      broadcaster,
      requireAuth,
      channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
    })
  );

  // Serve Dashboard Static build if exists
  const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");
  if (fs.existsSync(dashboardDist)) {
    console.log(`[Core] Serving static dashboard from ${dashboardDist}`);
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

  return {
    fastify,
    broadcaster,
    jobService,
    rateLimiter,
    db,
    repos: {
      userRepo,
      convRepo,
      queueRepo,
      outboundRepo,
      eventRepo,
      settingsRepo,
      incidentRepo,
      jobRepo,
      turnRepo,
      outboxRepo,
    },
  };
}
