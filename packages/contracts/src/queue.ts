import { z } from "zod";

export const QueueRowSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  queuedAt: z.coerce.date(),
  readyAt: z.coerce.date(),
  claimToken: z.string().nullable().optional(),
  leaseExpiresAt: z.coerce.date().nullable().optional(),
  attempt: z.number().int().nonnegative().default(0),
  continuationEligibleUntil: z.coerce.date().nullable().optional(),
  stickyTurns: z.number().int().nonnegative().default(0),
  stickyStartedAt: z.coerce.date().nullable().optional(),
  yieldRequired: z.boolean().default(false),
  inboundVersion: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type QueueRow = z.infer<typeof QueueRowSchema>;

export const QueueItemDtoSchema = z.object({
  queueId: z.string().uuid(),
  conversationId: z.string().uuid(),
  customerName: z.string().nullable(),
  queuedAt: z.coerce.date(),
  readyAt: z.coerce.date(),
  inboundVersion: z.number().int(),
  attempt: z.number().int(),
  isSticky: z.boolean(),
  stickyTurns: z.number().int(),
  yieldRequired: z.boolean(),
  position: z.number().int(),
  estimatedWaitSeconds: z.number().int(),
});
export type QueueItemDto = z.infer<typeof QueueItemDtoSchema>;
