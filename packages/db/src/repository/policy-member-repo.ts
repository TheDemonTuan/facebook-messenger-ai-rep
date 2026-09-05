import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { replyPolicyMembers } from "../schema/index.js";

export interface AddPolicyMemberParams {
  channelAccountId: string;
  participantId: string;
  policyMode?: string; // "EXCLUDE" | "INCLUDE"
  notes?: string | null;
  addedBy?: string | null;
}

export class PolicyMemberRepository {
  constructor(private db: Database) {}

  async getMember(channelAccountId: string, participantId: string) {
    const cleanId = participantId.trim();
    const rows = await this.db
      .select()
      .from(replyPolicyMembers)
      .where(
        and(
          eq(replyPolicyMembers.channelAccountId, channelAccountId),
          eq(replyPolicyMembers.participantId, cleanId)
        )
      )
      .limit(1);
    return rows[0] || null;
  }

  async listMembers(channelAccountId: string, policyMode?: string) {
    const conditions = [eq(replyPolicyMembers.channelAccountId, channelAccountId)];
    if (policyMode) {
      conditions.push(eq(replyPolicyMembers.policyMode, policyMode));
    }
    return await this.db
      .select()
      .from(replyPolicyMembers)
      .where(and(...conditions))
      .orderBy(desc(replyPolicyMembers.createdAt));
  }

  async getMemberParticipantIds(channelAccountId: string, policyMode?: string): Promise<string[]> {
    const members = await this.listMembers(channelAccountId, policyMode);
    return members.map((m) => m.participantId);
  }

  async addMember(params: AddPolicyMemberParams) {
    const cleanId = params.participantId.trim();
    const now = new Date();
    const [row] = await this.db
      .insert(replyPolicyMembers)
      .values({
        channelAccountId: params.channelAccountId,
        participantId: cleanId,
        policyMode: params.policyMode ?? "EXCLUDE",
        notes: params.notes ?? null,
        addedBy: params.addedBy ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [replyPolicyMembers.channelAccountId, replyPolicyMembers.participantId],
        set: {
          policyMode: params.policyMode ?? "EXCLUDE",
          notes: params.notes ?? null,
          addedBy: params.addedBy ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return row!;
  }

  async removeMember(channelAccountId: string, participantId: string): Promise<boolean> {
    const cleanId = participantId.trim();
    const res = await this.db
      .delete(replyPolicyMembers)
      .where(
        and(
          eq(replyPolicyMembers.channelAccountId, channelAccountId),
          eq(replyPolicyMembers.participantId, cleanId)
        )
      )
      .returning();
    return res.length > 0;
  }

  async isMember(channelAccountId: string, participantId: string, policyMode?: string): Promise<boolean> {
    const member = await this.getMember(channelAccountId, participantId);
    if (!member) return false;
    if (policyMode && member.policyMode !== policyMode) return false;
    return true;
  }
}

// Alias for explicit naming
export const ReplyPolicyMemberRepository = PolicyMemberRepository;
