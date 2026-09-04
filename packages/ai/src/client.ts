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
  const baseURL = config?.baseURL || env.OMNIROUTE_BASE_URL;
  const apiKey = config?.apiKey || env.OMNIROUTE_API_KEY;
  const timeout = config?.timeoutMs || 30000;

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

export async function checkAiHealth(config?: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; message: string }> {
  const client = getAiClient(config);
  const model = config?.model || getEnv().DEFAULT_AI_MODEL;
  try {
    // Attempt smoke call or list models
    const models = await client.models.list();
    const count = models.data?.length || 0;
    return { ok: true, message: `Connected to AI gateway (${count} models available)` };
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
        return { ok: true, message: `Connected to AI gateway via smoke test (model: ${model})` };
      }
    } catch (innerErr: unknown) {
      const inner = innerErr as Error;
      return { ok: false, message: `AI connection check failed: ${inner.message || error.message}` };
    }
    return { ok: false, message: `AI connection check failed: ${error.message}` };
  }
}
