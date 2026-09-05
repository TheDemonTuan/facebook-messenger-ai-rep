import { z } from "zod";
import { TurnStatusSchema } from "./enums.js";

export const TurnSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid(),
  inboundVersion: z.number().int().nonnegative(),
  status: TurnStatusSchema,
  ownerToken: z.string().nullable().optional(),
  fencingEpoch: z.number().int().default(0),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Turn = z.infer<typeof TurnSchema>;
