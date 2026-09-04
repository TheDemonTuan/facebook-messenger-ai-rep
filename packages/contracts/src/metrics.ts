import { z } from "zod";
import { ChannelStatusSchema } from "./enums.js";

export const SystemMetricsSummarySchema = z.object({
  channelStatus: ChannelStatusSchema,
  channelIsSuspended: z.boolean(),
  channelIsPaused: z.boolean(),
  currentConversationId: z.string().uuid().nullable(),
  currentCustomerName: z.string().nullable(),
  queueLength: z.number().int().nonnegative(),
  oldestWaitSeconds: z.number().int().nonnegative(),
  estimatedWaitSeconds: z.number().int().nonnegative(),
  todayConversationsCount: z.number().int().nonnegative(),
  todayMessagesCount: z.number().int().nonnegative(),
  averageAiLatencyMs: z.number().nonnegative(),
  averageSendLatencyMs: z.number().nonnegative(),
  errorCountLastHour: z.number().int().nonnegative(),
  incidentCountOpen: z.number().int().nonnegative(),
  timestamp: z.coerce.date(),
});
export type SystemMetricsSummary = z.infer<typeof SystemMetricsSummarySchema>;
