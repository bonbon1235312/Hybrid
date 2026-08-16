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
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name), last_seen_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)`,
      [context.actor.discordUserId, displayName]
    );
    await transaction.query(
      `INSERT INTO league_members (id, league_id, discord_user_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)`,
      [randomUUID(), context.leagueId, context.actor.discordUserId]
    );
    const member = await transaction.query<{ id: string }>(
      "SELECT id FROM league_members WHERE league_id = ? AND discord_user_id = ?",
      [context.leagueId, context.actor.discordUserId]
    );
    const leagueMemberId = member.rows[0]?.id;

    if (!leagueMemberId) {
      throw new DomainError("LEAGUE_NOT_FOUND", "The league member could not be resolved.");
    }

    const registrationId = randomUUID();
    try {
      await transaction.query(
        `INSERT INTO registration_requests (id, league_id, league_member_id, display_name, status)
         VALUES (?, ?, ?, ?, ?)`,
        [registrationId, context.leagueId, leagueMemberId, displayName, "PENDING"]
      );
    } catch (error) {
      if (isDuplicateKey(error, "open_registration_per_league")) {
        throw new DomainError("REGISTRATION_ALREADY_OPEN", "You already have a pending registration.");
      }
      throw error;
    }
    const registration = await findRegistration(transaction, context.leagueId, registrationId, false);

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
       registration_requests.league_id AS leagueId,
       registration_requests.league_member_id AS leagueMemberId,
       registration_requests.display_name AS displayName,
       registration_requests.status,
       registration_requests.requested_at AS requestedAt,
       registration_requests.reviewed_at AS reviewedAt,
       registration_requests.reviewed_by_member_id AS reviewedByMemberId,
       registration_requests.declined_reason AS declinedReason
     FROM registration_requests
     JOIN league_members ON league_members.id = registration_requests.league_member_id
     WHERE registration_requests.league_id = ?
       AND league_members.discord_user_id = ?
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
       registration_requests.league_member_id AS leagueMemberId,
       discord_users.discord_user_id AS discordUserId,
       registration_requests.display_name AS displayName,
       registration_requests.status,
       registration_requests.requested_at AS requestedAt
     FROM registration_requests
     JOIN league_members ON league_members.id = registration_requests.league_member_id
     JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
     WHERE registration_requests.league_id = ? AND registration_requests.status = 'PENDING'
     ORDER BY registration_requests.requested_at ASC, registration_requests.id ASC`,
    [context.leagueId]
  ));

  return result.rows;
}

async function findMemberId(transaction: SqlTransaction, leagueId: string, discordUserId: string): Promise<string> {
  const result = await transaction.query<{ id: string }>(
    "SELECT id FROM league_members WHERE league_id = ? AND discord_user_id = ?",
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
       league_id AS leagueId,
       league_member_id AS leagueMemberId,
       display_name AS displayName,
       status,
       requested_at AS requestedAt,
       reviewed_at AS reviewedAt,
       reviewed_by_member_id AS reviewedByMemberId,
       declined_reason AS declinedReason
     FROM registration_requests
     WHERE league_id = ? AND id = ?${lock ? " FOR UPDATE" : ""}`,
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
  const result = await transaction.query(
    `UPDATE registration_requests
     SET status = ?,
         reviewed_at = CASE WHEN ? IN ('APPROVED', 'DECLINED') THEN UTC_TIMESTAMP(3) ELSE reviewed_at END,
         reviewed_by_member_id = ?,
         declined_reason = ?
     WHERE league_id = ? AND id = ? AND status = 'PENDING'`,
    [status, status, reviewerMemberId, declinedReason, leagueId, registrationId]
  );

  if (result.affectedRows !== 1) {
    throw new DomainError("REGISTRATION_NOT_PENDING", "This registration is no longer pending.");
  }
  return findRegistration(transaction, leagueId, registrationId, false);
}

function isDuplicateKey(error: unknown, indexName: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ER_DUP_ENTRY"
    && "message" in error
    && typeof (error as { message?: unknown }).message === "string"
    && (error as { message: string }).message.includes(indexName);
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
