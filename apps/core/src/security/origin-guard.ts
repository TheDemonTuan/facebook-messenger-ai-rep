import type { FastifyRequest, FastifyReply } from "fastify";
import { getEnv } from "@messenger/config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function verifySameOrigin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (SAFE_METHODS.has(request.method)) {
    return true;
  }

  // Exempt internal health endpoints
  if (request.url.startsWith("/health") || request.url.startsWith("/readyz")) {
    return true;
  }

  // 1. Check Sec-Fetch-Site
  const secFetchSite = request.headers["sec-fetch-site"];
  if (secFetchSite === "cross-site") {
    reply.status(403).send({ error: "Forbidden: cross-site requests are not permitted" });
    return false;
  }

  const host = request.headers.host;
  const origin = request.headers.origin as string | undefined;

  // 2. Check Origin header if present
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        // In local development, allow localhost/127.0.0.1 cross-port
        const env = getEnv();
        const isLocalDev =
          process.env.NODE_ENV !== "production" &&
          env.NODE_ENV !== "production" &&
          (originHost.startsWith("localhost:") || originHost.startsWith("127.0.0.1:"));

        if (!isLocalDev) {
          reply.status(403).send({ error: "Forbidden: origin mismatch" });
          return false;
        }
      }
    } catch {
      reply.status(403).send({ error: "Forbidden: malformed origin header" });
      return false;
    }
  }

  // 3. Fallback to Referer header if Origin is absent
  const referer = request.headers.referer as string | undefined;
  if (!origin && referer && host) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) {
        const env = getEnv();
        const isLocalDev =
          process.env.NODE_ENV !== "production" &&
          env.NODE_ENV !== "production" &&
          (refererHost.startsWith("localhost:") || refererHost.startsWith("127.0.0.1:"));

        if (!isLocalDev) {
          reply.status(403).send({ error: "Forbidden: referer mismatch" });
          return false;
        }
      }
    } catch {
      reply.status(403).send({ error: "Forbidden: malformed referer header" });
      return false;
    }
  }

  return true;
}
