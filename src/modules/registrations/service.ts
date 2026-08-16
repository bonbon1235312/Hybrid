import { randomUUID } from "node:crypto";

import { withTransaction, type SqlTransaction, type TransactionalDatabase } from "../../platform/database.js";
import { DomainError } from "../../platform/errors.js";
import type { AuditRepository } from "../audit/types.js";
import type { LeagueContext } from "../league/types.js";
import { requirePermission } from "../permissions/service.js";
import type {
  Registration,
  RegistrationService,
  RegistrationStatus,
  RegistrationSummary,
  RequestRegistrationInput,
  ReviewRegistrationInput
} from "./types.js";

type RegistrationRow = Registration;

export function createRegistrationService(
  database: TransactionalDatabase,
  audit: AuditRepository
): RegistrationService {
  return {
    requestRegistration: async (context, input) => requestRegistration(database, audit, context, input),
    withdrawRegistration: async (context, registrationId) => withdrawRegistration(database, audit, context, registrationId),
    reviewRegistration: async (context, input) => reviewRegistration(database, audit, context, input),
    getRegistration: async (context, registrationId) => getRegistration(database, context, registrationId),
    getPendingRegistrationForActor: async (context) => getPendingRegistrationForActor(database, context),
    listPendingRegistrations: async (context) => listPendingRegistrations(database, context)
  };
}

