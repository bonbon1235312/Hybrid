import { describe, expect, it } from "vitest";

import { createRouteStore } from "../../../src/discord/ui/route-store.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

const signingKey = "a-stable-test-component-signing-key";

describe("durable component routes", () => {
  it("issues opaque IDs and allows a fresh route-store instance to consume the valid route once", async () => {
    const database = await createTestDatabase();
    try {
      const issuer = createRouteStore(database, signingKey);
      const customId = await issuer.issue({
        guildId: "guild-1",
        actorId: "owner-private-id",
        action: "team.create",
        entityId: "team-private-id",
        state: { internal: "never exposed" }
      });

      expect(customId).toMatch(/^h3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(customId.length).toBeLessThan(100);
      expect(customId).not.toContain("owner-private-id");
      expect(customId).not.toContain("team-private-id");
      expect(customId).not.toContain("team.create");

      const freshProcessStore = createRouteStore(database, signingKey);
      await expect(freshProcessStore.consume({ guildId: "guild-1", actorId: "owner-private-id", customId }))
        .resolves.toMatchObject({ action: "team.create", entityId: "team-private-id", state: { internal: "never exposed" } });
      await expect(freshProcessStore.consume({ guildId: "guild-1", actorId: "owner-private-id", customId })).resolves.toBeNull();
    } finally {
      await database.dispose();
    }
  });

  it("fails closed for a tampered, expired, cross-user, or cross-guild route", async () => {
    const database = await createTestDatabase();
    try {
      const store = createRouteStore(database, signingKey);
      const crossUser = await store.issue({ guildId: "guild-1", actorId: "owner-1", action: "home" });
      const crossGuild = await store.issue({ guildId: "guild-1", actorId: "owner-1", action: "home" });
      const expired = await store.issue({ guildId: "guild-1", actorId: "owner-1", action: "home" });
      const valid = await store.issue({ guildId: "guild-1", actorId: "owner-1", action: "home" });
      await database.query("UPDATE interaction_routes SET expires_at = NOW() - INTERVAL '1 second' WHERE nonce = $1", [expired.split(".")[1]]);

      await expect(store.consume({ guildId: "guild-1", actorId: "owner-2", customId: crossUser })).resolves.toBeNull();
      await expect(store.consume({ guildId: "guild-2", actorId: "owner-1", customId: crossGuild })).resolves.toBeNull();
      await expect(store.consume({ guildId: "guild-1", actorId: "owner-1", customId: expired })).resolves.toBeNull();
      await expect(store.consume({ guildId: "guild-1", actorId: "owner-1", customId: `${valid}x` })).resolves.toBeNull();
      await expect(store.consume({ guildId: "guild-1", actorId: "owner-1", customId: valid })).resolves.toMatchObject({ action: "home" });
    } finally {
      await database.dispose();
    }
  });
});
