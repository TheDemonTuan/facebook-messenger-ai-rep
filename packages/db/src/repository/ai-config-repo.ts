import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AiApiFormat } from "@messenger/contracts";
import { AiApiFormatSchema, isValidAiBaseUrl, isValidAiModel } from "@messenger/contracts";
import { getEffectiveAiConfig, getEnv } from "@messenger/config";
import type { Database } from "../client.js";
import { aiProviderConfigs } from "../schema/index.js";

export interface AiProviderConfig {
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface PublicAiProviderConfig {
  apiFormat: AiApiFormat;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

function encryptionKey(): Buffer {
  const env = getEnv();
  const secret = env.AI_CONFIG_ENCRYPTION_KEY || (env.NODE_ENV === "test" ? env.SESSION_SECRET : undefined);
  if (!secret) throw new Error("AI_CONFIG_ENCRYPTION_KEY is required to store AI credentials");
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string): string {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part || "", "base64url"));
  if (!iv || !tag || !encrypted) throw new Error("Stored AI credential is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export class AiConfigRepository {
  constructor(private db: Database) {}

  private envConfig(): AiProviderConfig {
    const config = getEffectiveAiConfig(getEnv());
    return {
      apiFormat: config.apiFormat,
      baseUrl: config.baseURL,
      model: config.model,
      apiKey: config.apiKey,
    };
  }

  async getConfig(channelAccountId: string): Promise<AiProviderConfig> {
    let row: typeof aiProviderConfigs.$inferSelect | undefined;
    try {
      [row] = await this.db
        .select()
        .from(aiProviderConfigs)
        .where(eq(aiProviderConfigs.channelAccountId, channelAccountId))
        .limit(1);
    } catch {
      return this.envConfig();
    }

    if (
      !row ||
      !AiApiFormatSchema.safeParse(row.apiFormat).success ||
      typeof row.baseUrl !== "string" ||
      typeof row.model !== "string" ||
      typeof row.encryptedApiKey !== "string"
    ) {
      return this.envConfig();
    }

    return {
      apiFormat: AiApiFormatSchema.parse(row.apiFormat),
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey: decrypt(row.encryptedApiKey),
    };
  }

  async getPublicConfig(channelAccountId: string): Promise<PublicAiProviderConfig> {
    const config = await this.getConfig(channelAccountId);
    return {
      apiFormat: config.apiFormat,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyConfigured: Boolean(config.apiKey),
    };
  }

  async saveConfig(
    channelAccountId: string,
    input: { apiFormat: AiApiFormat; baseUrl: string; model: string; apiKey?: string },
    changedBy: string
  ): Promise<PublicAiProviderConfig> {
    const apiFormat = AiApiFormatSchema.parse(input.apiFormat);
    const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
    const model = input.model.trim();
    if (!isValidAiBaseUrl(baseUrl)) throw new Error("Invalid AI Base URL");
    if (!isValidAiModel(model)) throw new Error("Invalid AI model name");

    const [current] = await this.db
      .select()
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.channelAccountId, channelAccountId))
      .limit(1);
    const apiKey = input.apiKey?.trim();
    const encryptedApiKey = apiKey ? encrypt(apiKey) : current?.encryptedApiKey;
    if (!encryptedApiKey) throw new Error("API key is required");

    await this.db
      .insert(aiProviderConfigs)
      .values({ channelAccountId, apiFormat, baseUrl, model, encryptedApiKey, changedBy })
      .onConflictDoUpdate({
        target: aiProviderConfigs.channelAccountId,
        set: { apiFormat, baseUrl, model, encryptedApiKey, changedBy, updatedAt: new Date() },
      });

    return { apiFormat, baseUrl, model, apiKeyConfigured: true };
  }
}
