import { z } from "zod";
import { OutboxStatusSchema } from "./enums.js";

export const OutboxEventSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid().nullable().optional(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  status: OutboxStatusSchema,
  attempts: z.number().int().default(0),
  availableAt: z.coerce.date(),
  processedAt: z.coerce.date().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;

export const EnqueueOutboxEventSchema = z.object({
  channelAccountId: z.string(),
  conversationId: z.string().uuid().optional(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  availableAt: z.coerce.date().optional(),
});
export type EnqueueOutboxEvent = z.infer<typeof EnqueueOutboxEventSchema>;
