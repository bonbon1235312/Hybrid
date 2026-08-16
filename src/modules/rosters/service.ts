import { randomUUID } from "node:crypto";

import { withTransaction, type SqlTransaction, type TransactionalDatabase } from "../../platform/database.js";
import { DomainError } from "../../platform/errors.js";
import type { AuditRepository } from "../audit/types.js";
import type { DiscordJobRepository } from "../discord-jobs/repository.js";
import type { LeagueContext } from "../league/types.js";
import { requirePermission } from "../permissions/service.js";
import type {
  AssignPlayerToTeamInput,
  EndTeamMembershipInput,
  RosterService,
  TeamMembership,
  TeamMembershipRole
} from "./types.js";

type TeamRow = {
  id: string;
  rosterCap: number;
  status: "ACTIVE" | "INACTIVE";
};

type PlayerRow = {
  id: string;
  discordUserId: string;
};

type TeamMembershipRow = TeamMembership;

export function createRosterService(
  database: TransactionalDatabase,
  audit: AuditRepository,
  jobs: DiscordJobRepository
): RosterService {
  return {
    assignPlayerToTeam: async (context, input) => assignPlayerToTeam(database, audit, jobs, context, input),
    endTeamMembership: async (context, input) => endTeamMembership(database, audit, jobs, context, input),
    listActiveTeamMemberships: async (context, teamId) => listActiveTeamMemberships(database, context, teamId),
    getActiveTeamMembership: async (context, membershipId) => getActiveTeamMembership(database, context, membershipId)
  };
}

async function listActiveTeamMemberships(
  database: TransactionalDatabase,
  context: LeagueContext,
  teamId: string
): Promise<TeamMembership[]> {
  return withTransaction(database, async (transaction) => {
    const team = await findTeam(transaction, context.leagueId, teamId, false);
    requirePermission(context, "ROSTER_MANAGE", team.id);
    const result = await transaction.query<TeamMembershipRow>(
      `SELECT
         id,
         league_id AS "leagueId",
         league_member_id AS "leagueMemberId",
         team_id AS "teamId",
         membership_role AS role,
         status,
         ended_at AS "endedAt",
         ended_by_member_id AS "endedByMemberId"
       FROM team_memberships
       WHERE league_id = $1 AND team_id = $2 AND status = 'ACTIVE'
       ORDER BY id`,
      [context.leagueId, team.id]
    );
    return result.rows;
  });
}

async function getActiveTeamMembership(
  database: TransactionalDatabase,
  context: LeagueContext,
  membershipId: string
): Promise<TeamMembership> {
  return withTransaction(database, async (transaction) => {
    const membership = await findMembership(transaction, context.leagueId, membershipId, false);
    requirePermission(context, "ROSTER_MANAGE", membership.teamId);
    if (membership.status !== "ACTIVE") {
      throw new DomainError("TEAM_MEMBERSHIP_NOT_ACTIVE", "This team membership is no longer active.");
    }
    return membership;
  });
}

