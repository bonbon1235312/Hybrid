import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAuditRepository } from "../../../src/modules/audit/repository.js";
import { createLeagueService } from "../../../src/modules/league/service.js";
import { createRegistrationService } from "../../../src/modules/registrations/service.js";
import { createTestDatabase } from "../../../src/platform/test-db.js";

describe("RegistrationService", () => {
  it("allows only one staff review to win a concurrent pending registration", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const registrations = createRegistrationService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const staffOne = ownerContext;
      const staffTwo = await seedStaffContext(database, leagues, ownerContext.leagueId, "guild-1", "staff-2");
      const playerContext = await resolvePlayerContext(leagues, "guild-1", "player-1");
      const registration = await registrations.requestRegistration(playerContext, { displayName: "Player One" });

      const results = await Promise.allSettled([
        registrations.reviewRegistration(staffOne, { registrationId: registration.id, decision: "APPROVE" }),
        registrations.reviewRegistration(staffTwo, { registrationId: registration.id, decision: "DECLINE" })
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected"))
        .toMatchObject({ reason: { code: "REGISTRATION_NOT_PENDING" } });
      await expect(registrations.getRegistration(ownerContext, registration.id))
        .resolves.toMatchObject({ status: expect.stringMatching(/APPROVED|DECLINED/) });
      await expect(audit.listEntityHistory(ownerContext, "registration", registration.id)).resolves.toHaveLength(2);
    } finally {
      await database.dispose();
    }
  });

  it("rejects a duplicate pending request and lets its player withdraw then retry", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const registrations = createRegistrationService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const playerContext = await resolvePlayerContext(leagues, "guild-1", "player-1");
      const registration = await registrations.requestRegistration(playerContext, { displayName: "Player One" });

      await expect(registrations.requestRegistration(playerContext, { displayName: "Player One" }))
        .rejects.toMatchObject({ code: "REGISTRATION_ALREADY_OPEN" });
      await expect(registrations.withdrawRegistration(playerContext, registration.id))
        .resolves.toMatchObject({ id: registration.id, status: "WITHDRAWN" });
      await expect(registrations.requestRegistration(playerContext, { displayName: "Player One Updated" }))
        .resolves.toMatchObject({ status: "PENDING", displayName: "Player One Updated" });
      await expect(audit.listEntityHistory(ownerContext, "registration", registration.id)).resolves.toMatchObject([
        { action: "registration.requested" },
        { action: "registration.withdrawn" }
      ]);
    } finally {
      await database.dispose();
    }
  });

  it("keeps pending queues and registration detail tenant-scoped", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const registrations = createRegistrationService(database, audit);

    try {
      const leagueAOwner = await leagues.bootstrapLeague(bootstrapInput("guild-a", "owner-a"));
      const leagueBOwner = await leagues.bootstrapLeague(bootstrapInput("guild-b", "owner-b"));
      const playerContext = await resolvePlayerContext(leagues, "guild-a", "player-1");
      const registration = await registrations.requestRegistration(playerContext, { displayName: "Player One" });

      await expect(registrations.getRegistration(leagueBOwner, registration.id))
        .rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
      await expect(registrations.listPendingRegistrations(leagueBOwner)).resolves.toEqual([]);
      await expect(registrations.listPendingRegistrations(leagueAOwner)).resolves.toMatchObject([
        { id: registration.id, displayName: "Player One", status: "PENDING" }
      ]);
    } finally {
      await database.dispose();
    }
  });

  it("does not grant registration review from Discord administrator state", async () => {
    const database = await createTestDatabase();
    const leagues = createLeagueService(database);
    const audit = createAuditRepository(database);
    const registrations = createRegistrationService(database, audit);

    try {
      const ownerContext = await leagues.bootstrapLeague(bootstrapInput("guild-1", "owner-1"));
      const playerContext = await resolvePlayerContext(leagues, "guild-1", "player-1");
      const registration = await registrations.requestRegistration(playerContext, { displayName: "Player One" });
      const discordAdministratorOnly = {
        ...playerContext,
        actor: { ...playerContext.actor, discordAdministrator: true }
      };

      await expect(registrations.reviewRegistration(
        discordAdministratorOnly,
        { registrationId: registration.id, decision: "APPROVE" }
      )).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(registrations.getRegistration(ownerContext, registration.id)).resolves.toMatchObject({ status: "PENDING" });
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

async function resolvePlayerContext(
  leagues: ReturnType<typeof createLeagueService>,
  discordGuildId: string,
  discordUserId: string
) {
  const context = await leagues.resolveLeagueContext(discordGuildId, discordUserId);

  if (!context) {
    throw new Error("Expected an existing league context");
  }
  return context;
}

async function seedStaffContext(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  leagues: ReturnType<typeof createLeagueService>,
  leagueId: string,
  discordGuildId: string,
  discordUserId: string
) {
  const memberId = randomUUID();

  await database.query("INSERT INTO discord_users (discord_user_id, display_name) VALUES ($1, $2)", [discordUserId, discordUserId]);
  await database.query(
    "INSERT INTO league_members (id, league_id, discord_user_id) VALUES ($1, $2, $3)",
    [memberId, leagueId, discordUserId]
  );
  await database.query(
    "INSERT INTO staff_assignments (id, league_id, league_member_id, role) VALUES ($1, $2, $3, $4)",
    [randomUUID(), leagueId, memberId, "STAFF"]
  );

  return resolvePlayerContext(leagues, discordGuildId, discordUserId);
}
