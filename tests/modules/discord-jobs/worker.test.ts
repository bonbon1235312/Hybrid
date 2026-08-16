import { describe, expect, it } from "vitest";

import { createAuditRepository } from "../../../src/modules/audit/repository.js";
import { createDiscordJobRepository } from "../../../src/modules/discord-jobs/repository.js";
import { createRoleSyncWorker, type DiscordRoleGateway } from "../../../src/modules/discord-jobs/worker.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { createRegistrationService } from "../../../src/modules/registrations/service.js";
import { createRosterService } from "../../../src/modules/rosters/service.js";
import { createTeamService } from "../../../src/modules/teams/service.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("RoleSyncWorker", () => {
  it("reclaims an expired lease and applies the current role sync exactly once", async () => {
    const fixture = await createFixture();
    try {
      const assignment = await createAssignedPlayer(fixture, "Northstar", "role-1", "player-1");
      const claimed = await fixture.jobs.claimDiscordJobs("crashed-worker", 1, 60);
      await fixture.database.query("UPDATE discord_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [claimed[0]?.id]);
      const gateway = new FakeDiscordRoleGateway(["role-1"]);
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 0 });
      expect(gateway.addCalls).toEqual([{ discordUserId: "player-1", roleId: "role-1" }]);
      expect(gateway.removeCalls).toEqual([]);
      expect(await jobStatus(fixture.database, `role-sync:${assignment.membership.id}`)).toBe("COMPLETED");
    } finally {
      await fixture.database.dispose();
    }
  });

  it("marks a deleted mapping unavailable without changing roster truth", async () => {
    const fixture = await createFixture();
    try {
      const assignment = await createAssignedPlayer(fixture, "Northstar", "role-deleted", "player-1");
      const gateway = new FakeDiscordRoleGateway();

      await expect(createWorker(fixture, gateway).runOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, recoveries: 1 });
      await expect(fixture.teams.getTeamDashboard(fixture.owner, assignment.team.id))
        .resolves.toMatchObject({ discordRoleState: "UNAVAILABLE" });
      expect(await activeRosterCount(fixture.database, assignment.team.id)).toBe(1);
      expect(gateway.addCalls).toEqual([]);
      expect(gateway.removeCalls).toEqual([]);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("uses targeted add/remove calls and preserves an unrelated role during a roster move", async () => {
    const fixture = await createFixture();
    try {
      const first = await createAssignedPlayer(fixture, "Northstar", "role-old", "player-1");
      const gateway = new FakeDiscordRoleGateway(["role-old", "role-new", "unrelated-role"]);
      gateway.roles.set("player-1", new Set(["unrelated-role"]));
      const worker = createWorker(fixture, gateway);
      await worker.runOnce();

      await fixture.rosters.endTeamMembership(fixture.owner, { membershipId: first.membership.id });
      const secondTeam = await fixture.teams.createTeam(fixture.owner, { name: "Southstar", rosterCap: 12, discordRoleId: "role-new" });
      await fixture.rosters.assignPlayerToTeam(fixture.owner, { teamId: secondTeam.id, playerId: first.playerId, role: "PLAYER" });
      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 2, completed: 2 });

      expect(gateway.rolesFor("player-1")).toEqual(new Set(["unrelated-role", "role-new"]));
      expect(gateway.removeCalls).toEqual([{ discordUserId: "player-1", roleId: "role-old" }]);
      expect(gateway.addCalls).toEqual([
        { discordUserId: "player-1", roleId: "role-old" },
        { discordUserId: "player-1", roleId: "role-new" }
      ]);
    } finally {
      await fixture.database.dispose();
    }
  });

  it("retries a targeted mutation without rolling roster state back", async () => {
    const fixture = await createFixture();
    try {
      const assignment = await createAssignedPlayer(fixture, "Northstar", "role-1", "player-1");
      const gateway = new FakeDiscordRoleGateway(["role-1"]);
      gateway.failure = new Error("network unavailable");
      const worker = createWorker(fixture, gateway);

      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, retried: 1, completed: 0 });
      expect(await jobStatus(fixture.database, `role-sync:${assignment.membership.id}`)).toBe("QUEUED");
      expect(await activeRosterCount(fixture.database, assignment.team.id)).toBe(1);

      gateway.failure = null;
      await fixture.database.query("UPDATE discord_jobs SET available_at = NOW() - INTERVAL '1 second' WHERE deduplication_key = $1", [`role-sync:${assignment.membership.id}`]);
      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, completed: 1 });
      expect(gateway.rolesFor("player-1")).toEqual(new Set(["role-1"]));
    } finally {
      await fixture.database.dispose();
    }
  });
});

