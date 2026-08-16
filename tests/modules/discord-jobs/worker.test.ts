import { describe, expect, it } from "vitest";

import { createAuditRepository } from "../../../src/modules/audit/repository.js";
import { createDiscordJobRepository } from "../../../src/modules/discord-jobs/repository.js";
import {
  createRoleSyncWorker,
  type DiscordRoleGateway
} from "../../../src/modules/discord-jobs/worker.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { createRegistrationService } from "../../../src/modules/registrations/service.js";
import { createRosterService } from "../../../src/modules/rosters/service.js";
import { createTeamService } from "../../../src/modules/teams/service.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("RoleSyncWorker", () => {
  it("reclaims an expired lease and completes the desired role sync exactly once", async () => {
    const fixture = await createFixture();

    try {
      const assignment = await createAssignedPlayer(fixture, "Northstar", "role-1", "player-1");
      const claimed = await fixture.jobs.claimDiscordJobs("crashed-worker", 1, 60);
      await fixture.database.query(
        "UPDATE discord_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
        [claimed[0]?.id]
      );
      const gateway = new FakeDiscordRoleGateway(["role-1"]);
      const worker = createRoleSyncWorker(fixture.database, fixture.jobs, fixture.audit, gateway, {
        workerId: "recovery-worker",
        claimLimit: 4,
        leaseSeconds: 60,
        maxAttempts: 3,
        retryBaseSeconds: 1
      });

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });
      expect(gateway.setCalls).toEqual([{ discordUserId: "player-1", roleIds: ["role-1"] }]);
      expect(await jobStatus(fixture.database, `role-sync:${assignment.membership.id}`)).toBe("COMPLETED");
    } finally {
      await fixture.database.dispose();
    }
  });

  it("marks a deleted mapped role unavailable without changing roster truth", async () => {
    const fixture = await createFixture();

    try {
      const assignment = await createAssignedPlayer(fixture, "Northstar", "role-deleted", "player-1");
      const gateway = new FakeDiscordRoleGateway();
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, recoveries: 1 });
      await expect(fixture.teams.getTeamDashboard(fixture.owner, assignment.team.id))
        .resolves.toMatchObject({ discordRoleState: "UNAVAILABLE" });
      expect(await activeRosterCount(fixture.database, assignment.team.id)).toBe(1);
      expect(await jobStatus(fixture.database, `role-sync:${assignment.membership.id}`)).toBe("COMPLETED");
      expect(gateway.setCalls).toEqual([]);
      await expect(fixture.audit.listEntityHistory(fixture.owner, "team", assignment.team.id))
        .resolves.toMatchObject([{ action: "team.created" }, { action: "discord.role_unavailable" }]);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("reconciles a stale membership job to the player’s current team role", async () => {
    const fixture = await createFixture();

    try {
      const first = await createAssignedPlayer(fixture, "Northstar", "role-old", "player-1");
      await fixture.rosters.endTeamMembership(fixture.owner, { membershipId: first.membership.id });
      const secondTeam = await fixture.teams.createTeam(
        fixture.owner,
        { name: "Southstar", rosterCap: 12, discordRoleId: "role-new" }
      );
      const secondMembership = await fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: secondTeam.id, playerId: first.playerId, role: "PLAYER" }
      );
      const gateway = new FakeDiscordRoleGateway(["role-old", "role-new"]);
      gateway.roles.set("player-1", ["role-old"]);
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 2, completed: 2 });
      expect(gateway.setCalls).toEqual([{ discordUserId: "player-1", roleIds: ["role-new"] }]);
      expect(await jobStatus(fixture.database, `role-sync:${first.membership.id}`)).toBe("COMPLETED");
      expect(await jobStatus(fixture.database, `role-sync:${secondMembership.id}`)).toBe("COMPLETED");
    } finally {
      await fixture.database.dispose();
    }
  });

  it("removes a prior mapped role when the transfer target has a deleted mapping", async () => {
    const fixture = await createFixture();

    try {
      const first = await createAssignedPlayer(fixture, "Northstar", "role-old", "player-1");
      await fixture.rosters.endTeamMembership(fixture.owner, { membershipId: first.membership.id });
      const secondTeam = await fixture.teams.createTeam(
        fixture.owner,
        { name: "Southstar", rosterCap: 12, discordRoleId: "role-deleted" }
      );
      const secondMembership = await fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: secondTeam.id, playerId: first.playerId, role: "PLAYER" }
      );
      const gateway = new FakeDiscordRoleGateway(["role-old", "unrelated-role"]);
      gateway.roles.set("player-1", ["role-old", "unrelated-role"]);
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 2, completed: 2, recoveries: 1 });
      expect(gateway.setCalls).toEqual([{ discordUserId: "player-1", roleIds: ["unrelated-role"] }]);
      await expect(fixture.teams.getTeamDashboard(fixture.owner, secondTeam.id))
        .resolves.toMatchObject({ discordRoleState: "UNAVAILABLE" });
      await expect(fixture.audit.listEntityHistory(fixture.owner, "team", secondTeam.id))
        .resolves.toMatchObject([{ action: "team.created" }, { action: "discord.role_unavailable" }]);
      expect(await activeRosterCount(fixture.database, secondTeam.id)).toBe(1);
      expect(await jobStatus(fixture.database, `role-sync:${secondMembership.id}`)).toBe("COMPLETED");
    } finally {
      await fixture.database.dispose();
    }
  });

  it("re-identifies a role deleted after preflight without disabling the prior valid mapping", async () => {
    const fixture = await createFixture();

    try {
      const first = await createAssignedPlayer(fixture, "Northstar", "role-old", "player-1");
      await fixture.rosters.endTeamMembership(fixture.owner, { membershipId: first.membership.id });
      const secondTeam = await fixture.teams.createTeam(
        fixture.owner,
        { name: "Southstar", rosterCap: 12, discordRoleId: "role-new" }
      );
      await fixture.rosters.assignPlayerToTeam(
        fixture.owner,
        { teamId: secondTeam.id, playerId: first.playerId, role: "PLAYER" }
      );
      const gateway = new FakeDiscordRoleGateway(["role-old", "role-new", "unrelated-role"]);
      gateway.roles.set("player-1", ["role-old", "unrelated-role"]);
      gateway.setFailure = Object.assign(new Error("role disappeared"), { code: "UNKNOWN_ROLE" });
      gateway.removeRoleOnSetFailure = "role-new";
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 2, completed: 2, recoveries: 1 });
      expect(gateway.setCalls).toEqual([{ discordUserId: "player-1", roleIds: ["unrelated-role"] }]);
      await expect(fixture.teams.getTeamDashboard(fixture.owner, first.team.id))
        .resolves.toMatchObject({ discordRoleState: "AVAILABLE" });
      await expect(fixture.teams.getTeamDashboard(fixture.owner, secondTeam.id))
        .resolves.toMatchObject({ discordRoleState: "UNAVAILABLE" });
      const firstTeamAudit = await fixture.audit.listEntityHistory(fixture.owner, "team", first.team.id);
      expect(firstTeamAudit.map((event) => event.action)).not.toContain("discord.role_unavailable");
      await expect(fixture.audit.listEntityHistory(fixture.owner, "team", secondTeam.id))
        .resolves.toMatchObject([{ action: "team.created" }, { action: "discord.role_unavailable" }]);
      expect(await activeRosterCount(fixture.database, secondTeam.id)).toBe(1);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("uses bounded retries for gateway failures without rolling roster state back", async () => {
    const fixture = await createFixture();

    try {
      const assignment = await createAssignedPlayer(fixture, "Northstar", "role-1", "player-1");
      const gateway = new FakeDiscordRoleGateway(["role-1"]);
      gateway.setFailure = new Error("network unavailable");
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect(await jobStatus(fixture.database, `role-sync:${assignment.membership.id}`)).toBe("QUEUED");
      expect(await activeRosterCount(fixture.database, assignment.team.id)).toBe(1);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await fixture.database.query(
          "UPDATE discord_jobs SET available_at = NOW() - INTERVAL '1 second' WHERE deduplication_key = $1",
          [`role-sync:${assignment.membership.id}`]
        );
        await worker.runOnce();
      }

      expect(await jobStatus(fixture.database, `role-sync:${assignment.membership.id}`)).toBe("FAILED");
      expect(await activeRosterCount(fixture.database, assignment.team.id)).toBe(1);
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

async function createAssignedPlayer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
  discordRoleId: string,
  discordUserId: string
) {
  const team = await fixture.teams.createTeam(
    fixture.owner,
    { name, rosterCap: 12, discordRoleId }
  );
  const playerContext = await resolveContext(fixture.leagues, discordUserId);
  const registration = await fixture.registrations.requestRegistration(playerContext, { displayName: discordUserId });
  await fixture.registrations.reviewRegistration(
    fixture.owner,
    { registrationId: registration.id, decision: "APPROVE" }
  );
  const membership = await fixture.rosters.assignPlayerToTeam(
    fixture.owner,
    { teamId: team.id, playerId: registration.leagueMemberId, role: "PLAYER" }
  );

  return { team, membership, playerId: registration.leagueMemberId };
}

function createWorker(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  gateway: FakeDiscordRoleGateway
) {
  return createRoleSyncWorker(fixture.database, fixture.jobs, fixture.audit, gateway, {
    workerId: "worker-1",
    claimLimit: 4,
    leaseSeconds: 60,
    maxAttempts: 3,
    retryBaseSeconds: 1
  });
}

async function resolveContext(
  leagues: ReturnType<typeof createLeagueService>,
  discordUserId: string
) {
  const context = await leagues.resolveLeagueContext("guild-1", discordUserId);

  if (!context) {
    throw new Error("Expected an existing league context");
  }
  return context;
}

async function jobStatus(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  deduplicationKey: string
): Promise<string | null> {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM discord_jobs WHERE deduplication_key = $1",
    [deduplicationKey]
  );
  return result.rows[0]?.status ?? null;
}

async function activeRosterCount(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  teamId: string
): Promise<number> {
  const result = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM team_memberships WHERE team_id = $1 AND status = 'ACTIVE'",
    [teamId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

class FakeDiscordRoleGateway implements DiscordRoleGateway {
  readonly roles = new Map<string, string[]>();
  readonly setCalls: Array<{ discordUserId: string; roleIds: string[] }> = [];
  setFailure: Error | null = null;
  removeRoleOnSetFailure: string | null = null;
  private readonly existingRoles: Set<string>;

  constructor(existingRoles: Iterable<string> = []) {
    this.existingRoles = new Set(existingRoles);
  }

  async getMemberRoles(_discordGuildId: string, discordUserId: string): Promise<readonly string[]> {
    return this.roles.get(discordUserId) ?? [];
  }

  async setMemberRoles(_discordGuildId: string, discordUserId: string, roleIds: readonly string[]): Promise<void> {
    if (this.setFailure) {
      const failure = this.setFailure;
      if (this.removeRoleOnSetFailure) {
        this.existingRoles.delete(this.removeRoleOnSetFailure);
        this.setFailure = null;
      }
      throw failure;
    }
    this.roles.set(discordUserId, [...roleIds]);
    this.setCalls.push({ discordUserId, roleIds: [...roleIds] });
  }

  async roleExists(_discordGuildId: string, roleId: string): Promise<boolean> {
    return this.existingRoles.has(roleId);
  }
}
