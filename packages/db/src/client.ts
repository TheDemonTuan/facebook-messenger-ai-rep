import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { getEnv } from "@messenger/config";

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Sql = postgres.Sql;

let globalSql: postgres.Sql | null = null;
let globalDb: Database | null = null;

export function getDb(connectionString?: string): Database {
  if (!globalDb) {
    const url = connectionString || getEnv().DATABASE_URL;
    globalSql = postgres(url, { max: 10 });
    globalDb = drizzle(globalSql, { schema });
  }
  return globalDb;
}

export function getSql(connectionString?: string): postgres.Sql {
  if (!globalSql) {
    const url = connectionString || getEnv().DATABASE_URL;
    globalSql = postgres(url, { max: 10 });
  }
  return globalSql;
}

export async function closeDb(): Promise<void> {
  if (globalSql) {
    await globalSql.end();
    globalSql = null;
    globalDb = null;
  }
}
