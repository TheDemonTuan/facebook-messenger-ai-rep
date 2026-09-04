import { z } from "zod";
import { OutboundActionStatusSchema, SenderActorSchema } from "./enums.js";

export const OutboundActionSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  actionId: z.string(), // sha256(channelAccountId + conversationId + inboundVersion + responseIndex)
  inboundVersion: z.number().int().nonnegative(),
  responseIndex: z.number().int().nonnegative(),
  text: z.string(),
  textHash: z.string(),
  actor: SenderActorSchema,
  status: OutboundActionStatusSchema,
  claimToken: z.string().nullable().optional(),
  fencingToken: z.number().int().nullable().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  externalMessageRef: z.string().nullable().optional(),
  unconfirmedReason: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  startedTypingAt: z.coerce.date().nullable().optional(),
  startedSendingAt: z.coerce.date().nullable().optional(),
  confirmedAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type OutboundAction = z.infer<typeof OutboundActionSchema>;

export const OutboundJobPayloadSchema = z.object({
  actionId: z.string(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  externalThreadRef: z.string(),
  inboundVersion: z.number().int().nonnegative(),
  responseIndex: z.number().int().nonnegative(),
  text: z.string(),
  textHash: z.string(),
  actor: SenderActorSchema,
  claimToken: z.string(),
  fencingToken: z.number().int(),
});
export type OutboundJobPayload = z.infer<typeof OutboundJobPayloadSchema>;
