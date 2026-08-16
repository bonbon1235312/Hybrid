import { describe, expect, it } from "vitest";

import { withTransaction } from "../../src/platform/database.js";
import { createTestDatabase } from "../../src/platform/test-db.js";

describe("withTransaction", () => {
  it("rolls back all writes when application work fails", async () => {
    const database = await createTestDatabase();

    try {
      await expect(withTransaction(database, async (transaction) => {
        await transaction.query(
          "INSERT INTO leagues (id, discord_guild_id, name, default_roster_cap) VALUES ($1, $2, $3, $4)",
          ["00000000-0000-4000-8000-000000000201", "guild-rollback", "Rollback League", 12]
        );
        throw new Error("intentional failure");
      })).rejects.toThrow("intentional failure");

      const result = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM leagues");
      expect(result.rows).toEqual([{ count: "0" }]);
    } finally {
      await database.dispose();
    }
  });
});
