import { z } from "zod";
import {
  ConversationStatusSchema,
  ThreadKindSchema,
  ClassificationReliabilitySchema,
} from "./enums.js";

export const CustomerSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  externalCustomerId: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  customerId: z.string().uuid().nullable().optional(),
  externalThreadId: z.string(),
  externalThreadRef: z.string(), // Stable URL / ref for browser navigation
  status: ConversationStatusSchema,
  threadKind: ThreadKindSchema.default("UNKNOWN"),
  title: z.string().nullable().optional(),
  reliability: ClassificationReliabilitySchema.default("UNVERIFIED"),
  inboundVersion: z.number().int().nonnegative(),
  lastInboundAt: z.coerce.date().nullable(),
  lastOutboundAt: z.coerce.date().nullable(),
  summary: z.string().nullable().optional(),
  summaryVersion: z.number().int().nonnegative().default(0),
  unreadCount: z.number().int().nonnegative().default(0),
  isBlocked: z.boolean().default(false),
  manualMode: z.boolean().default(false),
  claimedAt: z.coerce.date().nullable().optional(),
  claimToken: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationWithCustomerSchema = ConversationSchema.extend({
  customer: CustomerSchema.nullable().optional(),
});
export type ConversationWithCustomer = z.infer<typeof ConversationWithCustomerSchema>;
