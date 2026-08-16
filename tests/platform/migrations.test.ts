import { describe, expect, it } from "vitest";

import { createTestDatabase } from "../../src/platform/test-db.js";

describe("forward migrations", () => {
  it("applies the tenant-safe closer foreign key and rejects a cross-league closer", async () => {
    const database = await createTestDatabase();
    try {
      const constraint = await database.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conname = 'team_memberships_ended_by_member_fk'"
      );
      expect(constraint.rows).toEqual([{ conname: "team_memberships_ended_by_member_fk" }]);

      await database.query("INSERT INTO leagues (id, discord_guild_id, name, default_roster_cap) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)", [
        "00000000-0000-4000-8000-000000000001", "guild-a", "League A", 12,
        "00000000-0000-4000-8000-000000000002", "guild-b", "League B", 12
      ]);
      await database.query("INSERT INTO discord_users (discord_user_id, display_name) VALUES ($1, $2), ($3, $4)", ["member-a", "Member A", "member-b", "Member B"]);
      await database.query("INSERT INTO league_members (id, league_id, discord_user_id) VALUES ($1, $2, $3), ($4, $5, $6)", [
        "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000001", "member-a",
        "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000002", "member-b"
      ]);
      await database.query("INSERT INTO teams (id, league_id, name, normalized_name, roster_cap) VALUES ($1, $2, $3, $4, $5)", [
        "00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000001", "North", "north", 12
      ]);
      await database.query("INSERT INTO team_memberships (id, league_id, league_member_id, team_id, membership_role) VALUES ($1, $2, $3, $4, $5)", [
        "00000000-0000-4000-8000-000000000031", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000021", "PLAYER"
      ]);

      await expect(database.query("UPDATE team_memberships SET ended_by_member_id = $1 WHERE id = $2", [
        "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000031"
      ])).rejects.toThrow(/team_memberships_ended_by_member_fk/);
    } finally {
      await database.dispose();
    }
  });
});
