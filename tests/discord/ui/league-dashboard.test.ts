import { describe, expect, it } from "vitest";

import { renderLeagueDashboard } from "../../../src/discord/ui/league-dashboard.js";

describe("renderLeagueDashboard", () => {
  it("shows setup only to ManageGuild before a league exists", () => {
    const reply = renderLeagueDashboard({
      context: null,
      canManageGuild: false,
      teams: [],
      pendingRegistrations: []
    });

    expect(buttonLabels(reply)).not.toContain("Set up Hybrid");
  });

  it("gives an eligible unconfigured guild a compact setup path", () => {
    const reply = renderLeagueDashboard({
      context: null,
      canManageGuild: true,
      teams: [],
      pendingRegistrations: []
    });

    expect(buttonLabels(reply)).toContain("Set up Hybrid");
    expect(reply.ephemeral).toBe(true);
  });

  it("shows an actor-bound withdrawal route instead of a second registration request when the actor is pending", () => {
    const reply = renderLeagueDashboard({
      context: {
        leagueId: "league-1",
        discordGuildId: "guild-1",
        actor: { discordUserId: "player-1", leagueMemberId: "member-1", role: "PLAYER", roles: ["PLAYER"], managedTeamIds: [] }
      },
      canManageGuild: false,
      teams: [],
      pendingRegistrations: [],
      pendingRegistrationId: "registration-1"
    });

    expect(buttonLabels(reply)).toContain("Withdraw registration");
    expect(buttonLabels(reply)).not.toContain("Register");
  });

  it("gives an owner a first-team creation control", () => {
    const reply = renderLeagueDashboard({ context: { leagueId: "league-1", discordGuildId: "guild-1", actor: { discordUserId: "owner-1", role: "OWNER", roles: ["OWNER"], managedTeamIds: [] } }, canManageGuild: false, teams: [], pendingRegistrations: [] });
    expect(buttonLabels(reply)).toContain("Create team");
  });
});

function buttonLabels(reply: { components?: readonly { components: readonly { data?: { label?: string } }[] }[] }): string[] {
  return reply.components?.flatMap((row) => row.components.map((component) => component.data?.label ?? "")) ?? [];
}
