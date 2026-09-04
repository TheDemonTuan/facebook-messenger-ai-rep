import { createRemoteJWKSet, jwtVerify } from "jose";
import { getEnv } from "@messenger/config";
import type { FastifyRequest, FastifyReply } from "fastify";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyCloudflareAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const env = getEnv();

  // In local development or if Cloudflare Access is not configured, allow bypass
  if (env.NODE_ENV !== "production" || !env.CLOUDFLARE_ACCESS_AUD || !env.CLOUDFLARE_ACCESS_TEAM_NAME) {
    return true;
  }

  const token = request.headers["cf-access-jwt-assertion"] as string | undefined;
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

    // Store CF identity in request context
    request.headers["x-cf-access-user"] = (payload.email as string) || (payload.sub as string);
    return true;
  } catch (err) {
    console.warn("Invalid Cloudflare Access JWT:", (err as Error).message);
    reply.status(403).send({ error: "Invalid Cloudflare Access credentials" });
    return false;
  }
}
