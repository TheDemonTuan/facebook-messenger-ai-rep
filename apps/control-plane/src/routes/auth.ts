import type { FastifyPluginAsync } from "fastify";
import type { UserRepository } from "@messenger/db";
import { LoginRequestSchema } from "@messenger/contracts";
import { verifyPassword, verifyTotpToken } from "../auth/session.js";
import { randomBytes } from "node:crypto";

export function createAuthRoutes(userRepo: UserRepository): FastifyPluginAsync {
  return async function (fastify) {
    fastify.post("/api/auth/login", async (request, reply) => {
      const parsed = LoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid login payload" });
      }

      const { email, password, totpCode } = parsed.data;
      const user = await userRepo.findByEmail(email);
      if (!user) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const passwordValid = await verifyPassword(user.passwordHash, password);
      if (!passwordValid) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      // Check TOTP if enabled
      if (user.totpEnabled) {
        if (!totpCode) {
          return reply.send({ requiresTotp: true });
        }
        if (!user.totpSecret || !verifyTotpToken(user.totpSecret, totpCode)) {
          return reply.status(401).send({ error: "Invalid TOTP verification code" });
        }
      }

      // Create session
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await userRepo.createSession(
        user.id,
        token,
        expiresAt,
        request.ip,
        request.headers["user-agent"]
      );
      await userRepo.updateLastLogin(user.id);

      reply.setCookie("session_token", token, {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        expires: expiresAt,
      });

      return reply.send({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      });
    });

    fastify.post("/api/auth/logout", async (request, reply) => {
      const token = request.cookies["session_token"];
      if (token) {
        const validated = await userRepo.validateSession(token);
        if (validated) {
          await userRepo.revokeSession(validated.session.id);
        }
      }
      reply.clearCookie("session_token", { path: "/" });
      return reply.send({ success: true });
    });

    fastify.get("/api/auth/me", async (request, reply) => {
      const token = request.cookies["session_token"];
      if (!token) {
        return reply.status(401).send({ error: "Not authenticated" });
      }
      const validated = await userRepo.validateSession(token);
      if (!validated) {
        reply.clearCookie("session_token", { path: "/" });
        return reply.status(401).send({ error: "Session expired" });
      }
      return reply.send({
        user: {
          id: validated.user.id,
          email: validated.user.email,
          role: validated.user.role,
        },
      });
    });
  };
}
