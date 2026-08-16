import { describe, expect, it } from "vitest";

import { createDiscordRoleGateway } from "../../src/discord/client.js";

describe("createDiscordRoleGateway", () => {
  it("never treats a guild ID as an assignable Discord role", async () => {
    const setCalls: string[][] = [];
    const member = {
      roles: {
        cache: new Map([["guild-1", {}], ["role-team", {}]]),
        set: async (roleIds: string[]) => { setCalls.push(roleIds); }
      }
    };
    const guild = {
      id: "guild-1",
      members: { fetch: async () => member },
      roles: { fetch: async () => ({ id: "guild-1" }) }
    };
    const client = {
      guilds: { fetch: async () => guild }
    };
    const gateway = createDiscordRoleGateway(client as never);

    await gateway.setMemberRoles("guild-1", "player-1", ["guild-1", "role-team"]);

    expect(setCalls).toEqual([["role-team"]]);
    await expect(gateway.roleExists("guild-1", "guild-1")).resolves.toBe(false);
    await expect(gateway.getMemberRoles("guild-1", "player-1")).resolves.toEqual(["role-team"]);
  });
});
