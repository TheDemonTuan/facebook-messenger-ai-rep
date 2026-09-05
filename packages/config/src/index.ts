import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().url().default("postgresql://postgres:postgres@localhost:5432/messenger_ai"),
    SESSION_SECRET: z.string().min(32).default("super-secret-session-key-must-be-at-least-32-chars-long!"),
    INTERNAL_HMAC_SECRET: z.string().min(32).default("internal-hmac-secret-must-be-at-least-32-chars-long!"),
    // AI Gateway & Custom LLM configuration (OmniRoute, OpenAI, Grok, etc.)
    AI_API_KEY: z.string().optional(),
    AI_BASE_URL: z.string().url().optional(),
    AI_MODEL: z.string().optional(),
    AI_API_FORMAT: z.enum(["OPENAI_COMPATIBLE", "ANTHROPIC_COMPATIBLE"]).default("OPENAI_COMPATIBLE"),
    AI_CONFIG_ENCRYPTION_KEY: z.string().min(32).optional(),
    OMNIROUTE_API_KEY: z.string().optional(),
    OMNIROUTE_BASE_URL: z.string().url().optional(),
    DEFAULT_AI_MODEL: z.string().optional(),
    // Backward-compatible xAI configuration
    XAI_API_KEY: z.string().optional(),
    XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
    XAI_MODEL: z.string().default("grok-4.5"),
    CLOUDFLARE_ACCESS_TEAM_NAME: z.string().optional(),
    CLOUDFLARE_ACCESS_AUD: z.string().optional(),
    ADMIN_EMAIL: z.string().trim().email().optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
    DEFAULT_CHANNEL_ACCOUNT_ID: z.string().default("personal-messenger"),
    BROWSER_PROFILE_DIR: z.string().default("./browser_profile"),
    BROWSER_HEADLESS: z.preprocess((val) => val === "true" || val === true || val === "1", z.boolean()).default(true),
    NOVNC_PORT: z.coerce.number().int().default(6080),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  });

export type Env = z.infer<typeof EnvSchema>;

export function getEffectiveAiConfig(env: Env): {
  apiKey: string;
  baseURL: string;
  model: string;
  apiFormat: "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE";
} {
  const apiKey = env.AI_API_KEY?.trim() || env.OMNIROUTE_API_KEY?.trim() || env.XAI_API_KEY?.trim() || "";
  const baseURL = env.AI_BASE_URL || env.OMNIROUTE_BASE_URL || env.XAI_BASE_URL || "https://api.openai.com/v1";
  const model = env.AI_MODEL || env.DEFAULT_AI_MODEL || env.XAI_MODEL || "auto/best-chat";
  return { apiKey, baseURL, model, apiFormat: env.AI_API_FORMAT };
}

export function validateCoreProductionEnv(env: Env): void {
  if (env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  const aiKey = env.AI_API_KEY?.trim() || env.OMNIROUTE_API_KEY?.trim() || env.XAI_API_KEY?.trim();
  if (!aiKey) missing.push("AI_API_KEY (or OMNIROUTE_API_KEY / XAI_API_KEY)");
  if (!env.CLOUDFLARE_ACCESS_TEAM_NAME?.trim()) missing.push("CLOUDFLARE_ACCESS_TEAM_NAME");
  if (!env.CLOUDFLARE_ACCESS_AUD?.trim()) missing.push("CLOUDFLARE_ACCESS_AUD");
  if (!env.ADMIN_EMAIL) missing.push("ADMIN_EMAIL");

  if (missing.length > 0) {
    throw new Error(`Missing required production core configuration: ${missing.join(", ")}`);
  }
}

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment variables:", JSON.stringify(parsed.error.format(), null, 2));
    throw new Error("Invalid environment configuration. Aborting startup.");
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}
