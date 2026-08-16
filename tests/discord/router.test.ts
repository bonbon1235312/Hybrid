import { describe, expect, it } from "vitest";

import { createHybridApplication } from "../../src/app.js";
import { routeComponent } from "../../src/discord/router.js";
import type { ComponentInteractionLike, InteractionReplyOptions, ModalOptions } from "../../src/discord/types.js";
import type { DiscordRoleGateway } from "../../src/modules/discord-jobs/worker.js";
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

      await expect(fixture.app.services.teams.listTeams(owner)).resolves.toMatchObject([{ name: "Northstar", rosterCap: 8 }]);
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

      await expect(fixture.app.services.rosters.listActiveTeamMemberships(owner, team.id))
        .resolves.toMatchObject([{ leagueMemberId: registration.leagueMemberId, role: "PLAYER" }]);
      expect(select.edits.at(-1)?.content).toBe("Player assigned. Discord role sync is queued.");
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
});

async function createFixture() {
  const database = await createTestDatabase();
  const app = await createHybridApplication({
    database,
    discordClient: { login: async () => undefined, destroy: () => undefined },
    discordGateway: noOpGateway
  });
  return { app };
}

const noOpGateway: DiscordRoleGateway = {
  getMemberRoles: async () => [],
  addMemberRole: async () => undefined,
  removeMemberRole: async () => undefined,
  roleExists: async () => false
};

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
