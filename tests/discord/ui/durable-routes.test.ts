import { describe, expect, it } from "vitest";

import { decodeComponentId, encodeComponentId } from "../../../src/discord/ui/ids.js";
import { configureRouteStore, consumeDurableRoute } from "../../../src/discord/ui/route-store.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("durable component routes", () => {
  it("survives a fresh route-store configuration and rejects replay, tampering, and expiry", async () => {
    const database = await createTestDatabase();
    try {
      const context = { leagueId: "00000000-0000-4000-8000-000000000001", discordGuildId: "guild-1", actor: { discordUserId: "owner-1", role: "OWNER" as const, roles: ["OWNER" as const], managedTeamIds: [] } };
      await database.query("INSERT INTO leagues (id, discord_guild_id, name, default_roster_cap) VALUES ($1, $2, $3, $4)", [context.leagueId, "guild-1", "League", 2]);
      const token = encodeComponentId({ action: "home", actorId: "owner-1" });
      const route = decodeComponentId(token);
      if (!route) throw new Error("Expected signed route");
      configureRouteStore(database);
      expect(await consumeDurableRoute(context, route)).toBe(true);
      configureRouteStore(database);
      expect(await consumeDurableRoute(context, route)).toBe(false);
      expect(decodeComponentId(`${token}x`)).toBeNull();
      expect(decodeComponentId(encodeComponentId({ action: "home", actorId: "owner-1", expiresAt: Date.now() - 1 }))).toBeNull();
    } finally { await database.dispose(); }
  });
});
