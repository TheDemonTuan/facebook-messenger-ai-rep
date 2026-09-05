import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { users } from "../schema/index.js";
import type { UserRole } from "@messenger/contracts";

export interface CreateUserParams {
  email: string;
  name?: string | null;
  role?: UserRole;
}

export class UserRepository {
  constructor(private db: Database) {}

  /**
   * Idempotently resolves or creates a user authenticated via Cloudflare Access identity.
   */
  async findOrCreateFromCloudflare(identity: {
    email: string;
    name?: string | null;
    role?: UserRole;
  }): Promise<typeof users.$inferSelect> {
    const cleanEmail = identity.email.toLowerCase().trim();
    const now = new Date();

    const [user] = await this.db
      .insert(users)
      .values({
        email: cleanEmail,
        name: identity.name || null,
        role: identity.role || "OPERATOR",
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          lastSeenAt: now,
          ...(identity.name ? { name: identity.name } : {}),
          updatedAt: now,
        },
      })
      .returning();

    if (!user) {
      throw new Error(`Failed to resolve Cloudflare user for ${cleanEmail}`);
    }
    return user;
  }

  async createUser(params: CreateUserParams): Promise<typeof users.$inferSelect> {
    const [user] = await this.db
      .insert(users)
      .values({
        email: params.email.toLowerCase().trim(),
        name: params.name || null,
        role: params.role || "OPERATOR",
        lastSeenAt: new Date(),
      })
      .returning();

    if (!user) {
      throw new Error(`Failed to create user record for ${params.email}`);
    }
    return user;
  }

  async findByEmail(email: string): Promise<typeof users.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);
    return rows[0] || null;
  }

  async findById(id: string): Promise<typeof users.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0] || null;
  }

  async updateRole(id: string, role: UserRole): Promise<typeof users.$inferSelect | null> {
    const [updated] = await this.db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return updated || null;
  }

  async updateLastSeen(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async listUsers(): Promise<Array<typeof users.$inferSelect>> {
    return await this.db.select().from(users);
  }
}
