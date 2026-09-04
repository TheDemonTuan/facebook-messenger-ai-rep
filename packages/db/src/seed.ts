import { getDb, closeDb } from "./client.js";
import { channelAccounts, settings, settingRevisions, users } from "./schema/index.js";
import { SystemSettingsSchema } from "@messenger/contracts";
import { getEnv } from "@messenger/config";

export async function seedDatabase(channelAccountId?: string) {
  const env = getEnv();
  const db = getDb();
  const accountId = channelAccountId || env.DEFAULT_CHANNEL_ACCOUNT_ID;

  console.log(`Seeding channel account: ${accountId}...`);

  // 1. Ensure channel account exists
  await db
    .insert(channelAccounts)
    .values({
      id: accountId,
      name: "Personal Facebook Messenger",
      type: "PERSONAL_MESSENGER",
      status: "RUNNING",
      isSuspended: false,
      isPaused: false,
    })
    .onConflictDoNothing();

  // 2. Ensure initial settings exist (without any API key)
  const defaultSettings = SystemSettingsSchema.parse({
    aiBaseUrl: env.XAI_BASE_URL || env.OMNIROUTE_BASE_URL,
    aiModel: env.XAI_MODEL || env.DEFAULT_AI_MODEL,
  });
  const existing = await db.query.settings.findFirst({
    where: (t, { eq }) => eq(t.channelAccountId, accountId),
  });

  if (!existing) {
    await db.insert(settings).values({
      channelAccountId: accountId,
      currentRevision: 1,
      settings: defaultSettings,
    });

    await db.insert(settingRevisions).values({
      channelAccountId: accountId,
      revision: 1,
      settings: defaultSettings,
      changedBy: "SYSTEM_SEED",
      reason: "Initial baseline settings",
    });
  }

  // 3. Ensure default admin user exists
  await db
    .insert(users)
    .values({
      email: "admin@example.com",
      name: "Default Admin",
      role: "OWNER",
    })
    .onConflictDoNothing();

  console.log("✅ Seed completed successfully.");
}

// Run directly if invoked as script
if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  seedDatabase()
    .then(() => closeDb())
    .catch((err) => {
      console.error("❌ Seed failed:", err);
      process.exit(1);
    });
}
