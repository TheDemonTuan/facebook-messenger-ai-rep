import type { FastifyPluginAsync } from "fastify";
import type { UserRepository } from "@messenger/db";
import type { SessionUser, UserRole } from "@messenger/contracts";
import { getEnv } from "@messenger/config";

export function createAuthRoutes(userRepo: UserRepository): FastifyPluginAsync {
  return async function (fastify) {
    fastify.post("/api/auth/login", async (request, reply) => {
      const env = getEnv();
      const body = (request.body || {}) as { email?: string };
      const email =
        (request.headers["cf-access-authenticated-user-email"] as string) ||
        body.email ||
        (env.NODE_ENV !== "production" ? "admin@example.com" : undefined);

      if (!email) {
        return reply.status(401).send({ error: "Cloudflare Access identity required" });
      }

      const user = await userRepo.findOrCreateFromCloudflare({
        email,
        role: "OWNER",
      });

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      });
    });

    fastify.post("/api/auth/logout", async (_request, reply) => {
      return reply.send({ ok: true });
    });

    fastify.get("/api/auth/me", async (request, reply) => {
      const user = (request as unknown as { user?: SessionUser }).user;
      if (user) {
        return reply.send({ user });
      }

      const env = getEnv();
      const email =
        (request.headers["cf-access-authenticated-user-email"] as string) ||
        (request.headers["x-cf-access-user"] as string) ||
        (env.NODE_ENV !== "production" ? "admin@example.com" : undefined);

      if (!email) {
        return reply.status(401).send({ error: "Not authenticated" });
      }

      const dbUser = await userRepo.findOrCreateFromCloudflare({
        email,
        role: "OWNER",
      });

      return reply.send({
        user: {
          id: dbUser.id,
          email: dbUser.email,
          role: dbUser.role as UserRole,
          name: dbUser.name,
        },
      });
    });
  };
}