async function requestRegistration(
  database: TransactionalDatabase,
  audit: AuditRepository,
  context: LeagueContext,
  input: RequestRegistrationInput
): Promise<Registration> {
  const displayName = validateDisplayName(input.displayName);

  return withTransaction(database, async (transaction) => {
    await transaction.query(
      `INSERT INTO discord_users (discord_user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, last_seen_at = NOW(), updated_at = NOW()`,
      [context.actor.discordUserId, displayName]
    );
    const member = await transaction.query<{ id: string }>(
      `INSERT INTO league_members (id, league_id, discord_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (league_id, discord_user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [randomUUID(), context.leagueId, context.actor.discordUserId]
    );
    const leagueMemberId = member.rows[0]?.id;

    if (!leagueMemberId) {
      throw new DomainError("LEAGUE_NOT_FOUND", "The league member could not be resolved.");
    }

    const created = await transaction.query<RegistrationRow>(
      `INSERT INTO registration_requests (id, league_id, league_member_id, display_name, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (league_id, league_member_id) WHERE status = 'PENDING' DO NOTHING
       RETURNING
         id,
         league_id AS "leagueId",
         league_member_id AS "leagueMemberId",
         display_name AS "displayName",
         status,
         requested_at AS "requestedAt",
         reviewed_at AS "reviewedAt",
         reviewed_by_member_id AS "reviewedByMemberId",
         declined_reason AS "declinedReason"`,
      [randomUUID(), context.leagueId, leagueMemberId, displayName, "PENDING"]
    );
    const registration = created.rows[0];

    if (!registration) {
      throw new DomainError("REGISTRATION_ALREADY_OPEN", "You already have a pending registration.");
    }

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      actorMemberId: leagueMemberId,
      entityType: "registration",
      entityId: registration.id,
      action: "registration.requested",
      afterState: { status: registration.status, displayName: registration.displayName }
    });

    return registration;
  });
}

async function withdrawRegistration(
  database: TransactionalDatabase,
  audit: AuditRepository,
  context: LeagueContext,
  registrationId: string
): Promise<Registration> {
  return withTransaction(database, async (transaction) => {
    const memberId = await findMemberId(transaction, context.leagueId, context.actor.discordUserId);
    const registration = await findRegistration(transaction, context.leagueId, registrationId, true);

    if (registration.leagueMemberId !== memberId) {
      throw new DomainError("FORBIDDEN", "You are not permitted to withdraw this registration.");
    }
    if (registration.status !== "PENDING") {
      throw new DomainError("REGISTRATION_NOT_PENDING", "This registration is no longer pending.");
    }

    const updated = await updateRegistrationStatus(
      transaction,
      context.leagueId,
      registrationId,
      "WITHDRAWN",
      null,
      null
    );

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      actorMemberId: memberId,
      entityType: "registration",
      entityId: registrationId,
      action: "registration.withdrawn",
      beforeState: { status: "PENDING" },
      afterState: { status: "WITHDRAWN" }
    });

    return updated;
  });
}

async function reviewRegistration(
  database: TransactionalDatabase,
  audit: AuditRepository,
  context: LeagueContext,
  input: ReviewRegistrationInput
): Promise<Registration> {
  requirePermission(context, "REGISTRATION_REVIEW");
  const reviewerMemberId = context.actor.leagueMemberId;

  if (!reviewerMemberId) {
    throw new DomainError("FORBIDDEN", "You are not permitted to review registrations.");
  }

  const status = reviewStatus(input.decision);
  const declinedReason = normalizedDeclinedReason(input);

  return withTransaction(database, async (transaction) => {
    const registration = await findRegistration(transaction, context.leagueId, input.registrationId, true);

    if (registration.status !== "PENDING") {
      throw new DomainError("REGISTRATION_NOT_PENDING", "This registration is no longer pending.");
    }

    const updated = await updateRegistrationStatus(
      transaction,
      context.leagueId,
      input.registrationId,
      status,
      reviewerMemberId,
      declinedReason
    );

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      actorMemberId: reviewerMemberId,
      entityType: "registration",
      entityId: input.registrationId,
      action: status === "APPROVED" ? "registration.approved" : "registration.declined",
      beforeState: { status: "PENDING" },
      afterState: {
        status,
        ...(declinedReason ? { declinedReason } : {})
      }
    });

    return updated;
  });
}

async function getRegistration(
  database: TransactionalDatabase,
  context: LeagueContext,
  registrationId: string
): Promise<Registration> {
  return database.transaction(async (transaction) => findRegistration(transaction, context.leagueId, registrationId, false));
}

async function getPendingRegistrationForActor(
  database: TransactionalDatabase,
  context: LeagueContext
): Promise<Registration | null> {
  const result = await database.transaction(async (transaction) => transaction.query<RegistrationRow>(
    `SELECT
       registration_requests.id,
       registration_requests.league_id AS "leagueId",
       registration_requests.league_member_id AS "leagueMemberId",
       registration_requests.display_name AS "displayName",
       registration_requests.status,
       registration_requests.requested_at AS "requestedAt",
       registration_requests.reviewed_at AS "reviewedAt",
       registration_requests.reviewed_by_member_id AS "reviewedByMemberId",
       registration_requests.declined_reason AS "declinedReason"
     FROM registration_requests
     JOIN league_members ON league_members.id = registration_requests.league_member_id
     WHERE registration_requests.league_id = $1
       AND league_members.discord_user_id = $2
       AND registration_requests.status = 'PENDING'
     ORDER BY registration_requests.requested_at DESC, registration_requests.id DESC
     LIMIT 1`,
    [context.leagueId, context.actor.discordUserId]
  ));

  return result.rows[0] ?? null;
}

async function listPendingRegistrations(
  database: TransactionalDatabase,
  context: LeagueContext
): Promise<RegistrationSummary[]> {
  requirePermission(context, "REGISTRATION_REVIEW");

  const result = await database.transaction(async (transaction) => transaction.query<RegistrationSummary>(
    `SELECT
       registration_requests.id,
       registration_requests.league_member_id AS "leagueMemberId",
       discord_users.discord_user_id AS "discordUserId",
       registration_requests.display_name AS "displayName",
       registration_requests.status,
       registration_requests.requested_at AS "requestedAt"
     FROM registration_requests
     JOIN league_members ON league_members.id = registration_requests.league_member_id
     JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
     WHERE registration_requests.league_id = $1 AND registration_requests.status = 'PENDING'
     ORDER BY registration_requests.requested_at ASC, registration_requests.id ASC`,
    [context.leagueId]
  ));

  return result.rows;
}

async function findMemberId(transaction: SqlTransaction, leagueId: string, discordUserId: string): Promise<string> {
  const result = await transaction.query<{ id: string }>(
    "SELECT id FROM league_members WHERE league_id = $1 AND discord_user_id = $2",
    [leagueId, discordUserId]
  );
  const memberId = result.rows[0]?.id;

  if (!memberId) {
    throw new DomainError("REGISTRATION_NOT_FOUND", "This registration was not found.");
  }
  return memberId;
}

async function findRegistration(
  transaction: SqlTransaction,
  leagueId: string,
  registrationId: string,
  lock: boolean
): Promise<Registration> {
  const result = await transaction.query<RegistrationRow>(
    `SELECT
       id,
       league_id AS "leagueId",
       league_member_id AS "leagueMemberId",
       display_name AS "displayName",
       status,
       requested_at AS "requestedAt",
       reviewed_at AS "reviewedAt",
       reviewed_by_member_id AS "reviewedByMemberId",
       declined_reason AS "declinedReason"
     FROM registration_requests
     WHERE league_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [leagueId, registrationId]
  );
  const registration = result.rows[0];

  if (!registration) {
    throw new DomainError("REGISTRATION_NOT_FOUND", "This registration was not found.");
  }
  return registration;
}

async function updateRegistrationStatus(
  transaction: SqlTransaction,
  leagueId: string,
  registrationId: string,
  status: RegistrationStatus,
  reviewerMemberId: string | null,
  declinedReason: string | null
): Promise<Registration> {
  const result = await transaction.query<RegistrationRow>(
    `UPDATE registration_requests
     SET status = $1,
         reviewed_at = CASE WHEN $1 IN ('APPROVED', 'DECLINED') THEN NOW() ELSE reviewed_at END,
         reviewed_by_member_id = $2,
         declined_reason = $3
     WHERE league_id = $4 AND id = $5 AND status = 'PENDING'
     RETURNING
       id,
       league_id AS "leagueId",
       league_member_id AS "leagueMemberId",
       display_name AS "displayName",
       status,
       requested_at AS "requestedAt",
       reviewed_at AS "reviewedAt",
       reviewed_by_member_id AS "reviewedByMemberId",
       declined_reason AS "declinedReason"`,
    [status, reviewerMemberId, declinedReason, leagueId, registrationId]
  );
  const registration = result.rows[0];

  if (!registration) {
    throw new DomainError("REGISTRATION_NOT_PENDING", "This registration is no longer pending.");
  }
  return registration;
}

function validateDisplayName(displayName: string): string {
  const normalized = displayName.trim().replace(/\s+/g, " ");

  if (!normalized) {
    throw new DomainError("INVALID_INPUT", "Display name is required.");
  }
  return normalized;
}

function reviewStatus(decision: ReviewRegistrationInput["decision"]): "APPROVED" | "DECLINED" {
  if (decision === "APPROVE") {
    return "APPROVED";
  }
  if (decision === "DECLINE") {
    return "DECLINED";
  }
  throw new DomainError("INVALID_INPUT", "Registration decision must be valid.");
}

function normalizedDeclinedReason(input: ReviewRegistrationInput): string | null {
  if (input.decision !== "DECLINE") {
    return null;
  }

  const reason = input.declinedReason?.trim();
  return reason || null;
}
