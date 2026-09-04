import { z } from "zod";
import { IncidentTypeSchema, IncidentStatusSchema } from "./enums.js";

export const IncidentSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string(),
  conversationId: z.string().uuid().nullable().optional(),
  outboundActionId: z.string().uuid().nullable().optional(),
  type: IncidentTypeSchema,
  status: IncidentStatusSchema,
  title: z.string(),
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  resolvedAt: z.coerce.date().nullable().optional(),
  resolvedBy: z.string().nullable().optional(),
  resolutionNote: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Incident = z.infer<typeof IncidentSchema>;
