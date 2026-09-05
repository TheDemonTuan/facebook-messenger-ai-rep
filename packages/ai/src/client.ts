import OpenAI from "openai";
import { getEnv } from "@messenger/config";

export interface AiClientConfig {
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
}

let cachedClient: { client: OpenAI; baseURL: string; apiKey: string; timeout: number } | null = null;

export function getAiClient(config?: AiClientConfig): OpenAI {
  const env = getEnv();
  // Server-side xAI configuration takes precedence, fallback to omniroute / config overrides
  const baseURL = config?.baseURL || env.XAI_BASE_URL || env.OMNIROUTE_BASE_URL;
  const apiKey = config?.apiKey || env.XAI_API_KEY || env.OMNIROUTE_API_KEY;
  const timeout = config?.timeoutMs || 30000;

  if (env.NODE_ENV === "production" && (!apiKey || apiKey.trim() === "")) {
    throw new Error("Missing XAI_API_KEY: Server-side AI configuration is required in production.");
  }

  if (
    cachedClient &&
    cachedClient.baseURL === baseURL &&
    cachedClient.apiKey === apiKey &&
    cachedClient.timeout === timeout
  ) {
    return cachedClient.client;
  }

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout,
  });

  cachedClient = { client, baseURL, apiKey, timeout };
  return client;
}

export interface AiHealthCheckResult {
  ok: boolean;
  healthy: boolean;
  status: "healthy" | "unhealthy";
  message: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}

export async function checkAiHealth(config?: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}): Promise<AiHealthCheckResult> {
  const env = getEnv();
  const client = getAiClient(config);
  const model = config?.model || env.XAI_MODEL || env.DEFAULT_AI_MODEL;
  const start = Date.now();

  try {
    // Attempt smoke call or list models
    const models = await client.models.list();
    const count = models.data?.length || 0;
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      healthy: true,
      status: "healthy",
      model,
      latencyMs,
      message: `Connected to AI gateway (${count} models available)`,
    };
  } catch (err: unknown) {
    const error = err as Error;
    // If /v1/models is not supported, run a minimal completion test
    try {
      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      });
      if (completion.choices?.[0]) {
        const latencyMs = Date.now() - start;
        return {
          ok: true,
          healthy: true,
          status: "healthy",
          model,
          latencyMs,
          message: `Connected to AI gateway via smoke test (model: ${model})`,
        };
      }
    } catch (innerErr: unknown) {
      const inner = innerErr as Error;
      const latencyMs = Date.now() - start;
      return {
        ok: false,
        healthy: false,
        status: "unhealthy",
        model,
        latencyMs,
        message: `AI connection check failed: ${inner.message || error.message}`,
        error: inner.message || error.message,
      };
    }
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      healthy: false,
      status: "unhealthy",
      model,
      latencyMs,
      message: `AI connection check failed: ${error.message}`,
      error: error.message,
    };
  }
}
