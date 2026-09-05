import { z } from "zod";
import { JobStatusSchema } from "./enums.js";

export const JobSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  queue: z.string().default("default"),
  jobType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  status: JobStatusSchema,
  priority: z.number().int().default(0),
  attempts: z.number().int().default(0),
  maxAttempts: z.number().int().default(3),
  availableAt: z.coerce.date(),
  lockedUntil: z.coerce.date().nullable().optional(),
  ownerToken: z.string().nullable().optional(),
  fencingEpoch: z.number().int().default(0),
  idempotencyKey: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Job = z.infer<typeof JobSchema>;

export const EnqueueJobSchema = z.object({
  channelAccountId: z.string(),
  queue: z.string().default("default"),
  jobType: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().optional().default(0),
  maxAttempts: z.number().int().optional().default(3),
  availableAt: z.coerce.date().optional(),
  idempotencyKey: z.string().optional(),
});
export type EnqueueJob = z.infer<typeof EnqueueJobSchema>;
