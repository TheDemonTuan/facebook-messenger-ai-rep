import { eq, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { incidents, channelAccounts } from "../schema/index.js";
import type { IncidentType, IncidentStatus } from "@messenger/contracts";

export interface CreateIncidentParams {
  channelAccountId: string;
  conversationId?: string | null;
  outboundActionId?: string | null;
  type: IncidentType;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  autoSuspendChannel?: boolean;
}

export class IncidentRepository {
  constructor(private db: Database) {}

  async createIncident(params: CreateIncidentParams) {
    return await this.db.transaction(async (tx) => {
      const [incident] = await tx
        .insert(incidents)
        .values({
          channelAccountId: params.channelAccountId,
          conversationId: params.conversationId || null,
          outboundActionId: params.outboundActionId || null,
          type: params.type,
          status: "OPEN",
          title: params.title,
          description: params.description,
          metadata: params.metadata || {},
        })
        .returning();

      if (!incident) throw new Error("Failed to create incident");

      if (params.autoSuspendChannel) {
        await tx
          .update(channelAccounts)
          .set({
            isSuspended: true,
            status: "SUSPENDED",
            statusReason: `Suspended due to incident: ${params.title}`,
            updatedAt: new Date(),
          })
          .where(eq(channelAccounts.id, params.channelAccountId));
      }

      return incident;
    });
  }

  async resolveIncident(incidentId: string, resolvedBy: string, resolutionNote?: string) {
    const [incident] = await this.db
      .update(incidents)
      .set({
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedBy,
        resolutionNote: resolutionNote || null,
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, incidentId))
      .returning();

    return incident || null;
  }

  async getOpenIncidents(channelAccountId: string) {
    return await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.channelAccountId, channelAccountId))
      .orderBy(desc(incidents.createdAt));
  }
}
