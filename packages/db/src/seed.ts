import { getDb, closeDb } from "./client.js";
import { channelAccounts, settings, settingRevisions, users } from "./schema/index.js";
import { SystemSettingsSchema } from "@messenger/contracts";
import { getEnv, getEffectiveAiConfig } from "@messenger/config";

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

  // 2. Ensure initial settings exist (server-side AI only)
  const { model: defaultAiModel } = getEffectiveAiConfig(env);
  const defaultSettings = SystemSettingsSchema.parse({
    aiModel: defaultAiModel,
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

  // 3. Bootstrap the explicitly configured Cloudflare identity only.
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (adminEmail) {
    await db
      .insert(users)
      .values({
        email: adminEmail,
        name: "Default Admin",
        role: "OWNER",
      })
      .onConflictDoNothing();
  } else if (env.NODE_ENV === "production") {
    throw new Error("ADMIN_EMAIL is required to bootstrap the production OWNER identity");
  }

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
