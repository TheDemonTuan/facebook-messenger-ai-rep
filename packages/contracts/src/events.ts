import { z } from "zod";
import { EventTypeSchema } from "./enums.js";

export const ConversationEventSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid().nullable().optional(),
  type: EventTypeSchema,
  inboundVersion: z.number().int().nonnegative().nullable().optional(),
  actor: z.string().default("SYSTEM"),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
});
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

export const SseEventEnvelopeSchema = z.object({
  id: z.string(),
  event: z.string(),
  data: z.record(z.unknown()),
  timestamp: z.number(),
});
export type SseEventEnvelope = z.infer<typeof SseEventEnvelopeSchema>;
