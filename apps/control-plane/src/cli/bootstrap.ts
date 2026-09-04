import { getDb, closeDb, UserRepository, users } from "@messenger/db";
import { eq } from "drizzle-orm";
import { hashPassword, generateTotpSecret } from "../auth/session.js";

async function runBootstrap() {
  const db = getDb();
  const userRepo = new UserRepository(db);

  const args = process.argv.slice(2);
  const email = args[0] || process.env.ADMIN_EMAIL || "admin@example.com";
  const password = args[1] || process.env.ADMIN_PASSWORD || "ChangeMe123!@#";
  const enableTotp = args[2] === "--totp" || process.env.ADMIN_ENABLE_TOTP === "true";

  console.log(`Bootstrapping admin user: ${email}...`);

  const existing = await userRepo.findByEmail(email);
  if (existing) {
    console.log(`User ${email} already exists. Updating password...`);
    const passwordHash = await hashPassword(password);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, existing.id));
    console.log("Admin password updated.");
    await closeDb();
    return;
  }

  const passwordHash = await hashPassword(password);
  let totpSecret: string | null = null;

  if (enableTotp) {
    totpSecret = generateTotpSecret();
    console.log(`\n========================================`);
    console.log(`TOTP Secret: ${totpSecret}`);
    console.log(`Add this secret to your Authenticator app!`);
    console.log(`========================================\n`);
  }

  const user = await userRepo.createUser({
    email,
    passwordHash,
    role: "OWNER",
    totpSecret,
    totpEnabled: !!totpSecret,
  });
  if (!user) throw new Error("Failed to create user record");
  console.log(`✅ Admin user created successfully: ${user.email} (id: ${user.id})`);
  await closeDb();
}

runBootstrap().catch((err) => {
  console.error("❌ Admin bootstrap failed:", err);
  process.exit(1);
});
