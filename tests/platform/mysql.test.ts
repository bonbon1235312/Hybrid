import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createDatabase, type MySqlPool } from "../../src/platform/mysql.js";

describe("MySQL database adapter", () => {
  it("rolls back all writes when application work fails", async () => {
    const pool = createFakePool();
    const database = createDatabase("mysql://hybrid:hybrid@localhost:3306/hybrid", { pool });

    await expect(database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO leagues (id) VALUES (?)", ["league-1"]);
      throw new Error("intentional failure");
    })).rejects.toThrow("intentional failure");

    expect(pool.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(pool.connection.commit).not.toHaveBeenCalled();
    expect(pool.connection.rollback).toHaveBeenCalledOnce();
    expect(pool.connection.release).toHaveBeenCalledOnce();
  });

  it("applies ordered migration files once under a named lock", async () => {
    const migrationDirectory = await mkdtemp(join(tmpdir(), "hybrid-migrations-"));
    const pool = createFakePool();
    const database = createDatabase("mysql://hybrid:hybrid@localhost:3306/hybrid", {
      pool,
      migrationDirectory: pathToFileURL(`${migrationDirectory}/`)
    });

    try {
      await writeFile(join(migrationDirectory, "0000_first.sql"), "CREATE TABLE first_table (id INT);\n", "utf8");
      await writeFile(join(migrationDirectory, "0001_second.sql"), "CREATE TABLE second_table (id INT);\n", "utf8");

      await database.migrate();
      await database.migrate();

      expect(pool.executed).toContain("CREATE TABLE first_table (id INT)");
      expect(pool.executed).toContain("CREATE TABLE second_table (id INT)");
      expect(pool.executed.filter((statement) => statement === "CREATE TABLE first_table (id INT)")).toHaveLength(1);
      expect(pool.executed.filter((statement) => statement === "CREATE TABLE second_table (id INT)")).toHaveLength(1);
      expect(pool.executed.filter((statement) => statement.includes("RELEASE_LOCK"))).toHaveLength(2);
    } finally {
      await database.close();
      await rm(migrationDirectory, { force: true, recursive: true });
    }
  });
});

function createFakePool(): MySqlPool & { connection: ReturnType<typeof createFakeConnection>; executed: string[] } {
  const executed: string[] = [];
  const applied = new Set<string>();
  const connection = createFakeConnection(executed, applied);

  return {
    connection,
    executed,
    end: vi.fn(async () => undefined),
    getConnection: vi.fn(async () => connection)
  };
}

function createFakeConnection(executed: string[], applied: Set<string>) {
  return {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (statement: string, values: readonly unknown[] = []) => {
      executed.push(statement.trim());
      if (statement.includes("GET_LOCK")) {
        return [[{ acquired: 1 }], []] as const;
      }
      if (statement.includes("RELEASE_LOCK")) {
        return [[{ released: 1 }], []] as const;
      }
      if (statement.includes("SELECT id FROM hybrid_schema_migrations")) {
        return [applied.has(String(values[0])) ? [{ id: values[0] }] : [], []] as const;
      }
      if (statement.includes("INSERT INTO hybrid_schema_migrations")) {
        applied.add(String(values[0]));
      }
      if (statement.trimStart().toUpperCase().startsWith("SELECT")) {
        return [[], []] as const;
      }
      return [{ affectedRows: 1 }, []] as const;
    })
  };
}
