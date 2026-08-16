import { describe, expect, it } from "vitest";

import { leagues } from "../../src/platform/schema.js";
import { createTestDatabase } from "../../src/platform/test-db.js";

describe("League Core schema", () => {
  it("rejects a second active membership for the same player in one league", async () => {
    const database = await createTestDatabase();

    try {
      await seedLeague(database, "00000000-0000-4000-8000-000000000001", "guild-a");
      await seedPlayer(database, "player-1");
      await seedLeagueMember(database, "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000001", "player-1");
      await seedTeam(database, "00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000001", "Northstar");
      await seedTeam(database, "00000000-0000-4000-8000-000000000022", "00000000-0000-4000-8000-000000000001", "Southstar");
      await seedActiveMembership(database, "00000000-0000-4000-8000-000000000031", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000021");

      await expect(seedActiveMembership(
        database,
        "00000000-0000-4000-8000-000000000032",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000022"
      )).rejects.toThrow(/active_team_membership_per_league/);
    } finally {
      await database.dispose();
    }
  });

  it("rejects a membership that crosses league boundaries", async () => {
    const database = await createTestDatabase();

    try {
      await seedLeague(database, "00000000-0000-4000-8000-000000000101", "guild-a");
      await seedLeague(database, "00000000-0000-4000-8000-000000000102", "guild-b");
      await seedPlayer(database, "player-1");
      await seedLeagueMember(database, "00000000-0000-4000-8000-000000000111", "00000000-0000-4000-8000-000000000101", "player-1");
      await seedTeam(database, "00000000-0000-4000-8000-000000000121", "00000000-0000-4000-8000-000000000102", "Elsewhere");

      await expect(seedActiveMembership(
        database,
        "00000000-0000-4000-8000-000000000131",
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000111",
        "00000000-0000-4000-8000-000000000121"
      )).rejects.toThrow(/team_memberships_league_team_fk/);
    } finally {
      await database.dispose();
    }
  });

  it("maps migrated league records through the Drizzle schema", async () => {
    const database = await createTestDatabase();

    try {
      await seedLeague(database, "00000000-0000-4000-8000-000000000301", "guild-drizzle");

      const rows = await database.db.select().from(leagues);

      expect(rows).toEqual([expect.objectContaining({
        discordGuildId: "guild-drizzle",
        name: "Test League",
        defaultRosterCap: 12
      })]);
    } finally {
      await database.dispose();
    }
  });
});

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

async function seedLeague(database: TestDatabase, id: string, discordGuildId: string): Promise<void> {
  await database.query("INSERT INTO leagues (id, discord_guild_id, name, default_roster_cap) VALUES ($1, $2, $3, $4)", [id, discordGuildId, "Test League", 12]);
}

async function seedPlayer(database: TestDatabase, discordUserId: string): Promise<void> {
  await database.query("INSERT INTO discord_users (discord_user_id, display_name) VALUES ($1, $2)", [discordUserId, "Player One"]);
}

async function seedLeagueMember(database: TestDatabase, id: string, leagueId: string, discordUserId: string): Promise<void> {
  await database.query("INSERT INTO league_members (id, league_id, discord_user_id) VALUES ($1, $2, $3)", [id, leagueId, discordUserId]);
}

async function seedTeam(database: TestDatabase, id: string, leagueId: string, name: string): Promise<void> {
  await database.query(
    "INSERT INTO teams (id, league_id, name, normalized_name, roster_cap) VALUES ($1, $2, $3, $4, $5)",
    [id, leagueId, name, name.toLowerCase(), 12]
  );
}

async function seedActiveMembership(
  database: TestDatabase,
  id: string,
  leagueId: string,
  leagueMemberId: string,
  teamId: string
): Promise<void> {
  await database.query(
    "INSERT INTO team_memberships (id, league_id, league_member_id, team_id, membership_role, status) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, leagueId, leagueMemberId, teamId, "PLAYER", "ACTIVE"]
  );
}