async function createFixture() {
  const database = await createTestDatabase();
  const leagues = createLeagueService(database);
  const audit = createAuditRepository(database);
  const jobs = createDiscordJobRepository(database);
  const teams = createTeamService(database, audit, jobs);
  const registrations = createRegistrationService(database, audit);
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
  const team = await fixture.teams.createTeam(fixture.owner, { name, rosterCap: 12, discordRoleId });
  const player = await fixture.leagues.resolveLeagueContext("guild-1", discordUserId);
  if (!player) throw new Error("Expected player context.");
  const registration = await fixture.registrations.requestRegistration(player, { displayName: discordUserId });
  await fixture.registrations.reviewRegistration(fixture.owner, { registrationId: registration.id, decision: "APPROVE" });
  const membership = await fixture.rosters.assignPlayerToTeam(fixture.owner, {
    teamId: team.id,
    playerId: registration.leagueMemberId,
    role: "PLAYER"
  });
  return { team, membership, playerId: registration.leagueMemberId };
}

function createWorker(fixture: Awaited<ReturnType<typeof createFixture>>, gateway: DiscordRoleGateway) {
  return createRoleSyncWorker(fixture.database, fixture.jobs, fixture.audit, gateway, {
    workerId: "worker-1",
    claimLimit: 4,
    leaseSeconds: 60,
    maxAttempts: 3,
    retryBaseSeconds: 1
  });
}

async function jobStatus(database: Awaited<ReturnType<typeof createTestDatabase>>, deduplicationKey: string): Promise<string | null> {
  const result = await database.query<{ status: string }>("SELECT status FROM discord_jobs WHERE deduplication_key = $1", [deduplicationKey]);
  return result.rows[0]?.status ?? null;
}

async function activeRosterCount(database: Awaited<ReturnType<typeof createTestDatabase>>, teamId: string): Promise<number> {
  const result = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM team_memberships WHERE team_id = $1 AND status = 'ACTIVE'", [teamId]);
  return Number(result.rows[0]?.count ?? "0");
}

class FakeDiscordRoleGateway implements DiscordRoleGateway {
  readonly roles = new Map<string, Set<string>>();
  readonly addCalls: Array<{ discordUserId: string; roleId: string }> = [];
  readonly removeCalls: Array<{ discordUserId: string; roleId: string }> = [];
  failure: Error | null = null;
  private readonly existingRoles: Set<string>;

  constructor(existingRoles: Iterable<string> = []) {
    this.existingRoles = new Set(existingRoles);
  }

  async getMemberRoles(_guildId: string, discordUserId: string): Promise<readonly string[]> {
    return [...this.rolesFor(discordUserId)];
  }

  async addMemberRole(_guildId: string, discordUserId: string, roleId: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.rolesFor(discordUserId).add(roleId);
    this.addCalls.push({ discordUserId, roleId });
  }

  async removeMemberRole(_guildId: string, discordUserId: string, roleId: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.rolesFor(discordUserId).delete(roleId);
    this.removeCalls.push({ discordUserId, roleId });
  }

  async roleExists(_guildId: string, roleId: string): Promise<boolean> {
    return this.existingRoles.has(roleId);
  }

  rolesFor(discordUserId: string): Set<string> {
    const existing = this.roles.get(discordUserId);
    if (existing) return existing;
    const roles = new Set<string>();
    this.roles.set(discordUserId, roles);
    return roles;
  }
}
