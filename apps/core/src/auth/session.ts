import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRepository } from "@messenger/db";
import type { SessionUser, UserRole } from "@messenger/contracts";
import { getEnv } from "@messenger/config";

export function createAuthMiddleware(userRepo: UserRepository) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
    const env = getEnv();

    // 1. Resolve identity email from header
    const isProduction = process.env.NODE_ENV === "production" || env.NODE_ENV === "production";
    let email: string | undefined;

    if (isProduction) {
      // In production, strictly trust identity verified cryptographically via Cloudflare Access JWT
      email = request.headers["x-cf-access-user"] as string | undefined;
    } else {
      // Local dev / test fallback
      email = (
        request.headers["x-cf-access-user"] ||
        request.headers["cf-access-authenticated-user-email"] ||
        request.headers["x-dev-user-email"] ||
        "admin@example.com"
      ) as string | undefined;
    }

    if (!email) {
      reply.status(401).send({ error: "Missing Cloudflare Access identity" });
      return null;
    }

    // Production identities must be explicitly provisioned; unknown users are denied.
    let dbUser = await userRepo.findByEmail(email);
    if (!dbUser && !isProduction) {
      dbUser = await userRepo.findOrCreateFromCloudflare({
        email,
        role: "OWNER",
      });
    }
    if (!dbUser) {
      reply.status(403).send({ error: "Cloudflare identity is not authorized" });
      return null;
    }

    const sessionUser: SessionUser = {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role as UserRole,
      name: dbUser.name,
    };

    (request as unknown as { user: SessionUser }).user = sessionUser;
    return sessionUser;
  };
}