async function assignPlayerToTeam(
  database: TransactionalDatabase,
  audit: AuditRepository,
  jobs: DiscordJobRepository,
  context: LeagueContext,
  input: AssignPlayerToTeamInput
): Promise<TeamMembership> {
  validateMembershipRole(input.role);

  return withTransaction(database, async (transaction) => {
    const team = await findTeam(transaction, context.leagueId, input.teamId, true);
    requirePermission(context, "ROSTER_MANAGE", team.id);

    if (team.status !== "ACTIVE") {
      throw new DomainError("TEAM_NOT_ACTIVE", "This team is not active.");
    }

    const player = await findApprovedPlayer(transaction, context.leagueId, input.playerId);
    const existingMembership = await transaction.query<{ id: string }>(
      `SELECT id
       FROM team_memberships
       WHERE league_id = $1 AND league_member_id = $2 AND status = 'ACTIVE'
       FOR UPDATE`,
      [context.leagueId, player.id]
    );
    if (existingMembership.rows[0]) {
      throw new DomainError("PLAYER_ALREADY_ASSIGNED", "This player already has an active team membership.");
    }

    const rosterCount = await transaction.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM team_memberships WHERE league_id = $1 AND team_id = $2 AND status = 'ACTIVE'",
      [context.leagueId, team.id]
    );
    if (Number(rosterCount.rows[0]?.count ?? "0") >= team.rosterCap) {
      throw new DomainError("ROSTER_FULL", "This team has reached its roster cap.");
    }

    const membership = await insertMembership(transaction, context.leagueId, player.id, team.id, input.role);

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      entityType: "team_membership",
      entityId: membership.id,
      action: "roster.player_assigned",
      ...(context.actor.leagueMemberId ? { actorMemberId: context.actor.leagueMemberId } : {}),
      afterState: { teamId: membership.teamId, playerId: membership.leagueMemberId, role: membership.role }
    });
    await jobs.enqueueRoleSync(transaction, {
      leagueId: context.leagueId,
      membershipId: membership.id,
      discordUserId: player.discordUserId,
      operation: "ASSIGN"
    });

    return membership;
  });
}

async function endTeamMembership(
  database: TransactionalDatabase,
  audit: AuditRepository,
  jobs: DiscordJobRepository,
  context: LeagueContext,
  input: EndTeamMembershipInput
): Promise<TeamMembership> {
  return withTransaction(database, async (transaction) => {
    const membership = await findMembership(transaction, context.leagueId, input.membershipId, true);
    requirePermission(context, "ROSTER_MANAGE", membership.teamId);

    if (membership.status !== "ACTIVE") {
      throw new DomainError("TEAM_MEMBERSHIP_NOT_ACTIVE", "This team membership is no longer active.");
    }

    const player = await findPlayer(transaction, context.leagueId, membership.leagueMemberId);
    const ended = await transaction.query<TeamMembershipRow>(
      `UPDATE team_memberships
       SET status = 'ENDED', ended_at = NOW(), ended_by_member_id = $1
       WHERE id = $2 AND league_id = $3 AND status = 'ACTIVE'
       RETURNING
         id,
         league_id AS "leagueId",
         league_member_id AS "leagueMemberId",
         team_id AS "teamId",
         membership_role AS role,
         status,
         ended_at AS "endedAt",
         ended_by_member_id AS "endedByMemberId"`,
      [context.actor.leagueMemberId ?? null, membership.id, context.leagueId]
    );
    const updated = ended.rows[0];

    if (!updated) {
      throw new DomainError("TEAM_MEMBERSHIP_NOT_ACTIVE", "This team membership is no longer active.");
    }

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      entityType: "team_membership",
      entityId: membership.id,
      action: "roster.player_removed",
      ...(context.actor.leagueMemberId ? { actorMemberId: context.actor.leagueMemberId } : {}),
      beforeState: { teamId: membership.teamId, playerId: membership.leagueMemberId, role: membership.role },
      afterState: { status: "ENDED" }
    });
    await jobs.enqueueRoleSync(transaction, {
      leagueId: context.leagueId,
      membershipId: membership.id,
      discordUserId: player.discordUserId,
      operation: "REMOVE"
    });

    return updated;
  });
}

