import { randomUUID } from "node:crypto";

import { withTransaction, type SqlTransaction, type TransactionalDatabase } from "../../platform/database.js";
import { DomainError } from "../../platform/errors.js";
import { requirePermission } from "../permissions/service.js";
import type { AuditRepository } from "../audit/types.js";
import type { DiscordJobRepository } from "../discord-jobs/repository.js";
import type { LeagueContext } from "../league/types.js";
import type { CreateTeamInput, SetTeamDiscordRoleInput, TeamDashboard, TeamManager, TeamService, TeamStatus } from "./types.js";

type TeamRow = {
  id: string;
  name: string;
  rosterCap: number;
  status: TeamStatus;
  discordRoleId: string | null;
  discordRoleState: "AVAILABLE" | "UNAVAILABLE" | "UNMAPPED";
};

type TeamManagerRow = TeamManager;

type ActiveMembershipRow = Readonly<{
  membershipId: string;
  discordUserId: string;
}>;

export function createTeamService(
  database: TransactionalDatabase,
  audit: AuditRepository,
  jobs: DiscordJobRepository
): TeamService {
  return {
    createTeam: async (context, input) => createTeam(database, audit, context, input),
    getTeamDashboard: async (context, teamId) => getTeamDashboard(database, context, teamId),
    listTeams: async (context) => listTeams(database, context),
    setTeamStatus: async (context, teamId, status) => setTeamStatus(database, audit, context, teamId, status),
    setTeamDiscordRole: async (context, input) => setTeamDiscordRole(database, audit, jobs, context, input)
  };
}

async function setTeamDiscordRole(
  database: TransactionalDatabase,
  audit: AuditRepository,
  jobs: DiscordJobRepository,
  context: LeagueContext,
  input: SetTeamDiscordRoleInput
): Promise<TeamDashboard> {
  requirePermission(context, "TEAM_MANAGE");
  const discordRoleId = validateDiscordRoleId(context, input.discordRoleId);

  await withTransaction(database, async (transaction) => {
    const current = await findTeam(transaction, context.leagueId, input.teamId, true);
    await ensureDiscordRoleIsAvailable(transaction, context.leagueId, current.id, discordRoleId);

    let mapped: TeamRow;
    try {
      const result = await transaction.query(
        `UPDATE teams
         SET discord_role_id = ?, discord_role_state = 'AVAILABLE', updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND league_id = ?`,
        [discordRoleId, current.id, context.leagueId]
      );
      if (result.affectedRows !== 1) {
        missingTeam();
      }
      mapped = await findTeam(transaction, context.leagueId, current.id);
    } catch (error) {
      const domainError = toTeamConflictError(error);
      if (domainError) {
        throw domainError;
      }
      throw error;
    }

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      entityType: "team",
      entityId: current.id,
      action: "team.discord_role_mapped",
      ...(context.actor.leagueMemberId ? { actorMemberId: context.actor.leagueMemberId } : {}),
      beforeState: { discordRoleId: current.discordRoleId, discordRoleState: current.discordRoleState },
      afterState: { discordRoleId: mapped.discordRoleId, discordRoleState: mapped.discordRoleState }
    });

    const memberships = await transaction.query<ActiveMembershipRow>(
      `SELECT
         team_memberships.id AS membershipId,
         discord_users.discord_user_id AS discordUserId
       FROM team_memberships
       JOIN league_members ON league_members.id = team_memberships.league_member_id
       JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
       WHERE team_memberships.league_id = ?
         AND team_memberships.team_id = ?
         AND team_memberships.status = 'ACTIVE'
         AND league_members.status = 'ACTIVE'`,
      [context.leagueId, current.id]
    );
    for (const membership of memberships.rows) {
      await jobs.enqueueRoleSync(transaction, {
        leagueId: context.leagueId,
        membershipId: membership.membershipId,
        discordUserId: membership.discordUserId,
        operation: "ASSIGN"
      });
    }
  });

  return getTeamDashboard(database, context, input.teamId);
}

