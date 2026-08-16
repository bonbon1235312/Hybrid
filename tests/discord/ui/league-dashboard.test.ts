import { describe, expect, it, vi } from "vitest";

import { renderLeagueDashboard } from "../../../src/discord/ui/league-dashboard.js";

describe("renderLeagueDashboard", () => {
  it("shows setup only to ManageGuild before a league exists", async () => {
    const reply = await renderLeagueDashboard(baseInput({ context: null, canManageGuild: false }));

    expect(buttonLabels(reply)).not.toContain("Set up Hybrid");
  });

  it("gives an eligible unconfigured guild a compact setup path", async () => {
    const reply = await renderLeagueDashboard(baseInput({ context: null, canManageGuild: true }));

    expect(buttonLabels(reply)).toContain("Set up Hybrid");
    expect(reply.ephemeral).toBe(true);
  });

  it("shows an actor-bound withdrawal route instead of a second registration request when the actor is pending", async () => {
    const reply = await renderLeagueDashboard(baseInput({
      context: {
        leagueId: "league-1",
        discordGuildId: "guild-1",
        actor: { discordUserId: "player-1", leagueMemberId: "member-1", role: "PLAYER", roles: ["PLAYER"], managedTeamIds: [] }
      },
      canManageGuild: false,
      pendingRegistrationId: "registration-1"
    }));

    expect(buttonLabels(reply)).toContain("Withdraw registration");
    expect(buttonLabels(reply)).not.toContain("Register");
  });

  it("gives an owner a first-team creation control", async () => {
    const reply = await renderLeagueDashboard(baseInput({
      context: {
        leagueId: "league-1",
        discordGuildId: "guild-1",
        actor: { discordUserId: "owner-1", role: "OWNER", roles: ["OWNER"], managedTeamIds: [] }
      },
      canManageGuild: false
    }));

    expect(buttonLabels(reply)).toContain("Create team");
  });
});

function baseInput(overrides: Record<string, unknown>) {
  return {
    context: null,
    canManageGuild: false,
    teams: [],
    pendingRegistrations: [],
    guildId: "guild-1",
    routes: { issue: vi.fn(async () => "h3.opaque.signature") },
    ...overrides
  } as Parameters<typeof renderLeagueDashboard>[0];
}

function buttonLabels(reply: { components?: readonly { components: readonly { data?: { label?: string } }[] }[] }): string[] {
  return reply.components?.flatMap((row) => row.components.map((component) => component.data?.label ?? "")) ?? [];
}
