import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "./schema.js";

export type TestDatabase = PGlite & {
  db: PgliteDatabase<typeof schema>;
  dispose(): Promise<void>;
};

const migrationDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));

export async function createTestDatabase(): Promise<TestDatabase> {
  const database = new PGlite();
  for (const name of (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort()) {
    await database.exec(await readFile(`${migrationDirectory}${name}`, "utf8"));
  }

  return Object.assign(database, {
    db: drizzle({ client: database, schema }),
    dispose: async () => database.close()
  });
}
