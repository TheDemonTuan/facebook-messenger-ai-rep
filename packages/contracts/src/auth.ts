import { z } from "zod";
import { UserRoleSchema } from "./enums.js";

export { UserRoleSchema };
export type { UserRole } from "./enums.js";

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable().optional(),
  role: UserRoleSchema,
  lastSeenAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type User = z.infer<typeof UserSchema>;

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: UserRoleSchema,
  name: z.string().nullable().optional(),
  sessionId: z.string().optional(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const CloudflareIdentitySchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  role: UserRoleSchema.default("OPERATOR"),
});
export type CloudflareIdentity = z.infer<typeof CloudflareIdentitySchema>;

export const BootstrapAdminRequestSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  role: UserRoleSchema.default("OWNER"),
});
export type BootstrapAdminRequest = z.infer<typeof BootstrapAdminRequestSchema>;
