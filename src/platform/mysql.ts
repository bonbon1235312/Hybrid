import { readdir, readFile } from "node:fs/promises";

import { createPool } from "mysql2/promise";

import type { SqlTransaction, TransactionalDatabase } from "./database.js";

export type ProductionDatabase = TransactionalDatabase & Readonly<{
  migrate(): Promise<void>;
  close(): Promise<void>;
}>;

export type MySqlConnection = Readonly<{
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  execute(statement: string, values?: readonly unknown[]): Promise<readonly [unknown, unknown]>;
}>;

export type MySqlPool = Readonly<{
  getConnection(): Promise<MySqlConnection>;
  end(): Promise<void>;
}>;

type DatabaseDependencies = Readonly<{
  pool?: MySqlPool;
  migrationDirectory?: URL;
}>;

type ResultHeader = Readonly<{
  affectedRows?: number;
}>;

type MigrationLedgerRow = Readonly<{
  id: string;
}>;

type LockRow = Readonly<{
  acquired: number | string | null;
}>;

const defaultMigrationDirectory = new URL("./migrations/", import.meta.url);
const migrationLockName = "hybrid_league_core_migrations";

/** Creates the MySQL 8 transaction adapter used by the production composition root. */
export function createDatabase(databaseUrl: string, dependencies: DatabaseDependencies = {}): ProductionDatabase {
  const pool = dependencies.pool ?? createProductionPool(databaseUrl);
  const migrationDirectory = dependencies.migrationDirectory ?? defaultMigrationDirectory;

  return {
    transaction: async (work) => transaction(pool, work),
    migrate: async () => migrate(pool, migrationDirectory),
    close: async () => pool.end()
  };
}

function createProductionPool(databaseUrl: string): MySqlPool {
  return createPool({
    uri: databaseUrl,
    timezone: "Z",
    multipleStatements: false
  }) as unknown as MySqlPool;
}

async function transaction<T>(pool: MySqlPool, work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  let started = false;

  try {
    await connection.beginTransaction();
    started = true;
    const result = await work(toTransaction(connection));
    await connection.commit();
    return result;
  } catch (error) {
    if (started) {
      await connection.rollback();
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function migrate(pool: MySqlPool, migrationDirectory: URL): Promise<void> {
  const connection = await pool.getConnection();
  let locked = false;

  try {
    const lock = await queryRows<LockRow>(connection, "SELECT GET_LOCK(?, ?) AS acquired", [migrationLockName, 30]);
    if (Number(lock[0]?.acquired) !== 1) {
      throw new Error("Unable to acquire the Hybrid migration lock.");
    }
    locked = true;

    await connection.execute(
      `CREATE TABLE IF NOT EXISTS hybrid_schema_migrations (
         id VARCHAR(255) NOT NULL PRIMARY KEY,
         applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
       ) ENGINE=InnoDB`
    );

    for (const name of (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort()) {
      const id = name.slice(0, -4);
      const applied = await queryRows<MigrationLedgerRow>(
        connection,
        "SELECT id FROM hybrid_schema_migrations WHERE id = ?",
        [id]
      );
      if (applied[0]) {
        continue;
      }

      const contents = await readFile(new URL(name, migrationDirectory), "utf8");
      for (const statement of sqlStatements(contents)) {
        await connection.execute(statement);
      }
      await connection.execute("INSERT INTO hybrid_schema_migrations (id) VALUES (?)", [id]);
    }
  } finally {
    try {
      if (locked) {
        await connection.execute("SELECT RELEASE_LOCK(?) AS released", [migrationLockName]);
      }
    } finally {
      connection.release();
    }
  }
}

function toTransaction(connection: MySqlConnection): SqlTransaction {
  return {
    query: async <T extends Record<string, unknown>>(statement: string, parameters: unknown[] = []) => {
      const [result] = await connection.execute(statement, parameters);
      if (Array.isArray(result)) {
        return { rows: result as T[], affectedRows: 0 };
      }
      return { rows: [], affectedRows: Number((result as ResultHeader).affectedRows ?? 0) };
    }
  };
}

async function queryRows<T extends Record<string, unknown>>(
  connection: MySqlConnection,
  statement: string,
  parameters: readonly unknown[] = []
): Promise<T[]> {
  const [result] = await connection.execute(statement, parameters);
  return Array.isArray(result) ? result as T[] : [];
}

function sqlStatements(contents: string): string[] {
  return contents
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
