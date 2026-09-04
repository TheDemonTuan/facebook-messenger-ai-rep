import argon2 from "argon2";
import { generateSecret, verifySync } from "otplib";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRepository } from "@messenger/db";
import type { SessionUser } from "@messenger/contracts";

export async function hashPassword(plain: string): Promise<string> {
  return await argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function generateTotpSecret(): string {
  return generateSecret();
}

export function verifyTotpToken(secret: string, token: string): boolean {
  try {
    return verifySync({ secret, token }).valid;
  } catch {
    return false;
  }
}

export function createAuthMiddleware(userRepo: UserRepository) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
    const sessionToken = request.cookies["session_token"];
    if (!sessionToken) {
      reply.status(401).send({ error: "Authentication required" });
      return null;
    }

    const validated = await userRepo.validateSession(sessionToken);
    if (!validated) {
      reply.clearCookie("session_token");
      reply.status(401).send({ error: "Session expired or invalid" });
      return null;
    }

    const sessionUser: SessionUser = {
      id: validated.user.id,
      email: validated.user.email,
      role: validated.user.role as "OWNER" | "OPERATOR",
      sessionId: validated.session.id,
    };

    // Attach to request
    (request as unknown as { user: SessionUser }).user = sessionUser;
    return sessionUser;
  };
}
