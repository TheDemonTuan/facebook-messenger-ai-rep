import OpenAI from "openai";
import { getEnv, getEffectiveAiConfig } from "@messenger/config";
import type { AiApiFormat } from "@messenger/contracts";

export interface AiConnectionConfig {
  apiFormat: AiApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface AiCompletionResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function envConnectionConfig(timeoutMs?: number): AiConnectionConfig {
  const config = getEffectiveAiConfig(getEnv());
  return {
    apiFormat: config.apiFormat,
    baseUrl: config.baseURL,
    apiKey: config.apiKey || "dummy-dev-key",
    model: config.model,
    timeoutMs,
  };
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message || parsed.message || text;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

export async function createAiCompletion(
  config: AiConnectionConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<AiCompletionResult> {
  if (config.apiFormat === "OPENAI_COMPATIBLE") {
    const client = getAiClient({
      timeoutMs: config.timeoutMs,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
    const completion = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });
    const choice = completion.choices?.[0];
    if (!choice?.message?.content) {
      const responseError = "error" in completion ? JSON.stringify(completion.error) : "missing choices array";
      throw new Error(`AI Proxy returned unexpected format (${responseError})`);
    }
    return {
      content: choice.message.content,
      promptTokens: completion.usage?.prompt_tokens || 0,
      completionTokens: completion.usage?.completion_tokens || 0,
      totalTokens: completion.usage?.total_tokens || 0,
    };
  }

  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const anthropicMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  const response = await fetch(endpoint(config.baseUrl, "messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: config.model, max_tokens: 1024, temperature: 0.3, system, messages: anthropicMessages }),
    signal: AbortSignal.timeout(config.timeoutMs || 30000),
  });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${await readError(response)}`);

  const result = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = result.content?.filter((block) => block.type === "text").map((block) => block.text || "").join("").trim();
  if (!content) throw new Error("AI provider returned unexpected format (missing text content)");
  const promptTokens = result.usage?.input_tokens || 0;
  const completionTokens = result.usage?.output_tokens || 0;
  return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
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

export async function checkAiHealth(config?: Partial<AiConnectionConfig>): Promise<AiHealthCheckResult> {
  const effective = { ...envConnectionConfig(config?.timeoutMs), ...config } as AiConnectionConfig;
  const start = Date.now();
  try {
    await createAiCompletion(effective, [{ role: "user", content: "Reply with exactly: OK" }]);
    return {
      ok: true,
      healthy: true,
      status: "healthy",
      model: effective.model,
      latencyMs: Date.now() - start,
      message: `${effective.apiFormat === "OPENAI_COMPATIBLE" ? "OpenAI-compatible" : "Anthropic-compatible"} API is reachable`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      ok: false,
      healthy: false,
      status: "unhealthy",
      model: effective.model,
      latencyMs: Date.now() - start,
      message: "AI connection failed",
      error: message.replace(/(?:sk-|bearer\s+|key=)[a-zA-Z0-9_\-.]{10,}/gi, "[REDACTED]").slice(0, 500),
    };
  }
}

let cachedClient: { client: OpenAI; baseURL: string; apiKey: string; timeout: number } | null = null;

export function resetAiClientCache(): void {
  cachedClient = null;
}

export function getAiClient(config?: { timeoutMs?: number; baseUrl?: string; apiKey?: string }): OpenAI {
  const effective = envConnectionConfig(config?.timeoutMs);
  effective.baseUrl = config?.baseUrl || effective.baseUrl;
  effective.apiKey = config?.apiKey || effective.apiKey;
  const timeout = effective.timeoutMs || 30000;
  if (cachedClient && cachedClient.baseURL === effective.baseUrl && cachedClient.apiKey === effective.apiKey && cachedClient.timeout === timeout) {
    return cachedClient.client;
  }
  const client = new OpenAI({ baseURL: effective.baseUrl, apiKey: effective.apiKey, timeout });
  cachedClient = { client, baseURL: effective.baseUrl, apiKey: effective.apiKey, timeout };
  return client;
}
