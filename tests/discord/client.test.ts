import { describe, expect, it } from "vitest";

import { createDiscordRoleGateway } from "../../src/discord/client.js";

describe("createDiscordRoleGateway", () => {
  it("uses targeted role mutations and never treats @everyone as assignable", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const member = {
      roles: {
        cache: new Map([["guild-1", {}], ["role-team", {}]]),
        add: async (roleId: string) => { added.push(roleId); },
        remove: async (roleId: string) => { removed.push(roleId); }
      }
    };
    const guild = {
      id: "guild-1",
      members: { fetch: async () => member },
      roles: { fetch: async (roleId: string) => roleId === "role-team" ? { id: roleId } : null }
    };
    const client = { guilds: { fetch: async () => guild } };
    const gateway = createDiscordRoleGateway(client as never);

    await gateway.addMemberRole("guild-1", "player-1", "role-team");
    await gateway.addMemberRole("guild-1", "player-1", "guild-1");
    await gateway.removeMemberRole("guild-1", "player-1", "role-team");
    await gateway.removeMemberRole("guild-1", "player-1", "guild-1");

    expect(added).toEqual(["role-team"]);
    expect(removed).toEqual(["role-team"]);
    await expect(gateway.roleExists("guild-1", "guild-1")).resolves.toBe(false);
    await expect(gateway.getMemberRoles("guild-1", "player-1")).resolves.toEqual(["role-team"]);
  });
});
