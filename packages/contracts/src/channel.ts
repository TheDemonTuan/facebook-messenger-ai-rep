import { z } from "zod";
import { ChannelStatusSchema } from "./enums.js";

export const ChannelAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["PERSONAL_MESSENGER", "FACEBOOK_PAGE"]),
  status: ChannelStatusSchema,
  statusReason: z.string().nullable().optional(),
  lastHealthCheckAt: z.coerce.date().nullable().optional(),
  lastSeenActiveAt: z.coerce.date().nullable().optional(),
  isSuspended: z.boolean().default(false),
  isPaused: z.boolean().default(false),
  activeTurnId: z.string().uuid().nullable().optional(),
  currentOwnerToken: z.string().nullable().optional(),
  leaseExpiresAt: z.coerce.date().nullable().optional(),
  fencingEpoch: z.number().int().default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ChannelAccount = z.infer<typeof ChannelAccountSchema>;

export const ChannelHealthReportSchema = z.object({
  healthy: z.boolean(),
  status: ChannelStatusSchema,
  domOk: z.boolean(),
  sessionActive: z.boolean(),
  checkpointDetected: z.boolean(),
  rateLimitDetected: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  timestamp: z.coerce.date(),
});
export type ChannelHealthReport = z.infer<typeof ChannelHealthReportSchema>;

export const ActiveConversationRefSchema = z.object({
  externalThreadId: z.string(),
  externalThreadRef: z.string(),
  externalCustomerId: z.string(),
  customerName: z.string().nullable().optional(),
});
export type ActiveConversationRef = z.infer<typeof ActiveConversationRefSchema>;
