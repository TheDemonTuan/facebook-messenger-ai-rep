import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { participants } from "../schema/index.js";
import type { SenderKind, ClassificationReliability } from "@messenger/contracts";

export interface UpsertParticipantParams {
  channelAccountId: string;
  participantId: string;
  senderKind?: SenderKind;
  reliability?: ClassificationReliability;
  isVerified?: boolean;
  profileUrl?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  verifiedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export class ParticipantRepository {
  constructor(private db: Database) {}

  async getParticipant(channelAccountId: string, participantId: string) {
    const cleanId = participantId.trim();
    const rows = await this.db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.channelAccountId, channelAccountId),
          eq(participants.participantId, cleanId)
        )
      )
      .limit(1);

    return rows[0] || null;
  }

  async upsertParticipant(params: UpsertParticipantParams) {
    const cleanId = params.participantId.trim();
    const now = new Date();
    const isVerified = params.isVerified ?? (params.reliability === "VERIFIED");
    const reliability: ClassificationReliability = params.reliability ?? (isVerified ? "VERIFIED" : "UNVERIFIED");

    const [row] = await this.db
      .insert(participants)
      .values({
        channelAccountId: params.channelAccountId,
        participantId: cleanId,
        senderKind: params.senderKind ?? "UNKNOWN",
        reliability,
        isVerified,
        profileUrl: params.profileUrl ?? null,
        displayName: params.displayName ?? null,
        avatarUrl: params.avatarUrl ?? null,
        verifiedAt: isVerified ? (params.verifiedAt ?? now) : null,
        metadata: params.metadata ?? {},
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [participants.channelAccountId, participants.participantId],
        set: {
          ...(params.senderKind ? { senderKind: params.senderKind } : {}),
          reliability,
          isVerified,
          ...(params.profileUrl !== undefined ? { profileUrl: params.profileUrl } : {}),
          ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
          ...(params.avatarUrl !== undefined ? { avatarUrl: params.avatarUrl } : {}),
          ...(isVerified ? { verifiedAt: params.verifiedAt ?? now } : {}),
          ...(params.metadata ? { metadata: params.metadata } : {}),
          updatedAt: now,
        },
      })
      .returning();

    return row!;
  }

  async listParticipants(
    channelAccountId: string,
    options?: { senderKind?: SenderKind; limit?: number; offset?: number }
  ) {
    const conditions = [eq(participants.channelAccountId, channelAccountId)];
    if (options?.senderKind) {
      conditions.push(eq(participants.senderKind, options.senderKind));
    }
    return await this.db
      .select()
      .from(participants)
      .where(and(...conditions))
      .orderBy(desc(participants.updatedAt))
      .limit(options?.limit ?? 50)
      .offset(options?.offset ?? 0);
  }

  async verifyParticipant(
    channelAccountId: string,
    participantId: string,
    senderKind: SenderKind = "PERSON"
  ) {
    return await this.upsertParticipant({
      channelAccountId,
      participantId,
      senderKind,
      reliability: "VERIFIED",
      isVerified: true,
      verifiedAt: new Date(),
    });
  }
}
