import crypto from "node:crypto";

function getSecretKey(): Buffer {
  const secret =
    process.env.APP_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.COOKIE_SECRET ||
    "facebook-messenger-safe-person-secret-salt-2026";
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Converts a channelAccountId and participantId into an opaque safe token.
 * Completely hides Facebook entity IDs and internal database UUIDs from normal APIs.
 */
export function toSafePersonId(channelAccountId: string, participantId: string): string {
  if (!participantId || !channelAccountId) return "";
  const key = getSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const payload = JSON.stringify([channelAccountId.trim(), participantId.trim()]);
  const enc = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const token = Buffer.concat([iv, tag, enc]).toString("base64url");
  return `ppl_${token}`;
}

/**
 * Parses and verifies an opaque safe person token.
 * Validates channelAccountId binding to prevent cross-channel tampering.
 */
export function parseSafePersonId(
  safeId: string,
  expectedChannelAccountId?: string
): { channelAccountId: string; participantId: string } | null {
  if (!safeId || typeof safeId !== "string") return null;
  const trimmed = safeId.trim();
  if (!trimmed.startsWith("ppl_")) {
    return null;
  }
  try {
    const raw = Buffer.from(trimmed.slice(4), "base64url");
    if (raw.length < 28) return null; // 12 iv + 16 tag
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const key = getSecretKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    const [chId, pId] = JSON.parse(dec);
    if (!chId || !pId) return null;
    if (expectedChannelAccountId && chId !== expectedChannelAccountId) {
      return null;
    }
    return { channelAccountId: chId, participantId: pId };
  } catch {
    return null;
  }
}

/**
 * Resolves a person ID parameter (safe token, or in test environment direct ID).
 */
export function resolveParticipantId(
  personId: string,
  channelAccountId: string
): string | null {
  if (!personId || typeof personId !== "string") return null;
  const parsed = parseSafePersonId(personId, channelAccountId);
  if (parsed) return parsed.participantId;
  if ((process.env.NODE_ENV === "test" || !personId.startsWith("ppl_")) && personId.trim().length > 0) {
    return personId.trim();
  }
  return null;
}

const SENSITIVE_ID_KEYS = new Set([
  "externalThreadId",
  "externalThreadRef",
  "externalCustomerId",
  "senderExternalId",
  "senderParticipantId",
  "participantId",
  "facebookId",
  "senderId",
]);

/**
 * Recursively sanitizes data objects destined for normal APIs (inbox, audit, queue, settings, activity),
 * stripping or masking Facebook external IDs and raw internal participant/thread IDs.
 */
export function sanitizeApiOutput<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeApiOutput(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_ID_KEYS.has(key)) {
      // Omit raw external ID from normal API response
      continue;
    }
    if (key === "payload" && value && typeof value === "object") {
      result[key] = sanitizeApiOutput(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeApiOutput(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
