import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRepository } from "@messenger/db";
import type { SessionUser, UserRole } from "@messenger/contracts";
import { getEnv } from "@messenger/config";

export function createAuthMiddleware(userRepo: UserRepository) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
    const env = getEnv();

    // 1. Resolve identity email from header (populated by verifyCloudflareAccess or direct CF header)
    let email = (
      request.headers["x-cf-access-user"] ||
      request.headers["cf-access-authenticated-user-email"]
    ) as string | undefined;

    // Local dev fallback if not in production
    const isProduction = process.env.NODE_ENV === "production" || env.NODE_ENV === "production";
    if (!email && !isProduction) {
      email = (request.headers["x-dev-user-email"] as string) || "admin@example.com";
    }

    if (!email) {
      reply.status(401).send({ error: "Missing Cloudflare Access identity" });
      return null;
    }

    // 2. Fetch or create user record in DB.
    // If user already exists in DB, findOrCreateFromCloudflare preserves the existing role in DB!
    const dbUser = await userRepo.findOrCreateFromCloudflare({
      email,
      role: "OWNER",
    });

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
