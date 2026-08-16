import { describe, expect, it } from "vitest";

import { createHybridApplication } from "../../src/app.js";
import { routeComponent } from "../../src/discord/router.js";
import type { ApplicationServices, ComponentInteractionLike, InteractionReplyOptions, ModalOptions } from "../../src/discord/types.js";
import type { DiscordRoleGateway } from "../../src/modules/discord-jobs/worker.js";
import type { LeagueContext } from "../../src/modules/league/types.js";
import { createTestDatabase } from "../../src/platform/test-db.js";

describe("guided League Core router", () => {
  it("creates the first team through a compact owner modal without Discord/database ID fields", async () => {
    const fixture = await createFixture();
    try {
      const owner = await fixture.app.services.leagues.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", displayName: "Owner", manageGuild: true },
        name: "Hybrid League",
        defaultRosterCap: 12
      });
      const open = component(await fixture.app.services.routes.issue({
        guildId: "guild-1", actorId: "owner-1", action: "team.create"
      }), "owner-1");

      await routeComponent(open, fixture.app.services);
      const modal = open.modals.at(-1);
      expect(modal?.inputs.map((input) => input.customId)).toEqual(["team-name", "roster-cap"]);
      expect(modal?.inputs.map((input) => input.label)).not.toContain("Discord role ID (optional)");

      const submit = component(modal?.customId ?? "", "owner-1", { "team-name": "Northstar", "roster-cap": "8" });
      await routeComponent(submit, fixture.app.services);

      const [createdTeam] = await fixture.app.services.teams.listTeams(owner);
      if (!createdTeam) throw new Error("Expected the created team.");
      expect(createdTeam).toMatchObject({ name: "Northstar", rosterCap: 8 });

      const mapRole = component(await fixture.app.services.routes.issue({
        guildId: "guild-1", actorId: "owner-1", action: "team.role.map", entityId: createdTeam.id
      }), "owner-1");
      await routeComponent(mapRole, fixture.app.services);
      const roleSelect = mapRole.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.type === "role-select");
      expect(roleSelect?.data.customId).toMatch(/^h3\./);

      const selectRole = component(roleSelect?.data.customId ?? "", "owner-1", undefined, ["role-northstar"]);
      await routeComponent(selectRole, fixture.app.services);
      await expect(fixture.app.services.teams.getTeamDashboard(owner, createdTeam.id))
        .resolves.toMatchObject({ discordRoleId: "role-northstar", discordRoleState: "AVAILABLE" });
    } finally {
      await fixture.app.stop();
    }
  });

  it("assigns a selected Discord user only after re-resolving their live league membership", async () => {
    const fixture = await createFixture();
    try {
      const owner = await fixture.app.services.leagues.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", displayName: "Owner", manageGuild: true },
        name: "Hybrid League",
        defaultRosterCap: 12
      });
      const team = await fixture.app.services.teams.createTeam(owner, { name: "Northstar", rosterCap: 8 });
      const player = await fixture.app.services.leagues.resolveLeagueContext("guild-1", "player-1");
      if (!player) throw new Error("Expected a league context for the selected Discord user.");
      const registration = await fixture.app.services.registrations.requestRegistration(player, { displayName: "Player One" });
      await fixture.app.services.registrations.reviewRegistration(owner, { registrationId: registration.id, decision: "APPROVE" });

      const assign = component(await fixture.app.services.routes.issue({
        guildId: "guild-1", actorId: "owner-1", action: "roster.assign", entityId: team.id
      }), "owner-1");
      await routeComponent(assign, fixture.app.services);
      const userSelect = assign.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.type === "user-select");
      expect(userSelect?.data.customId).toMatch(/^h3\./);

      const select = component(userSelect?.data.customId ?? "", "owner-1", undefined, ["player-1"]);
      await routeComponent(select, fixture.app.services);
      const roleSelect = select.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.type === "select");
      expect(roleSelect?.data.options?.map((option) => option.value)).toEqual(["PLAYER", "CAPTAIN", "MANAGER"]);

      const chooseCaptain = component(roleSelect?.data.customId ?? "", "owner-1", undefined, ["CAPTAIN"]);
      await routeComponent(chooseCaptain, fixture.app.services);
      const confirm = chooseCaptain.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.label === "Confirm");
      const confirmAssignment = component(confirm?.data.customId ?? "", "owner-1");
      await routeComponent(confirmAssignment, fixture.app.services);

      await expect(fixture.app.services.rosters.listActiveTeamMemberships(owner, team.id))
        .resolves.toMatchObject([{ leagueMemberId: registration.leagueMemberId, role: "CAPTAIN" }]);
      expect(confirmAssignment.edits.at(-1)?.content).toBe("Captain assigned. Discord role sync is queued.");

      const teamPicker = await fixture.app.services.routes.issue({
        guildId: "guild-1", actorId: "owner-1", action: "team.detail"
      });
      const selectedTeam = await fixture.app.services.routes.issue({
        guildId: "guild-1", actorId: "owner-1", action: "team.detail", entityId: team.id
      });
      const dashboard = component(teamPicker, "owner-1", undefined, [selectedTeam]);
      await routeComponent(dashboard, fixture.app.services);
      const releaseOption = dashboard.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.type === "select")?.data.options?.[0];
      expect(releaseOption?.label).toBe("Release Player One");
      expect(releaseOption?.label).not.toContain(registration.leagueMemberId);
    } finally {
      await fixture.app.stop();
    }
  });

  it("fails closed when a durable control is replayed by a different user", async () => {
    const fixture = await createFixture();
    try {
      const customId = await fixture.app.services.routes.issue({ guildId: "guild-1", actorId: "owner-1", action: "home" });
      const interaction = component(customId, "owner-2");

      await expect(routeComponent(interaction, fixture.app.services)).rejects.toMatchObject({ code: "ACTION_EXPIRED" });
    } finally {
      await fixture.app.stop();
    }
  });

  it("shows a team manager only the Player role while preserving their own-team assignment path", async () => {
    const fixture = await createFixture();
    try {
      const owner = await fixture.app.services.leagues.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", displayName: "Owner", manageGuild: true },
        name: "Hybrid League",
        defaultRosterCap: 12
      });
      const team = await fixture.app.services.teams.createTeam(owner, { name: "Northstar", rosterCap: 8 });
      const manager = await registerAndApprove(fixture.app, owner, "manager-1");
      const player = await registerAndApprove(fixture.app, owner, "player-1");
      await fixture.app.services.rosters.assignPlayerToTeam(owner, { teamId: team.id, playerId: manager.leagueMemberId, role: "MANAGER" });

      const open = component(await fixture.app.services.routes.issue({
        guildId: "guild-1", actorId: "manager-1", action: "roster.assign", entityId: team.id
      }), "manager-1");
      await routeComponent(open, fixture.app.services);
      const userSelect = open.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.type === "user-select");
      const choosePlayer = component(userSelect?.data.customId ?? "", "manager-1", undefined, ["player-1"]);
      await routeComponent(choosePlayer, fixture.app.services);
      const roleSelect = choosePlayer.edits.at(-1)?.components?.flatMap((row) => row.components)
        .find((control) => control.data.type === "select");

      expect(roleSelect?.data.options?.map((option) => option.value)).toEqual(["PLAYER"]);
      expect(player.leagueMemberId).toBeDefined();
    } finally {
      await fixture.app.stop();
    }
  });

  it("rejects a leadership confirmation if the actor loses team-management authority while selecting the player", async () => {
    const fixture = await createFixture();
    try {
      const owner = await fixture.app.services.leagues.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", displayName: "Owner", manageGuild: true },
        name: "Hybrid League",
        defaultRosterCap: 12
      });
      const team = await fixture.app.services.teams.createTeam(owner, { name: "Northstar", rosterCap: 8 });
      const manager = await registerAndApprove(fixture.app, owner, "manager-1");
      const player = await registerAndApprove(fixture.app, owner, "player-1");
      await fixture.app.services.rosters.assignPlayerToTeam(owner, {
        teamId: team.id,
        playerId: manager.leagueMemberId,
        role: "MANAGER"
      });
      await fixture.database.query(
        "INSERT INTO staff_assignments (id, league_id, league_member_id, role) VALUES ($1, $2, $3, $4)",
        ["00000000-0000-4000-8000-000000000099", owner.leagueId, manager.leagueMemberId, "ADMINISTRATOR"]
      );

      const initialContext = await fixture.app.services.leagues.resolveLeagueContext("guild-1", "manager-1");
      expect(initialContext?.actor.roles).toContain("ADMINISTRATOR");
      const confirmation = component(await fixture.app.services.routes.issue({
        guildId: "guild-1",
        actorId: "manager-1",
        action: "roster.assign.confirm",
        entityId: team.id,
        state: { discordUserId: "player-1", role: "CAPTAIN" }
      }), "manager-1");
      let authorityRevoked = false;
      const revokingServices: ApplicationServices = {
        ...fixture.app.services,
        leagues: {
          ...fixture.app.services.leagues,
          resolveLeagueContext: async (discordGuildId, discordUserId) => {
            if (discordUserId === "player-1" && !authorityRevoked) {
              authorityRevoked = true;
              await fixture.database.query(
                "UPDATE staff_assignments SET ended_at = NOW() WHERE league_id = $1 AND league_member_id = $2 AND role = $3",
                [owner.leagueId, manager.leagueMemberId, "ADMINISTRATOR"]
              );
            }
            return fixture.app.services.leagues.resolveLeagueContext(discordGuildId, discordUserId);
          }
        }
      };

      await expect(routeComponent(confirmation, revokingServices)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(fixture.app.services.rosters.listActiveTeamMemberships(owner, team.id))
        .resolves.toMatchObject([{ leagueMemberId: manager.leagueMemberId, role: "MANAGER" }]);
      expect(authorityRevoked).toBe(true);
      expect(player.leagueMemberId).toBeDefined();
    } finally {
      await fixture.app.stop();
    }
  });
});

