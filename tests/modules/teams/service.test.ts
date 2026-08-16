import { describe, expect, it } from "vitest";

import { createAuditRepository } from "../../../src/modules/audit/repository.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { createTeamService } from "../../../src/modules/teams/service.js";
import type { TransactionalDatabase } from "../../../src/platform/database.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("TeamService", () => {
  it("creates a team and records an immutable audit event atomically", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));

      const team = await teams.createTeam(ownerContext, {
        name: "Northstar",
        rosterCap: 12,
        discordRoleId: "role-1"
      });

      expect(team).toMatchObject({
        name: "Northstar",
        rosterCount: 0,
        rosterCap: 12,
        status: "ACTIVE",
        discordRoleId: "role-1",
        manager: null
      });
      await expect(audit.listEntityHistory(ownerContext, "team", team.id)).resolves.toMatchObject([{
        action: "team.created",
        actorDiscordUserId: "owner-1",
        entityId: team.id
      }]);
    } finally {
      await database.dispose();
    }
  });

  it("does not expose a league A team to a league B manager", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(database, audit);

    try {
      const leagueAOwner = await leagues.bootstrapLeague(bootstrapInput("guild-a", "owner-a"));
      const leagueBOwner = await leagues.bootstrapLeague(bootstrapInput("guild-b", "owner-b"));
      const leagueATeam = await teams.createTeam(leagueAOwner, { name: "Northstar", rosterCap: 12 });
      const leagueBManager = {
        ...leagueBOwner,
        actor: {
          ...leagueBOwner.actor,
          role: "MANAGER" as const,
          roles: ["MANAGER" as const],
          managedTeamIds: []
        }
      };

      await expect(teams.getTeamDashboard(leagueBManager, leagueATeam.id))
        .rejects.toMatchObject({ code: "TEAM_NOT_FOUND" });
    } finally {
      await database.dispose();
    }
  });

  it("rejects a normalized duplicate without creating a second audit event", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const first = await teams.createTeam(ownerContext, { name: "North Star", rosterCap: 12 });

      await expect(teams.createTeam(ownerContext, { name: "  north   star  ", rosterCap: 12 }))
        .rejects.toMatchObject({ code: "TEAM_ALREADY_EXISTS" });
      expect((await teams.listTeams(ownerContext)).map((team) => team.id)).toEqual([first.id]);
      await expect(audit.listEntityHistory(ownerContext, "team", first.id)).resolves.toHaveLength(1);
    } finally {
      await database.dispose();
    }
  });

  it("maps a parallel normalized-name collision to a domain error without a second audit event", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(hideTeamAvailabilityChecks(database), audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const results = await Promise.allSettled([
        teams.createTeam(ownerContext, { name: "North Star", rosterCap: 12 }),
        teams.createTeam(ownerContext, { name: " north   star ", rosterCap: 12 })
      ]);

      expectOneWinnerAndDomainError(results, "TEAM_ALREADY_EXISTS");
      expect(await rowCount(database, "teams")).toBe(1);
      expect(await actionCount(database, "team.created")).toBe(1);
    } finally {
      await database.dispose();
    }
  });

  it("maps a parallel Discord-role collision to a domain error without a second audit event", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(hideTeamAvailabilityChecks(database), audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const results = await Promise.allSettled([
        teams.createTeam(ownerContext, { name: "Northstar", rosterCap: 12, discordRoleId: "role-1" }),
        teams.createTeam(ownerContext, { name: "Southstar", rosterCap: 12, discordRoleId: "role-1" })
      ]);

      expectOneWinnerAndDomainError(results, "DISCORD_ROLE_ALREADY_MAPPED");
      expect(await rowCount(database, "teams")).toBe(1);
      expect(await actionCount(database, "team.created")).toBe(1);
    } finally {
      await database.dispose();
    }
  });

  it("keeps team creation unavailable to staff and writes no team records", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const staffContext = {
        ...ownerContext,
        actor: {
          ...ownerContext.actor,
          role: "STAFF" as const,
          roles: ["STAFF" as const]
        }
      };

      await expect(teams.createTeam(staffContext, { name: "Northstar", rosterCap: 12 }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await rowCount(database, "teams")).toBe(0);
      expect(await rowCount(database, "audit_events")).toBe(1);
    } finally {
      await database.dispose();
    }
  });

  it("lists tenant teams and records an authorized status change", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const teams = createTeamService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const team = await teams.createTeam(ownerContext, { name: "Northstar", rosterCap: 12 });

      await expect(teams.setTeamStatus(ownerContext, team.id, "INACTIVE"))
        .resolves.toMatchObject({ id: team.id, status: "INACTIVE" });
      await expect(teams.listTeams(ownerContext)).resolves.toMatchObject([{ id: team.id, status: "INACTIVE" }]);
      await expect(audit.listEntityHistory(ownerContext, "team", team.id)).resolves.toMatchObject([
        { action: "team.created" },
        { action: "team.status_changed", afterState: { status: "INACTIVE" } }
      ]);
    } finally {
      await database.dispose();
    }
  });
});

function bootstrapInput(discordGuildId: string, discordUserId: string) {
  return {
    discordGuildId,
    actor: { discordUserId, displayName: discordUserId, manageGuild: true },
    name: `League ${discordGuildId}`,
    defaultRosterCap: 12
  };
}

async function rowCount(database: Awaited<ReturnType<typeof createTestDatabase>>, table: string): Promise<number> {
  const result = await database.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}

async function actionCount(database: Awaited<ReturnType<typeof createTestDatabase>>, action: string): Promise<number> {
  const result = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM audit_events WHERE action = $1",
    [action]
  );
  return Number(result.rows[0]?.count);
}

function expectOneWinnerAndDomainError(
  results: PromiseSettledResult<unknown>[],
  code: "TEAM_ALREADY_EXISTS" | "DISCORD_ROLE_ALREADY_MAPPED"
): void {
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ reason: { code } });
}

function hideTeamAvailabilityChecks(database: TransactionalDatabase): TransactionalDatabase {
  return {
    transaction: async (work) => database.transaction(async (transaction) => work({
      query: async (statement, parameters) => {
        if (statement.startsWith("SELECT id FROM teams WHERE league_id")) {
          return { rows: [] };
        }
        return transaction.query(statement, parameters);
      }
    }))
  };
}
