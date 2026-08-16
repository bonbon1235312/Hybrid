import { describe, expect, it } from "vitest";

import { encodeComponentId } from "../../src/discord/ui/ids.js";
import { routeComponent } from "../../src/discord/router.js";
import type { ApplicationServices, ComponentInteractionLike } from "../../src/discord/types.js";

describe("handleInteraction component routing", () => {
  it("rejects stale component actions", async () => {
    const staleApproveButton = encodeComponentId({
      action: "registration.approve",
      entityId: "registration-1",
      actorId: "player-1",
      version: 1,
      expiresAt: Date.now() - 1
    });
    const playerInteraction: ComponentInteractionLike = {
      customId: staleApproveButton,
      guildId: "guild-1",
      user: { id: "player-1", displayName: "Player One" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
      reply: async () => undefined,
      showModal: async () => undefined
    };

    await expect(routeComponent(playerInteraction, {} as ApplicationServices))
      .rejects.toMatchObject({ code: "ACTION_EXPIRED" });
  });

  it("rejects a component issued to another Discord user", async () => {
    const route = encodeComponentId({
      action: "home",
      actorId: "owner-1",
      version: 1,
      expiresAt: Date.now() + 60_000
    });
    const interaction: ComponentInteractionLike = {
      customId: route,
      guildId: "guild-1",
      user: { id: "player-1", displayName: "Player One" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
      reply: async () => undefined,
      showModal: async () => undefined
    };

    await expect(routeComponent(interaction, {} as ApplicationServices))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
