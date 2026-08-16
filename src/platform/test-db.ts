import { randomBytes, randomUUID } from "node:crypto";

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createPool, type Pool } from "mysql2/promise";

import type { SqlQueryResult } from "./database.js";
import { createDatabase, type ProductionDatabase } from "./mysql.js";

export type TestDatabase = ProductionDatabase & Readonly<{
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: unknown[]
  ): Promise<SqlQueryResult<T>>;
  dispose(): Promise<void>;
}>;

type TestRuntime = Readonly<{
  container: StartedTestContainer;
  admin: Pool;
  databaseUrl: string;
}>;

let runtime: Promise<TestRuntime> | null = null;
let externalRuntime: Promise<string> | null = null;

/** Creates a fresh schema in an isolated MySQL 8 test container. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const externalDatabaseUrl = optedInExternalTestDatabaseUrl();
  if (externalDatabaseUrl) {
    return createExternalTestDatabase(externalDatabaseUrl);
  }

  const testRuntime = await getRuntime();
  const schemaName = "hybrid_test_" + randomUUID().replaceAll("-", "");
  assertTestSchemaName(schemaName);

  await testRuntime.admin.query(
    "CREATE DATABASE `" + schemaName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
  );

  const database = createDatabase(withSchema(testRuntime.databaseUrl, schemaName));
  await database.migrate();

  return {
    ...database,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(statement: string, parameters?: unknown[]) => {
      const fixtureQuery = normaliseLegacyFixtureQuery(statement, parameters);
      return database.transaction((transaction) => transaction.query<T>(fixtureQuery.statement, fixtureQuery.parameters));
    },
    dispose: async () => {
      await database.close();
      await testRuntime.admin.query("DROP DATABASE IF EXISTS `" + schemaName + "`");
    }
  };
}

async function createExternalTestDatabase(databaseUrl: string): Promise<TestDatabase> {
  if (!externalRuntime) {
    externalRuntime = initialiseExternalTestSchema(databaseUrl);
  }
  await externalRuntime;
  await clearExternalTestData(databaseUrl);
  const database = createDatabase(databaseUrl);

  return {
    ...database,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(statement: string, parameters?: unknown[]) => {
      const fixtureQuery = normaliseLegacyFixtureQuery(statement, parameters);
      return database.transaction((transaction) => transaction.query<T>(fixtureQuery.statement, fixtureQuery.parameters));
    },
    dispose: async () => {
      await database.close();
    }
  };
}

export async function stopTestDatabaseRuntime(): Promise<void> {
  const activeRuntime = runtime;
  runtime = null;
  if (activeRuntime) {
    const testRuntime = await activeRuntime;
    await testRuntime.admin.end();
    await testRuntime.container.stop();
  }

  const activeExternalRuntime = externalRuntime;
  externalRuntime = null;
  if (activeExternalRuntime) {
    await resetExternalTestSchema(await activeExternalRuntime);
  }
}

async function getRuntime(): Promise<TestRuntime> {
  if (!runtime) {
    runtime = startRuntime();
  }

  try {
    return await runtime;
  } catch (error) {
    runtime = null;
    throw error;
  }
}

async function startRuntime(): Promise<TestRuntime> {
  const rootPassword = randomBytes(24).toString("base64url");
  const container = await new GenericContainer("mysql:8.0.46")
    .withEnvironment({
      MYSQL_DATABASE: "hybrid_test_bootstrap",
      MYSQL_ROOT_PASSWORD: rootPassword
    })
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forLogMessage(/ready for connections/u))
    .withStartupTimeout(90_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(3306);
  const databaseUrl = "mysql://root:" + encodeURIComponent(rootPassword) + "@" + host + ":" + port + "/hybrid_test_bootstrap";
  const admin = createPool({ uri: databaseUrl, timezone: "Z", multipleStatements: false });

  return { container, admin, databaseUrl };
}

function withSchema(databaseUrl: string, schemaName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/" + schemaName;
  return parsed.toString();
}

function assertTestSchemaName(schemaName: string): void {
  if (!/^hybrid_test_[a-f0-9]{32}$/u.test(schemaName)) {
    throw new Error("Refusing to create or remove a non-test MySQL schema.");
  }
}

function optedInExternalTestDatabaseUrl(): string | null {
  const databaseUrl = process.env.HYBRID_TEST_DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }
  if (process.env.HYBRID_ALLOW_REMOTE_TEST_DATABASE !== "yes") {
    throw new Error("Set HYBRID_ALLOW_REMOTE_TEST_DATABASE=yes before using a remote test database.");
  }

  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mysqls:") {
    throw new Error("HYBRID_TEST_DATABASE_URL must use mysql:// or mysqls://.");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new Error("HYBRID_TEST_DATABASE_URL must select a dedicated test schema.");
  }
  return databaseUrl;
}

async function resetExternalTestSchema(databaseUrl: string): Promise<void> {
  const pool = createPool({ uri: databaseUrl, timezone: "Z", multipleStatements: false });
  const connection = await pool.getConnection();
  const managedTables = managedTestTables();

  try {
    const [result] = await connection.execute(
      "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    const tableNames = Array.isArray(result)
      ? result.flatMap((row) => typeof row === "object" && row !== null && "tableName" in row && typeof row.tableName === "string" ? [row.tableName] : [])
      : [];
    const unexpectedTable = tableNames.find((tableName) => !managedTables.has(tableName));
    if (unexpectedTable) {
      throw new Error(`Refusing to reset a test database containing unexpected table: ${unexpectedTable}`);
    }

    await connection.execute("SET FOREIGN_KEY_CHECKS = 0");
    for (const tableName of tableNames) {
      await connection.execute(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await connection.execute("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
    await pool.end();
  }
}

async function initialiseExternalTestSchema(databaseUrl: string): Promise<string> {
  try {
    await resetExternalTestSchema(databaseUrl);
    const database = createDatabase(databaseUrl);
    try {
      await database.migrate();
    } finally {
      await database.close();
    }
    return databaseUrl;
  } catch (error) {
    externalRuntime = null;
    throw error;
  }
}

async function clearExternalTestData(databaseUrl: string): Promise<void> {
  const pool = createPool({ uri: databaseUrl, timezone: "Z", multipleStatements: true });
  const connection = await pool.getConnection();
  const persistentTable = "hybrid_schema_migrations";

  try {
    const [result] = await connection.execute(
      "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    const tableNames = Array.isArray(result)
      ? result.flatMap((row) => typeof row === "object" && row !== null && "tableName" in row && typeof row.tableName === "string" ? [row.tableName] : [])
      : [];
    const managedTables = managedTestTables();
    const unexpectedTable = tableNames.find((tableName) => !managedTables.has(tableName));
    if (unexpectedTable) {
      throw new Error(`Refusing to reset a test database containing unexpected table: ${unexpectedTable}`);
    }
    const deletions = tableNames
      .filter((tableName) => tableName !== persistentTable)
      .map((tableName) => `DELETE FROM \`${tableName}\``);
    if (deletions.length > 0) {
      await connection.query(["SET FOREIGN_KEY_CHECKS = 0", ...deletions, "SET FOREIGN_KEY_CHECKS = 1"].join(";\n"));
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

function managedTestTables(): Set<string> {
  return new Set([
    "audit_events",
    "discord_jobs",
    "discord_resources",
    "discord_users",
    "hybrid_schema_migrations",
    "interaction_route_consumptions",
    "interaction_routes",
    "league_members",
    "leagues",
    "registration_requests",
    "staff_assignments",
    "team_memberships",
    "teams"
  ]);
}

function normaliseLegacyFixtureQuery(statement: string, parameters?: unknown[]): Readonly<{ statement: string; parameters: unknown[] }> {
  const boundParameters: unknown[] = [];
  const normalisedStatement = statement
    .replace(/\$(\d+)/gu, (_match, parameterIndex: string) => {
      const value = parameters?.[Number(parameterIndex) - 1];
      boundParameters.push(value);
      return "?";
    })
    .replace(/::(?:jsonb|text)/gu, "")
    .replace(/NOW\(\)/gu, "UTC_TIMESTAMP(3)")
    .replace(/UTC_TIMESTAMP\(3\) - INTERVAL '([0-9]+) second'/gu, "DATE_SUB(UTC_TIMESTAMP(3), INTERVAL $1 SECOND)")
    .replace(/\s+NULLS LAST/gu, "")
    .replace(/\bAS "([A-Za-z][A-Za-z0-9_]*)"/gu, "AS $1");

  return {
    statement: normalisedStatement,
    parameters: boundParameters.length > 0 ? boundParameters : (parameters ?? [])
  };
}
