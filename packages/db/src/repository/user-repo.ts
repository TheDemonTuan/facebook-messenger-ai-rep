import { eq, and, gt } from "drizzle-orm";
import type { Database } from "../client.js";
import { users, sessions } from "../schema/index.js";
import { createHash } from "node:crypto";

export interface CreateUserParams {
  email: string;
  passwordHash: string;
  role?: "OWNER" | "OPERATOR";
  totpSecret?: string | null;
  totpEnabled?: boolean;
  recoveryCodes?: string[];
}

export class UserRepository {
  constructor(private db: Database) {}

  async createUser(params: CreateUserParams) {
    const [user] = await this.db
      .insert(users)
      .values({
        email: params.email.toLowerCase().trim(),
        passwordHash: params.passwordHash,
        role: params.role || "OWNER",
        totpSecret: params.totpSecret || null,
        totpEnabled: params.totpEnabled ?? false,
        recoveryCodes: params.recoveryCodes || [],
      })
      .returning();
    return user;
  }

  async findByEmail(email: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);
    return rows[0] || null;
  }

  async findById(id: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0] || null;
  }

  async updateLastLogin(id: string) {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async createSession(userId: string, token: string, expiresAt: Date, ipAddress?: string, userAgent?: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const [session] = await this.db
      .insert(sessions)
      .values({
        userId,
        tokenHash,
        expiresAt,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
      })
      .returning();
    return session;
  }

  async validateSession(token: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date();
    const rows = await this.db
      .select({
        session: sessions,
        user: users,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now)
        )
      )
      .limit(1);

    return rows[0] || null;
  }

  async revokeSession(sessionId: string) {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async revokeAllUserSessions(userId: string) {
    await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }
}
