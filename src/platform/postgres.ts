import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";

import type { SqlTransaction, TransactionalDatabase } from "./database.js";

export type ProductionDatabase = TransactionalDatabase & Readonly<{
  migrate(): Promise<void>;
  close(): Promise<void>;
}>;

const migrationId = "0000_league_core";
const migrationUrl = new URL("./migrations/0000_league_core.sql", import.meta.url);

/** Creates the PostgreSQL transaction adapter used by the production composition root. */
export function createDatabase(databaseUrl: string): ProductionDatabase {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    transaction: async (work) => transaction(pool, work),
    migrate: async () => migrate(pool),
    close: async () => pool.end()
  };
}

async function transaction<T>(pool: Pool, work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(toTransaction(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hybrid_league_core_migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS hybrid_schema_migrations (
         id TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    const applied = await client.query<{ id: string }>(
      "SELECT id FROM hybrid_schema_migrations WHERE id = $1 FOR UPDATE",
      [migrationId]
    );

    if (!applied.rows[0]) {
      await client.query(await readFile(migrationUrl, "utf8"));
      await client.query("INSERT INTO hybrid_schema_migrations (id) VALUES ($1)", [migrationId]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toTransaction(client: PoolClient): SqlTransaction {
  return {
    query: async <T extends Record<string, unknown>>(statement: string, parameters?: unknown[]) => {
      const result = await client.query(statement, parameters);
      return { rows: result.rows as T[] };
    }
  };
}
