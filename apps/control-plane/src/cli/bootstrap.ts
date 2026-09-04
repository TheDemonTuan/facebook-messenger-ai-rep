import { getDb, closeDb, UserRepository } from "@messenger/db";

async function runBootstrap() {
  const db = getDb();
  const userRepo = new UserRepository(db);

  const args = process.argv.slice(2);
  const email = args[0] || process.env.ADMIN_EMAIL || "admin@example.com";
  const name = args[1] || "Administrator";

  console.log(`Bootstrapping Cloudflare Access admin user: ${email}...`);

  const user = await userRepo.findOrCreateFromCloudflare({
    email,
    name,
    role: "OWNER",
  });

  console.log(`✅ Admin user created/updated successfully: ${user.email} (id: ${user.id}, role: ${user.role})`);
  await closeDb();
}

runBootstrap().catch((err) => {
  console.error("❌ Admin bootstrap failed:", err);
  process.exit(1);
});