async function findTeam(
  transaction: SqlTransaction,
  leagueId: string,
  teamId: string,
  lock: boolean
): Promise<TeamRow> {
  const result = await transaction.query<TeamRow>(
    `SELECT id, roster_cap AS "rosterCap", status
     FROM teams
     WHERE league_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [leagueId, teamId]
  );
  const team = result.rows[0];

  if (!team) {
    throw new DomainError("TEAM_NOT_FOUND", "This team was not found.");
  }
  return team;
}

async function findApprovedPlayer(transaction: SqlTransaction, leagueId: string, playerId: string): Promise<PlayerRow> {
  const player = await findActivePlayer(transaction, leagueId, playerId);
  const approved = await transaction.query<{ id: string }>(
    `SELECT id
     FROM registration_requests
     WHERE league_id = $1 AND league_member_id = $2 AND status = 'APPROVED'
     ORDER BY reviewed_at DESC NULLS LAST
     LIMIT 1`,
    [leagueId, player.id]
  );

  if (!approved.rows[0]) {
    throw new DomainError("PLAYER_NOT_APPROVED", "This player does not have an approved registration.");
  }
  return player;
}

async function findActivePlayer(transaction: SqlTransaction, leagueId: string, playerId: string): Promise<PlayerRow> {
  const result = await transaction.query<PlayerRow>(
    `SELECT
       league_members.id,
       discord_users.discord_user_id AS "discordUserId"
     FROM league_members
     JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
     WHERE league_members.league_id = $1
       AND league_members.id = $2
       AND league_members.status = 'ACTIVE'
     FOR UPDATE`,
    [leagueId, playerId]
  );
  const player = result.rows[0];

  if (!player) {
    throw new DomainError("PLAYER_NOT_APPROVED", "This player does not have an approved registration.");
  }
  return player;
}

async function findPlayer(transaction: SqlTransaction, leagueId: string, playerId: string): Promise<PlayerRow> {
  const result = await transaction.query<PlayerRow>(
    `SELECT
       league_members.id,
       discord_users.discord_user_id AS "discordUserId"
     FROM league_members
     JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
     WHERE league_members.league_id = $1 AND league_members.id = $2
     FOR UPDATE`,
    [leagueId, playerId]
  );
  const player = result.rows[0];

  if (!player) {
    throw new DomainError("PLAYER_NOT_APPROVED", "This player does not have an approved registration.");
  }
  return player;
}

async function findMembership(
  transaction: SqlTransaction,
  leagueId: string,
  membershipId: string,
  lock: boolean
): Promise<TeamMembership> {
  const result = await transaction.query<TeamMembershipRow>(
    `SELECT
       id,
       league_id AS "leagueId",
       league_member_id AS "leagueMemberId",
       team_id AS "teamId",
       membership_role AS role,
       status,
       ended_at AS "endedAt",
       ended_by_member_id AS "endedByMemberId"
     FROM team_memberships
     WHERE league_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [leagueId, membershipId]
  );
  const membership = result.rows[0];

  if (!membership) {
    throw new DomainError("TEAM_MEMBERSHIP_NOT_FOUND", "This team membership was not found.");
  }
  return membership;
}

async function insertMembership(
  transaction: SqlTransaction,
  leagueId: string,
  leagueMemberId: string,
  teamId: string,
  role: TeamMembershipRole
): Promise<TeamMembership> {
  try {
    const result = await transaction.query<TeamMembershipRow>(
      `INSERT INTO team_memberships (id, league_id, league_member_id, team_id, membership_role, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING
         id,
         league_id AS "leagueId",
         league_member_id AS "leagueMemberId",
         team_id AS "teamId",
         membership_role AS role,
         status,
         ended_at AS "endedAt",
         ended_by_member_id AS "endedByMemberId"`,
      [randomUUID(), leagueId, leagueMemberId, teamId, role, "ACTIVE"]
    );
    const membership = result.rows[0];

    if (!membership) {
      throw new DomainError("TEAM_MEMBERSHIP_NOT_FOUND", "The new team membership could not be resolved.");
    }
    return membership;
  } catch (error) {
    if (isActiveMembershipViolation(error)) {
      throw new DomainError("PLAYER_ALREADY_ASSIGNED", "This player already has an active team membership.");
    }
    throw error;
  }
}

function validateMembershipRole(role: TeamMembershipRole): void {
  if (role !== "PLAYER" && role !== "MANAGER" && role !== "CAPTAIN") {
    throw new DomainError("INVALID_INPUT", "Team membership role must be valid.");
  }
}

function isActiveMembershipViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505"
    && "constraint" in error
    && (error as { constraint?: unknown }).constraint === "active_team_membership_per_league";
}
