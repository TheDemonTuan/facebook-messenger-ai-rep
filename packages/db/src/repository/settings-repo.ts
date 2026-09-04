import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { settings, settingRevisions } from "../schema/index.js";
import { SystemSettingsSchema, type SystemSettings } from "@messenger/contracts";

export class SettingsRepository {
  constructor(private db: Database) {}

  async getSettings(channelAccountId: string): Promise<{ settings: SystemSettings; revision: number }> {
    const rows = await this.db
      .select()
      .from(settings)
      .where(eq(settings.channelAccountId, channelAccountId))
      .limit(1);

    if (rows.length === 0 || !rows[0]) {
      // Default initial settings
      const defaultSettings = SystemSettingsSchema.parse({});
      return { settings: defaultSettings, revision: 1 };
    }

    const parsed = SystemSettingsSchema.parse(rows[0].settings);
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

      let currentRevision = 1;
      let existingSettings = SystemSettingsSchema.parse({});

      if (current.length > 0 && current[0]) {
        currentRevision = current[0].currentRevision;
        existingSettings = SystemSettingsSchema.parse(current[0].settings);
      }

      const merged = SystemSettingsSchema.parse({
        ...existingSettings,
        ...newSettings,
      });
      const nextRevision = currentRevision + 1;

      // Upsert current settings
      await tx
        .insert(settings)
        .values({
          channelAccountId,
          currentRevision: nextRevision,
          settings: merged,
        })
        .onConflictDoUpdate({
          target: settings.channelAccountId,
          set: {
            currentRevision: nextRevision,
            settings: merged,
            updatedAt: new Date(),
          },
        });

      // Record revision
      await tx.insert(settingRevisions).values({
        channelAccountId,
        revision: nextRevision,
        settings: merged,
        changedBy,
        reason: reason || null,
      });

      return { settings: merged, revision: nextRevision };
    });
  }
}
