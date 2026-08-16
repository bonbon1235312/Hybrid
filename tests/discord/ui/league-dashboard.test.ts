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
});

function buttonLabels(reply: { components?: readonly { components: readonly { data?: { label?: string } }[] }[] }): string[] {
  return reply.components?.flatMap((row) => row.components.map((component) => component.data?.label ?? "")) ?? [];
}
