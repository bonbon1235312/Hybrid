import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "./schema.js";

export type TestDatabase = PGlite & {
  db: PgliteDatabase<typeof schema>;
  dispose(): Promise<void>;
};

const migrationPath = fileURLToPath(new URL("./migrations/0000_league_core.sql", import.meta.url));

export async function createTestDatabase(): Promise<TestDatabase> {
  const database = new PGlite();
  const migration = await readFile(migrationPath, "utf8");

  await database.exec(migration);

  return Object.assign(database, {
    db: drizzle({ client: database, schema }),
    dispose: async () => database.close()
  });
}
