import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAuditRepository } from "../../../src/modules/audit/repository.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { withTransaction } from "../../../src/platform/database.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("AuditRepository", () => {
  it("lists immutable history only from the caller's league", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const sharedEntityId = randomUUID();

    try {
      const leagueA = await leagues.bootstrapLeague(bootstrapInput("guild-a", "owner-a"));
      const leagueB = await leagues.bootstrapLeague(bootstrapInput("guild-b", "owner-b"));
      const leagueAActorMemberId = leagueA.actor.leagueMemberId;
      const leagueBActorMemberId = leagueB.actor.leagueMemberId;

      if (!leagueAActorMemberId || !leagueBActorMemberId) {
        throw new Error("Expected bootstrap owners to be league members");
      }

      await withTransaction(database, async (transaction) => {
        await audit.appendAuditEvent(transaction, {
          leagueId: leagueA.leagueId,
          actorMemberId: leagueAActorMemberId,
          entityType: "team",
          entityId: sharedEntityId,
          action: "team.updated",
          afterState: { rosterCap: 12 }
        });
        await audit.appendAuditEvent(transaction, {
          leagueId: leagueB.leagueId,
          actorMemberId: leagueBActorMemberId,
          entityType: "team",
          entityId: sharedEntityId,
          action: "team.updated",
          afterState: { rosterCap: 99 }
        });
      });

      await expect(audit.listEntityHistory(leagueA, "team", sharedEntityId)).resolves.toEqual([
        expect.objectContaining({
          action: "team.updated",
          actorDiscordUserId: "owner-a",
          afterState: { rosterCap: 12 }
        })
      ]);
    } finally {
      await database.dispose();
    }
  });
});

function bootstrapInput(discordGuildId: string, discordUserId: string) {
  return {
    discordGuildId,
    actor: { discordUserId, displayName: discordUserId, manageGuild: true },
    name: `League ${discordGuildId}`,
    defaultRosterCap: 12
  };
}
