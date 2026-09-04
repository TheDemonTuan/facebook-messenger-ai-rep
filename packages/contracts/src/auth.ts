import { z } from "zod";

export const UserRoleSchema = z.enum(["OWNER", "OPERATOR"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: UserRoleSchema,
  totpEnabled: z.boolean().default(false),
  lastLoginAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type User = z.infer<typeof UserSchema>;

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: UserRoleSchema,
  sessionId: z.string().uuid(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  totpCode: z.string().length(6).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const BootstrapAdminRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  totpSecret: z.string().optional(),
});
export type BootstrapAdminRequest = z.infer<typeof BootstrapAdminRequestSchema>;