async function createTeam(
  database: TransactionalDatabase,
  audit: AuditRepository,
  context: LeagueContext,
  input: CreateTeamInput
): Promise<TeamDashboard> {
  requirePermission(context, "TEAM_MANAGE");
  const team = validateTeamInput(input);
  const discordRoleId = team.discordRoleId ? validateDiscordRoleId(context, team.discordRoleId) : undefined;

  return withTransaction(database, async (transaction) => {
    await ensureTeamIsAvailable(transaction, context.leagueId, team.normalizedName, discordRoleId);

    const teamId = randomUUID();
    let inserted: TeamRow;

    try {
      await transaction.query(
        `INSERT INTO teams (
          id, league_id, name, normalized_name, roster_cap, status, discord_role_id, discord_role_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          teamId,
          context.leagueId,
          team.name,
          team.normalizedName,
          team.rosterCap,
          "ACTIVE",
          discordRoleId ?? null,
          discordRoleId ? "AVAILABLE" : "UNMAPPED"
        ]
      );
      inserted = await findTeam(transaction, context.leagueId, teamId);
    } catch (error) {
      const domainError = toTeamConflictError(error);

      if (domainError) {
        throw domainError;
      }
      throw error;
    }
    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      entityType: "team",
      entityId: inserted.id,
      action: "team.created",
      ...(context.actor.leagueMemberId ? { actorMemberId: context.actor.leagueMemberId } : {}),
      afterState: teamAuditState(inserted)
    });

    return toDashboard(inserted, 0, null);
  });
}

async function getTeamDashboard(
  database: TransactionalDatabase,
  context: LeagueContext,
  teamId: string
): Promise<TeamDashboard> {
  return database.transaction(async (transaction) => {
    const team = await findTeam(transaction, context.leagueId, teamId);

    return loadDashboard(transaction, team);
  });
}

async function listTeams(database: TransactionalDatabase, context: LeagueContext): Promise<TeamDashboard[]> {
  return database.transaction(async (transaction) => {
    const teams = await transaction.query<TeamRow>(
      `SELECT
         id,
         name,
         roster_cap AS rosterCap,
         status,
         discord_role_id AS discordRoleId,
         discord_role_state AS discordRoleState
       FROM teams
       WHERE league_id = ?
       ORDER BY normalized_name ASC`,
      [context.leagueId]
    );

    const dashboards: TeamDashboard[] = [];
    for (const team of teams.rows) {
      dashboards.push(await loadDashboard(transaction, team));
    }
    return dashboards;
  });
}

async function setTeamStatus(
  database: TransactionalDatabase,
  audit: AuditRepository,
  context: LeagueContext,
  teamId: string,
  status: TeamStatus
): Promise<TeamDashboard> {
  requirePermission(context, "TEAM_MANAGE");
  if (status !== "ACTIVE" && status !== "INACTIVE") {
    throw new DomainError("INVALID_INPUT", "Team status must be valid.");
  }

  await withTransaction(database, async (transaction) => {
    const current = await findTeam(transaction, context.leagueId, teamId);
    const result = await transaction.query(
      `UPDATE teams
       SET status = ?, updated_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND league_id = ?`,
      [status, teamId, context.leagueId]
    );
    if (result.affectedRows !== 1) {
      throw new DomainError("TEAM_NOT_FOUND", "This team was not found.");
    }
    const updated = await findTeam(transaction, context.leagueId, teamId);

    await audit.appendAuditEvent(transaction, {
      leagueId: context.leagueId,
      entityType: "team",
      entityId: teamId,
      action: "team.status_changed",
      ...(context.actor.leagueMemberId ? { actorMemberId: context.actor.leagueMemberId } : {}),
      beforeState: { status: current.status },
      afterState: { status: updated.status }
    });
  });

  return getTeamDashboard(database, context, teamId);
}

async function ensureTeamIsAvailable(
  transaction: SqlTransaction,
  leagueId: string,
  normalizedName: string,
  discordRoleId: string | undefined
): Promise<void> {
  const duplicateName = await transaction.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = ? AND normalized_name = ?",
    [leagueId, normalizedName]
  );
  if (duplicateName.rows[0]) {
    throw new DomainError("TEAM_ALREADY_EXISTS", "A team with this name already exists.");
  }

  if (!discordRoleId) {
    return;
  }

  const duplicateRole = await transaction.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = ? AND discord_role_id = ?",
    [leagueId, discordRoleId]
  );
  if (duplicateRole.rows[0]) {
    throw new DomainError("DISCORD_ROLE_ALREADY_MAPPED", "This Discord role is already mapped to a team.");
  }
}

async function findTeam(transaction: SqlTransaction, leagueId: string, teamId: string, lock = false): Promise<TeamRow> {
  const result = await transaction.query<TeamRow>(
    `SELECT
       id,
       name,
       roster_cap AS rosterCap,
       status,
       discord_role_id AS discordRoleId,
       discord_role_state AS discordRoleState
     FROM teams
     WHERE league_id = ? AND id = ?${lock ? " FOR UPDATE" : ""}`,
    [leagueId, teamId]
  );
  const team = result.rows[0];

  if (!team) {
    throw new DomainError("TEAM_NOT_FOUND", "This team was not found.");
  }

  return team;
}

function validateDiscordRoleId(context: LeagueContext, value: string): string {
  const discordRoleId = value.trim();
  if (!discordRoleId || discordRoleId === context.discordGuildId) {
    throw new DomainError("INVALID_INPUT", "Choose a valid Discord role, not @everyone.");
  }
  return discordRoleId;
}

async function ensureDiscordRoleIsAvailable(
  transaction: SqlTransaction,
  leagueId: string,
  teamId: string,
  discordRoleId: string
): Promise<void> {
  const duplicate = await transaction.query<{ id: string }>(
    "SELECT id FROM teams WHERE league_id = ? AND discord_role_id = ? AND id <> ?",
    [leagueId, discordRoleId, teamId]
  );
  if (duplicate.rows[0]) {
    throw new DomainError("DISCORD_ROLE_ALREADY_MAPPED", "This Discord role is already mapped to a team.");
  }
}

function missingTeam(): never {
  throw new DomainError("TEAM_NOT_FOUND", "This team was not found.");
}

async function loadDashboard(transaction: SqlTransaction, team: TeamRow): Promise<TeamDashboard> {
  const roster = await transaction.query<{ rosterCount: number | string }>(
    "SELECT COUNT(*) AS rosterCount FROM team_memberships WHERE team_id = ? AND status = 'ACTIVE'",
    [team.id]
  );
  const manager = await transaction.query<TeamManagerRow>(
    `SELECT
       league_members.id AS leagueMemberId,
       discord_users.discord_user_id AS discordUserId,
       discord_users.display_name AS displayName
     FROM team_memberships
     JOIN league_members ON league_members.id = team_memberships.league_member_id
     JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
     WHERE team_memberships.team_id = ?
       AND team_memberships.status = 'ACTIVE'
       AND team_memberships.membership_role = 'MANAGER'
     LIMIT 1`,
    [team.id]
  );

  return toDashboard(team, Number(roster.rows[0]?.rosterCount ?? "0"), manager.rows[0] ?? null);
}

function toDashboard(team: TeamRow, rosterCount: number, manager: TeamManager | null): TeamDashboard {
  return { ...team, rosterCount, manager };
}

function validateTeamInput(input: CreateTeamInput): {
  name: string;
  normalizedName: string;
  rosterCap: number;
  discordRoleId?: string;
} {
  const name = input.name.trim().replace(/\s+/g, " ");
  const discordRoleId = input.discordRoleId?.trim();

  if (!name || !Number.isInteger(input.rosterCap) || input.rosterCap < 1 || input.rosterCap > 99) {
    throw new DomainError("INVALID_INPUT", "Team name and roster cap must be valid.");
  }

  if (input.discordRoleId !== undefined && !discordRoleId) {
    throw new DomainError("INVALID_INPUT", "Discord role mapping must be valid.");
  }

  return {
    name,
    normalizedName: name.toLocaleLowerCase(),
    rosterCap: input.rosterCap,
    ...(discordRoleId ? { discordRoleId } : {})
  };
}

function teamAuditState(team: TeamRow): Record<string, unknown> {
  return {
    name: team.name,
    rosterCap: team.rosterCap,
    status: team.status,
    ...(team.discordRoleId ? { discordRoleId: team.discordRoleId } : {})
  };
}

function toTeamConflictError(error: unknown): DomainError | null {
  if (!isUniqueViolation(error)) {
    return null;
  }

  const constraint = error.constraint ?? "";
  const message = error.message ?? "";

  if (constraint === "teams_league_name_key" || message.includes("teams_league_name_key")) {
    return new DomainError("TEAM_ALREADY_EXISTS", "A team with this name already exists.");
  }
  if (constraint === "active_discord_role_per_league" || message.includes("active_discord_role_per_league")) {
    return new DomainError("DISCORD_ROLE_ALREADY_MAPPED", "This Discord role is already mapped to a team.");
  }

  return null;
}

function isUniqueViolation(error: unknown): error is { code?: string; constraint?: string; message?: string } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ER_DUP_ENTRY";
}
