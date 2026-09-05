import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { settings, settingRevisions } from "../schema/index.js";
import { SystemSettingsSchema, type SystemSettings, type ReplyMode, mergeSystemSettings } from "@messenger/contracts";
import { getEnv, getEffectiveAiConfig } from "@messenger/config";

export class SettingsRepository {
  constructor(private db: Database) {}

  private getEnvDefaults(): Partial<SystemSettings> {
    try {
      const env = getEnv();
      return {
        aiModel: getEffectiveAiConfig(env).model,
      };
    } catch {
      return {};
    }
  }

  async getSettings(channelAccountId: string): Promise<{ settings: SystemSettings; revision: number }> {
    const rows = await this.db
      .select()
      .from(settings)
      .where(eq(settings.channelAccountId, channelAccountId))
      .limit(1);

    const envDefaults = this.getEnvDefaults();

    if (rows.length === 0 || !rows[0]) {
      // Default initial settings
      const defaultSettings = SystemSettingsSchema.parse(envDefaults);
      return { settings: defaultSettings, revision: 1 };
    }

    const parsed = SystemSettingsSchema.parse({
      ...envDefaults,
      ...rows[0].settings,
    });
    return {
      settings: parsed,
      revision: rows[0].currentRevision,
    };
  }

  async updateSettings(
    channelAccountId: string,
    newSettings: Partial<SystemSettings>,
    changedBy: string,
    reason?: string
  ): Promise<{ settings: SystemSettings; revision: number }> {
    return await this.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(settings)
        .where(eq(settings.channelAccountId, channelAccountId))
        .limit(1);

      const envDefaults = this.getEnvDefaults();
      let currentRevision = 1;
      let existingSettings = SystemSettingsSchema.parse(envDefaults);

      if (current.length > 0 && current[0]) {
        currentRevision = current[0].currentRevision + 1;
        existingSettings = SystemSettingsSchema.parse({
          ...envDefaults,
          ...current[0].settings,
        });
      }

      // Merge and validate using mergeSystemSettings to preserve existing customized settings
      const mergedSettings = mergeSystemSettings(existingSettings, newSettings);

      // Upsert settings
      await tx
        .insert(settings)
        .values({
          channelAccountId,
          currentRevision,
          settings: mergedSettings,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: settings.channelAccountId,
          set: {
            currentRevision,
            settings: mergedSettings,
            updatedAt: new Date(),
          },
        });

      // Record setting revision
      await tx.insert(settingRevisions).values({
        channelAccountId,
        revision: currentRevision,
        settings: mergedSettings,
        changedBy,
        reason: reason || null,
      });

      return {
        settings: mergedSettings,
        revision: currentRevision,
      };
    });
  }

  async getRevisions(channelAccountId: string, limit = 20) {
    return await this.db
      .select()
      .from(settingRevisions)
      .where(eq(settingRevisions.channelAccountId, channelAccountId))
      .orderBy(settingRevisions.revision)
      .limit(limit);
  }

  async getReplyPolicySettings(channelAccountId: string) {
    const { settings, revision } = await this.getSettings(channelAccountId);
    return {
      revision,
      autoReplyEnabled: settings.autoReplyEnabled,
      pauseIntakeProcessing: settings.pauseIntakeProcessing,
      replyMode: settings.replyMode,
      directRepliesEnabled: settings.directRepliesEnabled,
      groupRepliesEnabled: settings.groupRepliesEnabled,
      pageRepliesEnabled: settings.pageRepliesEnabled,
      nonPersonRepliesEnabled: settings.nonPersonRepliesEnabled,
      requireGroupMention: settings.requireGroupMention,
      selectedParticipantIds: settings.selectedParticipantIds,
      excludedParticipantIds: settings.excludedParticipantIds,
    };
  }

  async updateReplyPolicySettings(
    channelAccountId: string,
    replySettings: Partial<{
      replyMode: ReplyMode;
      directRepliesEnabled: boolean;
      groupRepliesEnabled: boolean;
      pageRepliesEnabled: boolean;
      nonPersonRepliesEnabled: boolean;
      requireGroupMention: boolean;
      selectedParticipantIds: string[];
      excludedParticipantIds: string[];
      autoReplyEnabled: boolean;
      pauseIntakeProcessing: boolean;
    }>,
    changedBy: string,
    reason?: string
  ) {
    return await this.updateSettings(channelAccountId, replySettings, changedBy, reason);
  }
}
