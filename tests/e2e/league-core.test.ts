import { describe, expect, it } from "vitest";

import { createHybridApplication } from "../../src/app.js";
import type { DiscordRoleGateway } from "../../src/modules/discord-jobs/worker.js";
import { createTestDatabase } from "../../src/platform/test-db.js";

describe("Hybrid League Core", () => {
  it("guides setup through registration, approval, roster assignment, audit, and role reconciliation", async () => {
    const database = await createTestDatabase();
    const gateway = new FakeDiscordRoleGateway(["role-northstar"]);
    const app = await createHybridApplication({
      database,
      discordGateway: gateway,
      workerOptions: { workerId: "e2e-worker", claimLimit: 4, leaseSeconds: 60, maxAttempts: 3, retryBaseSeconds: 1 }
    });

    try {
      const owner = await app.services.leagues.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", displayName: "Owner One", manageGuild: true },
        name: "North League",
        defaultRosterCap: 2
      });
      const team = await app.services.teams.createTeam(owner, {
        name: "Northstar",
        rosterCap: 2,
        discordRoleId: "role-northstar"
      });
      const player = await app.services.leagues.resolveLeagueContext("guild-1", "player-1");
      if (!player) {
        throw new Error("Expected player context");
      }
      const registration = await app.services.registrations.requestRegistration(player, { displayName: "Player One" });
      await app.services.registrations.reviewRegistration(owner, { registrationId: registration.id, decision: "APPROVE" });
      await app.services.rosters.assignPlayerToTeam(owner, {
        teamId: team.id,
        playerId: registration.leagueMemberId,
        role: "PLAYER"
      });
      await app.worker.runOnce();

      const audits = await database.query<{ action: string }>("SELECT action FROM audit_events ORDER BY created_at ASC, id ASC");
      expect(audits.rows.map((event) => event.action)).toEqual(expect.arrayContaining([
        "league.created", "team.created", "registration.requested", "registration.approved", "roster.player_assigned"
      ]));
      expect(gateway.rolesFor("guild-1", "player-1")).toEqual(new Set(["role-northstar"]));
    } finally {
      await app.stop();
    }
  });
});

class FakeDiscordRoleGateway implements DiscordRoleGateway {
  private readonly existingRoles: Set<string>;
  private readonly roles = new Map<string, Set<string>>();

  constructor(existingRoles: Iterable<string>) {
    this.existingRoles = new Set(existingRoles);
  }

  async getMemberRoles(discordGuildId: string, discordUserId: string): Promise<readonly string[]> {
    return [...(this.roles.get(this.key(discordGuildId, discordUserId)) ?? new Set())];
  }

  async addMemberRole(discordGuildId: string, discordUserId: string, roleId: string): Promise<void> {
    this.rolesFor(discordGuildId, discordUserId).add(roleId);
  }

  async removeMemberRole(discordGuildId: string, discordUserId: string, roleId: string): Promise<void> {
    this.rolesFor(discordGuildId, discordUserId).delete(roleId);
  }

  async roleExists(discordGuildId: string, roleId: string): Promise<boolean> {
    return discordGuildId === "guild-1" && this.existingRoles.has(roleId);
  }

  rolesFor(discordGuildId: string, discordUserId: string): Set<string> {
    const key = this.key(discordGuildId, discordUserId);
    const existing = this.roles.get(key);
    if (existing) {
      return existing;
    }
    const roles = new Set<string>();
    this.roles.set(key, roles);
    return roles;
  }

  private key(discordGuildId: string, discordUserId: string): string {
    return `${discordGuildId}:${discordUserId}`;
  }
}
