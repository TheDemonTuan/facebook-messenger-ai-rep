import { eq, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { conversationEvents } from "../schema/index.js";
import type { EventType } from "@messenger/contracts";

export interface RecordEventParams {
  channelAccountId: string;
  conversationId?: string | null;
  type: EventType;
  inboundVersion?: number | null;
  actor?: string;
  payload?: Record<string, unknown>;
}

export class EventRepository {
  constructor(private db: Database) {}

  async recordEvent(params: RecordEventParams) {
    const [event] = await this.db
      .insert(conversationEvents)
      .values({
        channelAccountId: params.channelAccountId,
        conversationId: params.conversationId || null,
        type: params.type,
        inboundVersion: params.inboundVersion || null,
        actor: params.actor || "SYSTEM",
        payload: params.payload || {},
      })
      .returning();

    return event;
  }

  async getRecentEvents(conversationId?: string, limit = 50) {
    const query = this.db.select().from(conversationEvents);
    if (conversationId) {
      return await query
        .where(eq(conversationEvents.conversationId, conversationId))
        .orderBy(desc(conversationEvents.createdAt))
        .limit(limit);
    }
    return await query.orderBy(desc(conversationEvents.createdAt)).limit(limit);
  }
}
