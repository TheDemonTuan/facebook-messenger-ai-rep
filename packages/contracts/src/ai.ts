import { z } from "zod";

export const AiStructuredOutputSchema = z.object({
  messages: z.array(z.string().min(1)).min(1).max(3),
  needsClarification: z.boolean().default(false),
  internalReasoning: z.string().optional(),
});
export type AiStructuredOutput = z.infer<typeof AiStructuredOutputSchema>;

export const AiRunSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  inboundVersion: z.number().int().nonnegative(),
  model: z.string(),
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  status: z.enum(["SUCCESS", "STALE_ABORTED", "GUARD_REJECTED", "ERROR"]),
  promptHash: z.string().nullable().optional(),
  responseHash: z.string().nullable().optional(),
  parsedOutput: z.record(z.string(), z.unknown()).nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type AiRun = z.infer<typeof AiRunSchema>;

export const AiDraftSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  aiRunId: z.string().uuid(),
  inboundVersion: z.number().int().nonnegative(),
  messages: z.array(z.string()),
  createdAt: z.coerce.date(),
});
export type AiDraft = z.infer<typeof AiDraftSchema>;
