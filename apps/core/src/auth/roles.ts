import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRole, SessionUser } from "@messenger/contracts";

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  OWNER: 3,
};

export function hasRolePermission(userRole: UserRole, requiredRole: UserRole): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
  return userLevel >= requiredLevel;
}

export function requireRole(minRole: UserRole) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const user = (request as unknown as { user?: SessionUser }).user;
    if (!user) {
      reply.status(401).send({ error: "Authentication required" });
      return false;
    }

    if (!hasRolePermission(user.role, minRole)) {
      reply.status(403).send({
        error: "Forbidden: insufficient role permissions",
        requiredRole: minRole,
        currentRole: user.role,
      });
      return false;
    }

    return true;
  };
}

export const requireOperator = requireRole("OPERATOR");
export const requireOwner = requireRole("OWNER");
