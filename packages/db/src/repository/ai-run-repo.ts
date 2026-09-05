import { eq, desc, and, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { aiRuns } from "../schema/index.js";
import type { AiRun } from "@messenger/contracts";

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|cookie|token|secret|password|credential)/i;
const HIDDEN_REASONING_KEY_PATTERN = /^(?:internalReasoning|thinking|chainOfThought|thought|reasoning)$/i;

function cleanSnapshotString(value: string): unknown {
  const cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/(?:sk-|bearer\s+|key=)[a-zA-Z0-9_\-.]{8,}/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s@]+:[^\s@]+@/gi, "https://[REDACTED]@");

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(stripSensitiveData(parsed));
    }
  } catch {
    // Keep non-JSON provider text as text.
  }

  return cleaned.trim();
}

export function stripSensitiveData<T>(obj: T): T {
  if (typeof obj === "string") return cleanSnapshotString(obj) as T;
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => stripSensitiveData(item)) as unknown as T;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (HIDDEN_REASONING_KEY_PATTERN.test(key)) continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      cleaned[key] = "[REDACTED]";
      continue;
    }
    cleaned[key] = stripSensitiveData(value);
  }

  return cleaned as T;
}

export function sanitizeCustomerOutput(data?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  return stripSensitiveData(data);
}

export interface CreateAiRunParams {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  status: "SUCCESS" | "STALE_ABORTED" | "GUARD_REJECTED" | "ERROR";
  promptHash?: string | null;
  responseHash?: string | null;
  requestSnapshot?: Record<string, unknown> | null;
  responseSnapshot?: Record<string, unknown> | null;
  usedResult?: Record<string, unknown> | null;
  parsedOutput?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

export interface ListAiRunsParams {
  channelAccountId: string;
  conversationId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export class AiRunRepository {
  constructor(private db: Database) {}

  async createRun(params: CreateAiRunParams): Promise<AiRun> {
    const sanitizedRequest = params.requestSnapshot ? stripSensitiveData(params.requestSnapshot) : null;
    const sanitizedResponse = params.responseSnapshot ? stripSensitiveData(params.responseSnapshot) : null;
    const sanitizedUsed = params.usedResult ? sanitizeCustomerOutput(params.usedResult) : null;

    // Also ensure parsedOutput doesn't leak internalReasoning in customer output data
    let cleanParsedOutput = params.parsedOutput ? { ...params.parsedOutput } : null;
    if (cleanParsedOutput && cleanParsedOutput.data && typeof cleanParsedOutput.data === "object") {
      cleanParsedOutput = {
        ...cleanParsedOutput,
        data: sanitizeCustomerOutput(cleanParsedOutput.data as Record<string, unknown>),
      };
    }

    const [row] = await this.db
      .insert(aiRuns)
      .values({
        channelAccountId: params.channelAccountId,
        conversationId: params.conversationId,
        inboundVersion: params.inboundVersion,
        model: params.model,
        promptTokens: params.promptTokens || 0,
        completionTokens: params.completionTokens || 0,
        totalTokens: params.totalTokens || 0,
        latencyMs: params.latencyMs || 0,
        status: params.status,
        promptHash: params.promptHash || null,
        responseHash: params.responseHash || null,
        requestSnapshot: sanitizedRequest,
        responseSnapshot: sanitizedResponse,
        usedResult: sanitizedUsed,
        parsedOutput: cleanParsedOutput,
        errorMessage: params.errorMessage || null,
      })
      .returning();

    return row as AiRun;
  }

  async listRuns(params: ListAiRunsParams): Promise<{
    items: AiRun[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const limit = Math.min(Math.max(1, params.limit || 50), 100);
    const offset = Math.max(0, params.offset || 0);

    const conditions = [eq(aiRuns.channelAccountId, params.channelAccountId)];
    if (params.conversationId) {
      conditions.push(eq(aiRuns.conversationId, params.conversationId));
    }
    if (params.status && params.status !== "ALL") {
      conditions.push(eq(aiRuns.status, params.status));
    }

    const [items, totalRes] = await Promise.all([
      this.db
        .select()
        .from(aiRuns)
        .where(and(...conditions))
        .orderBy(desc(aiRuns.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(aiRuns)
        .where(and(...conditions)),
    ]);

    const total = totalRes[0]?.count || 0;
    const hasMore = offset + items.length < total;

    return {
      items: items as AiRun[],
      total,
      limit,
      offset,
      hasMore,
    };
  }

  async getRunById(channelAccountId: string, id: string): Promise<AiRun | null> {
    const [row] = await this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.channelAccountId, channelAccountId), eq(aiRuns.id, id)))
      .limit(1);

    return (row as AiRun) || null;
  }
}
