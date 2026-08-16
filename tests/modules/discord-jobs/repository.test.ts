import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDiscordJobRepository } from "../../../src/modules/discord-jobs/repository.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { withTransaction, type TransactionalDatabase } from "../../../src/platform/database.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("DiscordJobRepository", () => {
  it("coalesces incomplete role-sync work and claims it with a lease", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const jobs = createDiscordJobRepository(database);

    try {
      const owner = await leagues.bootstrapLeague(bootstrapInput());
      const membershipId = randomUUID();

      await withTransaction(database, async (transaction) => {
        await jobs.enqueueRoleSync(transaction, {
          leagueId: owner.leagueId,
          membershipId,
          discordUserId: "player-1",
          operation: "ASSIGN"
        });
        await jobs.enqueueRoleSync(transaction, {
          leagueId: owner.leagueId,
          membershipId,
          discordUserId: "player-1",
          operation: "REMOVE"
        });
      });

      await expect(jobs.listByDeduplicationKey(`role-sync:${membershipId}`)).resolves.toMatchObject([
        { status: "QUEUED", payload: { operation: "REMOVE" } }
      ]);
      await expect(jobs.claimDiscordJobs("worker-1", 1, 30)).resolves.toMatchObject([
        { status: "LEASED", leaseOwner: "worker-1", attemptCount: 1 }
      ]);
    } finally {
      await database.dispose();
    }
  });

  it("preserves completed role-sync history before enqueueing a new reconciliation job", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const jobs = createDiscordJobRepository(database);

    try {
      const owner = await leagues.bootstrapLeague(bootstrapInput());
      const membershipId = randomUUID();

      await withTransaction(database, async (transaction) => {
        await jobs.enqueueRoleSync(transaction, {
          leagueId: owner.leagueId,
          membershipId,
          discordUserId: "player-1",
          operation: "ASSIGN"
        });
      });
      await database.query(
        "UPDATE discord_jobs SET status = 'COMPLETED', completed_at = NOW() WHERE deduplication_key = $1",
        [`role-sync:${membershipId}`]
      );
      await withTransaction(database, async (transaction) => {
        await jobs.enqueueRoleSync(transaction, {
          leagueId: owner.leagueId,
          membershipId,
          discordUserId: "player-1",
          operation: "REMOVE"
        });
      });

      const jobsForMembership = await database.query<{ status: string }>(
        "SELECT status FROM discord_jobs WHERE deduplication_key LIKE $1 ORDER BY status",
        [`role-sync:${membershipId}%`]
      );
      expect(jobsForMembership.rows).toEqual([{ status: "COMPLETED" }, { status: "QUEUED" }]);
    } finally {
      await database.dispose();
    }
  });

  it("coalesces parallel enqueue attempts after both callers observe no prior job", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const jobs = createDiscordJobRepository(database);
    const racingDatabase = hideExistingJobLookup(database);
    const racingJobs = createDiscordJobRepository(racingDatabase);

    try {
      const owner = await leagues.bootstrapLeague(bootstrapInput());
      const membershipId = randomUUID();
      const input = {
        leagueId: owner.leagueId,
        membershipId,
        discordUserId: "player-1",
        operation: "ASSIGN" as const
      };

      const results = await Promise.allSettled([
        withTransaction(racingDatabase, async (transaction) => racingJobs.enqueueRoleSync(transaction, input)),
        withTransaction(racingDatabase, async (transaction) => racingJobs.enqueueRoleSync(transaction, input))
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      await expect(jobs.listByDeduplicationKey(`role-sync:${membershipId}`)).resolves.toHaveLength(1);
    } finally {
      await database.dispose();
    }
  });
});

function bootstrapInput() {
  return {
    discordGuildId: "guild-1",
    actor: { discordUserId: "owner-1", displayName: "Owner One", manageGuild: true },
    name: "Hybrid League",
    defaultRosterCap: 12
  };
}

function hideExistingJobLookup(database: TransactionalDatabase): TransactionalDatabase {
  let remainingHiddenLookups = 2;

  return {
    transaction: async (work) => database.transaction(async (transaction) => work({
      query: async (statement, parameters) => {
        if (
          remainingHiddenLookups > 0
          && statement.includes("FROM discord_jobs\n     WHERE deduplication_key = $1\n     FOR UPDATE")
        ) {
          remainingHiddenLookups -= 1;
          return { rows: [] };
        }
        return transaction.query(statement, parameters);
      }
    }))
  };
}
