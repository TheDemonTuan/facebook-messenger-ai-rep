import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url().default("postgresql://postgres:postgres@localhost:5432/messenger_ai"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  SESSION_SECRET: z.string().min(32).default("super-secret-session-key-must-be-at-least-32-chars-long!"),
  INTERNAL_HMAC_SECRET: z.string().min(32).default("internal-hmac-secret-must-be-at-least-32-chars-long!"),
  OMNIROUTE_BASE_URL: z.string().url().default("http://127.0.0.1:8000/v1"),
  OMNIROUTE_API_KEY: z.string().default("omniroute-default-key"),
  DEFAULT_AI_MODEL: z.string().default("gemini-3.7-flash-low"),
  CLOUDFLARE_ACCESS_TEAM_NAME: z.string().optional(),
  CLOUDFLARE_ACCESS_AUD: z.string().optional(),
  DEFAULT_CHANNEL_ACCOUNT_ID: z.string().default("personal-messenger"),
  BROWSER_PROFILE_DIR: z.string().default("./browser_profile"),
  BROWSER_HEADLESS: z.preprocess((val) => val === "true" || val === true || val === "1", z.boolean()).default(true),
  NOVNC_PORT: z.coerce.number().int().default(6080),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

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
