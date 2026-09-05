import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCoreServer } from "./server.js";
import { getEnv, validateCoreProductionEnv, resetEnvCache } from "@messenger/config";
import { closeDb } from "@messenger/db";

export * from "./server.js";
export * from "./auth/roles.js";
export * from "./auth/session.js";
export * from "./auth/cloudflare.js";
export * from "./security/rate-limiter.js";
export * from "./security/origin-guard.js";
export * from "./sse/outbox-broadcaster.js";
export * from "./jobs/scheduler.js";
export { resetEnvCache };

async function main() {
  validateCoreProductionEnv(getEnv());
  const port = parseInt(process.env.CORE_PORT || process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";

  console.log("[Core] Booting Core Application (Control-Plane + Scheduler + AI-Worker)...");
  const context = await buildCoreServer();

  // 1. Start Job Runner & background tasks
  await context.jobService.start();

  // 2. Start HTTP & SSE server
  try {
    const address = await context.fastify.listen({ port, host });
    console.log(`[Core] Server listening on ${address}`);
  } catch (err) {
    console.error("[Core] Failed to start server:", err);
    await context.jobService.stop();
    await closeDb();
    process.exit(1);
  }

  // 3. Graceful Drain Handler
  let isShuttingDown = false;
  const gracefulDrain = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[Core] Received ${signal}. Starting graceful drain...`);

    try {
      // Close HTTP server to stop accepting new requests
      await context.fastify.close();
      console.log("[Core] HTTP server closed.");

      // Stop Job Runner and drain in-flight jobs
      await context.jobService.stop();
      console.log("[Core] Job runner drained and stopped.");

      // Stop broadcaster & rate limiter
      context.broadcaster.stop();
      context.rateLimiter.destroy();

      // Close DB connections
      await closeDb();
      console.log("[Core] Database connections closed.");

      console.log("[Core] Graceful drain completed successfully.");
      process.exit(0);
    } catch (err) {
      console.error("[Core] Error during graceful drain:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => gracefulDrain("SIGTERM"));
  process.on("SIGINT", () => gracefulDrain("SIGINT"));
}

// Auto-run if executed directly
const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => {
    console.error("[Core] Fatal error during startup:", err);
    process.exit(1);
  });
}