async function createFixture() {
  const database = await createTestDatabase();
  const app = await createHybridApplication({
    database,
    discordClient: { login: async () => undefined, destroy: () => undefined },
    discordGateway: noOpGateway
  });
  return { app, database };
}

const noOpGateway: DiscordRoleGateway = {
  getMemberRoles: async () => [],
  addMemberRole: async () => undefined,
  removeMemberRole: async () => undefined,
  roleExists: async () => false
};

async function registerAndApprove(
  app: Awaited<ReturnType<typeof createHybridApplication>>,
  owner: LeagueContext,
  discordUserId: string
) {
  const player = await app.services.leagues.resolveLeagueContext("guild-1", discordUserId);
  if (!player) throw new Error("Expected player league context.");
  const registration = await app.services.registrations.requestRegistration(player, { displayName: discordUserId });
  await app.services.registrations.reviewRegistration(owner, { registrationId: registration.id, decision: "APPROVE" });
  return registration;
}

function component(
  customId: string,
  userId: string,
  fields?: Record<string, string>,
  values?: readonly string[]
): ComponentInteractionLike & { edits: InteractionReplyOptions[]; modals: ModalOptions[] } {
  const edits: InteractionReplyOptions[] = [];
  const modals: ModalOptions[] = [];
  return {
    customId,
    guildId: "guild-1",
    user: { id: userId, displayName: userId },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => Boolean(fields),
    deferUpdate: async () => undefined,
    editReply: async (options) => { edits.push(options); },
    reply: async () => undefined,
    showModal: async (options) => { modals.push(options); },
    ...(fields ? { fields: { getTextInputValue: (id: string) => fields[id] ?? "" } } : {}),
    ...(values ? { values } : {}),
    edits,
    modals
  };
}
