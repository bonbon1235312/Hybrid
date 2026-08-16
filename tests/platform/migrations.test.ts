import { describe, expect, it } from "vitest";

import { createTestDatabase } from "../../src/platform/test-db.js";

describe("forward migrations", () => {
  it("applies the tenant-safe closer foreign key", async () => {
    const database = await createTestDatabase();
    try {
      const constraint = await database.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conname = 'team_memberships_ended_by_member_fk'"
      );
      expect(constraint.rows).toEqual([{ conname: "team_memberships_ended_by_member_fk" }]);
    } finally {
      await database.dispose();
    }
  });
});
