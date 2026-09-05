import OpenAI from "openai";
import { getEnv, getEffectiveAiConfig } from "@messenger/config";

export interface AiClientConfig {
  timeoutMs?: number;
}

let cachedClient: { client: OpenAI; baseURL: string; apiKey: string; timeout: number } | null = null;

export function resetAiClientCache(): void {
  cachedClient = null;
}

export function getAiClient(config?: AiClientConfig): OpenAI {
  const env = getEnv();
  const { apiKey: rawApiKey, baseURL } = getEffectiveAiConfig(env);
  const timeout = config?.timeoutMs || 30000;

  if (env.NODE_ENV === "production" && (!rawApiKey || rawApiKey.trim() === "")) {
    throw new Error("Missing AI_API_KEY (or OMNIROUTE_API_KEY / XAI_API_KEY): Server-side AI configuration is required in production.");
  }

  const apiKey = rawApiKey || "dummy-dev-key";

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
  model?: string;
  timeoutMs?: number;
}): Promise<AiHealthCheckResult> {
  const env = getEnv();
  const { model: defaultModel } = getEffectiveAiConfig(env);
  const model = config?.model || defaultModel;
  const start = Date.now();

  let client: OpenAI;
  try {
    client = getAiClient({ timeoutMs: config?.timeoutMs });
  } catch (err: unknown) {
    const error = err as Error;
    return {
      ok: false,
      healthy: false,
      status: "unhealthy",
      model,
      latencyMs: Date.now() - start,
      message: `AI client initialization failed: ${error.message || "Unknown error"}`,
      error: error.message,
    };
  }

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
