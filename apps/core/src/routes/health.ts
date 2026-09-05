import type { FastifyPluginAsync } from "fastify";
import type { Database } from "@messenger/db";
import { sql } from "drizzle-orm";
import { getEnv } from "@messenger/config";

export interface HealthRoutesOptions {
  db: Database;
}

export function createHealthRoutes(options: HealthRoutesOptions): FastifyPluginAsync {
  const { db } = options;

  return async function (fastify) {
    // 1. Liveness check: verifies the Node process is running
    fastify.get("/healthz", async (_request, reply) => {
      return reply.status(200).send({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    // 2. Readiness check: verifies DB connectivity with real SELECT 1
    fastify.get("/readyz", async (_request, reply) => {
      try {
        await db.execute(sql`SELECT 1`);
        return reply.status(200).send({
          status: "ready",
          database: true,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return reply.status(503).send({
          status: "unready",
          database: false,
          error: (err as Error).message,
        });
      }
    });

    // 3. Backward compatible health check
    fastify.get("/health", async (_request, reply) => {
      const env = getEnv();
      try {
        await db.execute(sql`SELECT 1`);
        return reply.status(200).send({
          status: "ok",
          database: true,
          channelAccountId: env.DEFAULT_CHANNEL_ACCOUNT_ID,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return reply.status(503).send({
          status: "unhealthy",
          database: false,
          error: (err as Error).message,
        });
      }
    });
  };
}
