import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRepository } from "@messenger/db";
import type { SessionUser, UserRole } from "@messenger/contracts";
import { getEnv } from "@messenger/config";

export function createAuthMiddleware(userRepo: UserRepository) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
    const env = getEnv();

    // 1. Extract email identity from Cloudflare Access headers
    let email = (
      request.headers["cf-access-authenticated-user-email"] ||
      request.headers["x-cf-access-user"]
    ) as string | undefined;

    // 2. Local development / testing fallback
    if (!email && env.NODE_ENV !== "production") {
      email = "admin@example.com";
    }

    if (!email) {
      reply.status(401).send({ error: "Missing Cloudflare Access identity" });
      return null;
    }

    // 3. Resolve user in DB
    const user = await userRepo.findOrCreateFromCloudflare({
      email,
      role: "OWNER",
    });

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      name: user.name,
    };

    (request as unknown as { user: SessionUser }).user = sessionUser;
    return sessionUser;
  };
}
