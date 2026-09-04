import { createRemoteJWKSet, jwtVerify } from "jose";
import { getEnv } from "@messenger/config";
import type { FastifyRequest, FastifyReply } from "fastify";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyCloudflareAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const env = getEnv();
  const isProduction = process.env.NODE_ENV === "production" || env.NODE_ENV === "production";

  // In production, enforce Cloudflare Access fail-closed
  if (isProduction) {
    const token = request.headers["cf-access-jwt-assertion"] as string | undefined;

    // If AUD & Team Name are configured, verify cryptographic JWT assertion
    if (env.CLOUDFLARE_ACCESS_AUD && env.CLOUDFLARE_ACCESS_TEAM_NAME) {
      if (!token) {
        reply.status(401).send({ error: "Missing Cloudflare Access assertion header" });
        return false;
      }

      if (!jwks) {
        const certsUrl = new URL(`https://${env.CLOUDFLARE_ACCESS_TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/certs`);
        jwks = createRemoteJWKSet(certsUrl);
      }

      try {
        const { payload } = await jwtVerify(token, jwks, {
          audience: env.CLOUDFLARE_ACCESS_AUD,
          issuer: `https://${env.CLOUDFLARE_ACCESS_TEAM_NAME}.cloudflareaccess.com`,
        });

        const email = (payload.email as string) || (payload.sub as string);
        request.headers["x-cf-access-user"] = email;
        return true;
      } catch (err) {
        console.warn("[CloudflareAccess] Invalid JWT assertion:", (err as Error).message);
        reply.status(403).send({ error: "Invalid Cloudflare Access credentials" });
        return false;
      }
    }

    // If AUD is not set but in production, fail-closed unless cf-access-authenticated-user-email is provided
    const emailHeader = request.headers["cf-access-authenticated-user-email"] as string | undefined;
    if (!token && !emailHeader) {
      reply.status(401).send({ error: "Missing Cloudflare Access assertion header" });
      return false;
    }

    if (emailHeader) {
      request.headers["x-cf-access-user"] = emailHeader;
      return true;
    }
  }

  // Local development / testing mode
  const devEmail =
    (request.headers["cf-access-authenticated-user-email"] as string) ||
    (request.headers["x-cf-access-user"] as string) ||
    (request.headers["x-dev-user-email"] as string) ||
    "admin@example.com";

  request.headers["x-cf-access-user"] = devEmail;
  return true;
}
