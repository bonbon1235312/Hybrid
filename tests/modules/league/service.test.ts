import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLeagueService } from "../../../src/modules/league/service.js";
import { requirePermission } from "../../../src/modules/permissions/service.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("LeagueService", () => {
  it("makes the eligible bootstrapper the initial league owner", async () => {
    const database = await createTestDatabase();
    const leagueService = createLeagueService(database);

    try {
      const league = await leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("owner-1", { manageGuild: true }),
        name: "Hybrid League",
        defaultRosterCap: 12
      });

      expect(league).toMatchObject({
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", role: "OWNER" }
      });

      await expect(leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("other", { manageGuild: true }),
        name: "Other",
        defaultRosterCap: 12
      })).rejects.toMatchObject({ code: "LEAGUE_ALREADY_EXISTS" });

      expect(await countRows(database, "leagues")).toBe(1);
      expect(await countRows(database, "league_members")).toBe(1);
      expect(await countRows(database, "staff_assignments")).toBe(1);
      expect(await countRows(database, "audit_events")).toBe(1);
    } finally {
      await database.dispose();
    }
  });

  it("rejects an ineligible bootstrapper without creating any league records", async () => {
    const database = await createTestDatabase();
    const leagueService = createLeagueService(database);

    try {
      await expect(leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("player-1", { manageGuild: false }),
        name: "Hybrid League",
        defaultRosterCap: 12
      })).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(await countRows(database, "leagues")).toBe(0);
      expect(await countRows(database, "discord_users")).toBe(0);
      expect(await countRows(database, "league_members")).toBe(0);
      expect(await countRows(database, "staff_assignments")).toBe(0);
      expect(await countRows(database, "audit_events")).toBe(0);
    } finally {
      await database.dispose();
    }
  });

  it("persists the complete league bootstrap audit trail", async () => {
    const database = await createTestDatabase();
    const leagueService = createLeagueService(database);

    try {
      const context = await leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("owner-1", { manageGuild: true, displayName: "Owner One" }),
        name: "Hybrid League",
        defaultRosterCap: 12
      });

      const audit = await database.query<{
        action: string;
        actorMemberId: string;
        entityId: string;
        afterState: { name: string; defaultRosterCap: number };
      }>(
        "SELECT action, actor_member_id AS \"actorMemberId\", entity_id AS \"entityId\", after_state AS \"afterState\" FROM audit_events"
      );

      expect(audit.rows).toEqual([{
        action: "league.created",
        actorMemberId: context.actor.leagueMemberId,
        entityId: context.leagueId,
        afterState: { name: "Hybrid League", defaultRosterCap: 12 }
      }]);
    } finally {
      await database.dispose();
    }
  });

  it("resolves effective roles from Hybrid assignments and active team membership", async () => {
    const database = await createTestDatabase();
    const leagueService = createLeagueService(database);

    try {
      const league = await leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("owner-1", { manageGuild: true }),
        name: "Hybrid League",
        defaultRosterCap: 12
      });
      const managerMemberId = randomUUID();
      const staffMemberId = randomUUID();
      const teamId = randomUUID();

      await database.query(
        "INSERT INTO discord_users (discord_user_id, display_name) VALUES ($1, $2), ($3, $4)",
        ["manager-1", "Manager One", "staff-1", "Staff One"]
      );
      await database.query(
        "INSERT INTO league_members (id, league_id, discord_user_id) VALUES ($1, $2, $3), ($4, $2, $5)",
        [managerMemberId, league.leagueId, "manager-1", staffMemberId, "staff-1"]
      );
      await database.query(
        "INSERT INTO teams (id, league_id, name, normalized_name, roster_cap) VALUES ($1, $2, $3, $4, $5)",
        [teamId, league.leagueId, "Northstar", "northstar", 12]
      );
      await database.query(
        "INSERT INTO team_memberships (id, league_id, league_member_id, team_id, membership_role) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), league.leagueId, managerMemberId, teamId, "MANAGER"]
      );
      await database.query(
        "INSERT INTO staff_assignments (id, league_id, league_member_id, role) VALUES ($1, $2, $3, $4)",
        [randomUUID(), league.leagueId, staffMemberId, "STAFF"]
      );

      await expect(leagueService.resolveLeagueContext("guild-1", "manager-1"))
        .resolves.toMatchObject({ actor: { role: "MANAGER", teamId } });
      await expect(leagueService.resolveLeagueContext("guild-1", "staff-1"))
        .resolves.toMatchObject({ actor: { role: "STAFF" } });
      await expect(leagueService.resolveLeagueContext("guild-1", "new-player"))
        .resolves.toMatchObject({ actor: { discordUserId: "new-player", role: "PLAYER" } });
      await expect(leagueService.resolveLeagueContext("unknown-guild", "owner-1")).resolves.toBeNull();
    } finally {
      await database.dispose();
    }
  });

  it("combines staff review and manager roster grants without expanding the manager team scope", async () => {
    const database = await createTestDatabase();
    const leagueService = createLeagueService(database);

    try {
      const league = await leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("owner-1", { manageGuild: true }),
        name: "Hybrid League",
        defaultRosterCap: 12
      });
      const memberId = randomUUID();
      const managedTeamId = randomUUID();
      const otherTeamId = randomUUID();

      await database.query("INSERT INTO discord_users (discord_user_id, display_name) VALUES ($1, $2)", ["staff-manager-1", "Staff Manager"]);
      await database.query(
        "INSERT INTO league_members (id, league_id, discord_user_id) VALUES ($1, $2, $3)",
        [memberId, league.leagueId, "staff-manager-1"]
      );
      await database.query(
        "INSERT INTO teams (id, league_id, name, normalized_name, roster_cap) VALUES ($1, $2, $3, $4, $5), ($6, $2, $7, $8, $5)",
        [managedTeamId, league.leagueId, "Northstar", "northstar", 12, otherTeamId, "Southstar", "southstar"]
      );
      await database.query(
        "INSERT INTO team_memberships (id, league_id, league_member_id, team_id, membership_role) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), league.leagueId, memberId, managedTeamId, "MANAGER"]
      );
      await database.query(
        "INSERT INTO staff_assignments (id, league_id, league_member_id, role) VALUES ($1, $2, $3, $4)",
        [randomUUID(), league.leagueId, memberId, "STAFF"]
      );

      const context = await leagueService.resolveLeagueContext("guild-1", "staff-manager-1");

      expect(context).not.toBeNull();
      if (!context) {
        throw new Error("Expected an existing league context");
      }
      expect(context.actor.teamId).toBe(managedTeamId);
      expect(context.actor.roles).toEqual(["STAFF", "MANAGER"]);
      expect(context.actor.managedTeamIds).toEqual([managedTeamId]);
      expect(() => requirePermission(context, "REGISTRATION_REVIEW")).not.toThrow();
      expect(() => requirePermission(context, "ROSTER_MANAGE", managedTeamId)).not.toThrow();
      expect(() => requirePermission(context, "ROSTER_MANAGE", otherTeamId)).toThrow(/not permitted/i);
    } finally {
      await database.dispose();
    }
  });
});

function member(
  discordUserId: string,
  input: { manageGuild: boolean; displayName?: string }
) {
  return {
    discordUserId,
    displayName: input.displayName ?? discordUserId,
    manageGuild: input.manageGuild
  };
}

async function countRows(database: Awaited<ReturnType<typeof createTestDatabase>>, table: string): Promise<number> {
  const result = await database.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}
