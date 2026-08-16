import { describe, expect, it } from "vitest";

import { createAuditRepository } from "../../../src/modules/audit/repository.js";
import { createDiscordJobRepository } from "../../../src/modules/discord-jobs/repository.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { createRegistrationService } from "../../../src/modules/registrations/service.js";
import { createRosterService } from "../../../src/modules/rosters/service.js";
import { createTeamService } from "../../../src/modules/teams/service.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("RosterService", () => {
  it("never exceeds cap when two assignments race for the final place", async () => {
    const fixture = await createFixture();

    try {
      const team = await fixture.teams.createTeam(fixture.owner, { name: "Northstar", rosterCap: 1 });
      const playerA = await approvePlayer(fixture, "player-a");
      const playerB = await approvePlayer(fixture, "player-b");

      const results = await Promise.allSettled([
        fixture.rosters.assignPlayerToTeam(fixture.owner, { teamId: team.id, playerId: playerA, role: "PLAYER" }),
        fixture.rosters.assignPlayerToTeam(fixture.owner, { teamId: team.id, playerId: playerB, role: "PLAYER" })
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await activeRosterCount(fixture.database, team.id)).toBe(1);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("creates one role-sync job with its membership transition", async () => {
    const fixture = await createFixture();

    try {
      const team = await fixture.teams.createTeam(fixture.owner, { name: "Northstar", rosterCap: 12 });
      const playerId = await approvePlayer(fixture, "player-1");

      const membership = await fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: team.id, playerId, role: "PLAYER" }
      );

      await expect(fixture.jobs.listByDeduplicationKey(`role-sync:${membership.id}`)).resolves.toHaveLength(1);
      await expect(fixture.audit.listEntityHistory(fixture.owner, "team_membership", membership.id))
        .resolves.toMatchObject([{ action: "roster.player_assigned" }]);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("rejects a pending player before writing membership, audit, or role-sync work", async () => {
    const fixture = await createFixture();

    try {
      const team = await fixture.teams.createTeam(fixture.owner, { name: "Northstar", rosterCap: 12 });
      const playerContext = await resolveContext(fixture.leagues, "guild-1", "player-1");
      const pendingRegistration = await fixture.registrations.requestRegistration(
        playerContext,
        { displayName: "Player One" }
      );

      await expect(fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: team.id, playerId: pendingRegistration.leagueMemberId, role: "PLAYER" }
      )).rejects.toMatchObject({ code: "PLAYER_NOT_APPROVED" });
      expect(await activeRosterCount(fixture.database, team.id)).toBe(0);
      expect(await jobCount(fixture.database)).toBe(0);
      expect(await rosterAuditCount(fixture.database)).toBe(0);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("allows a manager to act only on their managed team", async () => {
    const fixture = await createFixture();

    try {
      const managedTeam = await fixture.teams.createTeam(fixture.owner, { name: "Northstar", rosterCap: 12 });
      const otherTeam = await fixture.teams.createTeam(fixture.owner, { name: "Southstar", rosterCap: 12 });
      const managerPlayerId = await approvePlayer(fixture, "manager-1");
      const playerId = await approvePlayer(fixture, "player-1");
      await fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: managedTeam.id, playerId: managerPlayerId, role: "MANAGER" }
      );
      const managerContext = await resolveContext(fixture.leagues, "guild-1", "manager-1");

      await expect(fixture.rosters.assignPlayerToTeam(
        managerContext,
        { teamId: otherTeam.id, playerId, role: "PLAYER" }
      )).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await activeRosterCount(fixture.database, otherTeam.id)).toBe(0);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("ends a membership with an audit event and coalesced restart-safe role-sync work", async () => {
    const fixture = await createFixture();

    try {
      const team = await fixture.teams.createTeam(fixture.owner, { name: "Northstar", rosterCap: 12 });
      const playerId = await approvePlayer(fixture, "player-1");
      const membership = await fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: team.id, playerId, role: "PLAYER" }
      );

      await expect(fixture.rosters.endTeamMembership(fixture.owner, { membershipId: membership.id }))
        .resolves.toMatchObject({ id: membership.id, status: "ENDED" });
      expect(await activeRosterCount(fixture.database, team.id)).toBe(0);
      await expect(fixture.jobs.listByDeduplicationKey(`role-sync:${membership.id}`)).resolves.toHaveLength(1);
      await expect(fixture.audit.listEntityHistory(fixture.owner, "team_membership", membership.id))
        .resolves.toMatchObject([
          { action: "roster.player_assigned" },
          { action: "roster.player_removed" }
        ]);
    } finally {
      await fixture.database.dispose();
    }
  });
});

async function createFixture() {
  const database = await createTestDatabase();
  const leagues = createLeagueService(database);
  const audit = createAuditRepository(database);
  const teams = createTeamService(database, audit);
  const registrations = createRegistrationService(database, audit);
  const jobs = createDiscordJobRepository(database);
  const rosters = createRosterService(database, audit, jobs);
  const owner = await leagues.bootstrapLeague({
    discordGuildId: "guild-1",
    actor: { discordUserId: "owner-1", displayName: "Owner One", manageGuild: true },
    name: "Hybrid League",
    defaultRosterCap: 12
  });

  return { database, leagues, audit, teams, registrations, jobs, rosters, owner };
}

async function approvePlayer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  discordUserId: string
): Promise<string> {
  const playerContext = await resolveContext(fixture.leagues, "guild-1", discordUserId);
  const registration = await fixture.registrations.requestRegistration(playerContext, { displayName: discordUserId });

  await fixture.registrations.reviewRegistration(
    fixture.owner,
    { registrationId: registration.id, decision: "APPROVE" }
  );
  return registration.leagueMemberId;
}

async function resolveContext(
  leagues: ReturnType<typeof createLeagueService>,
  discordGuildId: string,
  discordUserId: string
) {
  const context = await leagues.resolveLeagueContext(discordGuildId, discordUserId);

  if (!context) {
    throw new Error("Expected an existing league context");
  }
  return context;
}

async function activeRosterCount(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  teamId: string
): Promise<number> {
  const result = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM team_memberships WHERE team_id = $1 AND status = 'ACTIVE'",
    [teamId]
  );
  return Number(result.rows[0]?.count);
}

async function jobCount(database: Awaited<ReturnType<typeof createTestDatabase>>): Promise<number> {
  const result = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM discord_jobs");
  return Number(result.rows[0]?.count);
}

async function rosterAuditCount(database: Awaited<ReturnType<typeof createTestDatabase>>): Promise<number> {
  const result = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM audit_events WHERE action LIKE 'roster.%'"
  );
  return Number(result.rows[0]?.count);
}
