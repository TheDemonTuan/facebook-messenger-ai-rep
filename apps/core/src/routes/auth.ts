import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { UserRepository } from "@messenger/db";
import type { SessionUser } from "@messenger/contracts";

export interface AuthRoutesOptions {
  userRepo: UserRepository;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<SessionUser | null>;
}

export function createAuthRoutes(options: AuthRoutesOptions): FastifyPluginAsync {
  const { requireAuth } = options;

  return async function (fastify) {
    // Current authenticated user
    fastify.get("/api/auth/me", async (request, reply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;
      return reply.send({ user });
    });

    // Cloudflare identity confirmation (no password or session cookies)
    fastify.post("/api/auth/login", async (request, reply) => {
      const user = await requireAuth(request, reply);
      if (!user) return;
      return reply.send({
        success: true,
        user,
      });
    });

    fastify.post("/api/auth/logout", async (_request, reply) => {
      return reply.send({ ok: true });
    });
  };
}
