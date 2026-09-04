import OpenAI from "openai";
import { getEnv } from "@messenger/config";

let globalOpenAi: OpenAI | null = null;

export function getAiClient(): OpenAI {
  if (!globalOpenAi) {
    const env = getEnv();
    globalOpenAi = new OpenAI({
      baseURL: env.OMNIROUTE_BASE_URL,
      apiKey: env.OMNIROUTE_API_KEY,
      timeout: 30000,
    });
  }
  return globalOpenAi;
}

export async function checkAiHealth(): Promise<{ ok: boolean; message: string }> {
  const client = getAiClient();
  try {
    // Attempt smoke call or list models
    const models = await client.models.list();
    const count = models.data?.length || 0;
    return { ok: true, message: `Connected to OmniRoute gateway (${count} models available)` };
  } catch (err: unknown) {
    const error = err as Error;
    // If /v1/models is not supported, run a minimal completion test
    try {
      const completion = await client.chat.completions.create({
        model: getEnv().DEFAULT_AI_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      });
      if (completion.choices?.[0]) {
        return { ok: true, message: "Connected to OmniRoute gateway via smoke test" };
      }
    } catch (innerErr: unknown) {
      const inner = innerErr as Error;
      return { ok: false, message: `OmniRoute check failed: ${inner.message || error.message}` };
    }
    return { ok: false, message: `OmniRoute check failed: ${error.message}` };
  }
}
