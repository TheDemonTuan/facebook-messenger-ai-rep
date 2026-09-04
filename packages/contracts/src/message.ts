import { z } from "zod";
import { SenderActorSchema } from "./enums.js";

export const MessageDirectionSchema = z.enum(["INBOUND", "OUTBOUND"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  externalMessageId: z.string(),
  direction: MessageDirectionSchema,
  actor: SenderActorSchema,
  text: z.string(),
  textHash: z.string(),
  inboundVersion: z.number().int().nonnegative(),
  responseIndex: z.number().int().nonnegative().default(0),
  timestamp: z.coerce.date(),
  metadata: z.record(z.unknown()).optional().default({}),
  createdAt: z.coerce.date(),
});
export type Message = z.infer<typeof MessageSchema>;

export const InboundMessagePayloadSchema = z.object({
  channelAccountId: z.string(),
  externalThreadId: z.string(),
  externalThreadRef: z.string(),
  externalCustomerId: z.string(),
  customerName: z.string().nullable().optional(),
  externalMessageId: z.string(),
  text: z.string(),
  timestamp: z.coerce.date(),
});
export type InboundMessagePayload = z.infer<typeof InboundMessagePayloadSchema>;
