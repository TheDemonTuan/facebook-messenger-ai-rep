import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, getSql, closeDb } from "./client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runMigrations() {
  const db = getDb();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(__dirname, "../migrations");

  console.log(`Running database migrations from ${migrationsFolder}...`);
  await migrate(db, { migrationsFolder });
  console.log("✅ Migrations applied successfully.");
}

// Run directly if invoked as script
if (process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  runMigrations()
    .then(() => closeDb())
    .catch((err) => {
      console.error("❌ Migration failed:", err);
      process.exit(1);
    });
}
