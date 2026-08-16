import { describe, expect, it } from "vitest";

import { requirePermission } from "../../../src/modules/permissions/service.js";
import type { LeagueContext } from "../../../src/modules/league/types.js";

describe("requirePermission", () => {
  it("does not allow a Discord administrator alone to review registration", () => {
    const context = seedLeagueContext({ role: "PLAYER", discordAdministrator: true });

    expect(() => requirePermission(context, "REGISTRATION_REVIEW")).toThrow(/not permitted/i);
  });

  it("allows Hybrid staff to review registrations", () => {
    const context = seedLeagueContext({ role: "STAFF" });

    expect(() => requirePermission(context, "REGISTRATION_REVIEW")).not.toThrow();
  });

  it("allows only owners to change league settings", () => {
    expect(() => requirePermission(seedLeagueContext({ role: "ADMINISTRATOR" }), "LEAGUE_SETTINGS"))
      .toThrow(/not permitted/i);
    expect(() => requirePermission(seedLeagueContext({ role: "OWNER" }), "LEAGUE_SETTINGS"))
      .not.toThrow();
  });

  it("allows managers to manage rosters but not teams", () => {
    const context = seedLeagueContext({ role: "MANAGER" });

    expect(() => requirePermission(context, "ROSTER_MANAGE")).not.toThrow();
    expect(() => requirePermission(context, "TEAM_MANAGE")).toThrow(/not permitted/i);
  });
});

function seedLeagueContext(input: { role: LeagueContext["actor"]["role"]; discordAdministrator?: boolean }): LeagueContext {
  return {
    leagueId: "00000000-0000-4000-8000-000000000001",
    discordGuildId: "guild-1",
    actor: {
      discordUserId: "player-1",
      leagueMemberId: "00000000-0000-4000-8000-000000000011",
      role: input.role,
      roles: [input.role],
      managedTeamIds: [],
      ...(input.discordAdministrator === undefined ? {} : { discordAdministrator: input.discordAdministrator })
    }
  };
}
