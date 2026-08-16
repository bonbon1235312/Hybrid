import { randomUUID } from "node:crypto";

import { withTransaction, type TransactionalDatabase } from "../../platform/database.js";
import { DomainError } from "../../platform/errors.js";
import { requirePermission } from "../permissions/service.js";
import type { LeagueContext, LeagueRole, LeagueService, BootstrapLeagueInput } from "./types.js";

type LeagueRow = {
  leagueId: string;
  leagueMemberId: string | null;
};

type RoleRow = {
  role: LeagueRole;
};

type MembershipRoleRow = RoleRow & {
  teamId: string | null;
};

export function createLeagueService(database: TransactionalDatabase): LeagueService {
  return {
    bootstrapLeague: async (input) => bootstrapLeague(database, input),
    resolveLeagueContext: async (discordGuildId, discordUserId) => resolveLeagueContext(
      database,
      discordGuildId,
      discordUserId
    ),
    requirePermission
  };
}

async function bootstrapLeague(
  database: TransactionalDatabase,
  input: BootstrapLeagueInput
): Promise<LeagueContext> {
  if (!input.actor.manageGuild) {
    throw new DomainError("FORBIDDEN", "You are not permitted to initialize this league.");
  }

  validateBootstrapInput(input);

  return withTransaction(database, async (transaction) => {
    const leagueId = randomUUID();
    try {
      await transaction.query(
      `INSERT INTO leagues (id, discord_guild_id, name, default_roster_cap)
       VALUES (?, ?, ?, ?)`,
        [leagueId, input.discordGuildId, input.name.trim(), input.defaultRosterCap]
      );
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new DomainError("LEAGUE_ALREADY_EXISTS", "A league is already configured for this server.");
      }
      throw error;
    }

    await transaction.query(
      `INSERT INTO discord_users (discord_user_id, display_name)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name), last_seen_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)`,
      [input.actor.discordUserId, input.actor.displayName.trim()]
    );

    const leagueMemberId = randomUUID();
    await transaction.query(
      `INSERT INTO league_members (id, league_id, discord_user_id)
       VALUES (?, ?, ?)`,
      [leagueMemberId, leagueId, input.actor.discordUserId]
    );

    await transaction.query(
      "INSERT INTO staff_assignments (id, league_id, league_member_id, role) VALUES (?, ?, ?, ?)",
      [randomUUID(), leagueId, leagueMemberId, "OWNER"]
    );
    await transaction.query(
      `INSERT INTO audit_events (
        id, league_id, actor_member_id, entity_type, entity_id, action, correlation_id, after_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        leagueId,
        leagueMemberId,
        "league",
        leagueId,
        "league.created",
        randomUUID(),
        JSON.stringify({ name: input.name.trim(), defaultRosterCap: input.defaultRosterCap })
      ]
    );

    return {
      leagueId,
      discordGuildId: input.discordGuildId,
      actor: {
        discordUserId: input.actor.discordUserId,
        leagueMemberId,
        role: "OWNER",
        roles: ["OWNER"],
        managedTeamIds: []
      }
    };
  });
}

async function resolveLeagueContext(
  database: TransactionalDatabase,
  discordGuildId: string,
  discordUserId: string
): Promise<LeagueContext | null> {
  const result = await database.transaction(async (transaction) => {
    const league = await transaction.query<LeagueRow>(
    `SELECT
       leagues.id AS leagueId,
       league_members.id AS leagueMemberId
     FROM leagues
     LEFT JOIN league_members
       ON league_members.league_id = leagues.id
       AND league_members.discord_user_id = ?
       AND league_members.status = 'ACTIVE'
     WHERE leagues.discord_guild_id = ?`,
     [discordUserId, discordGuildId]
    );
    const row = league.rows[0];

    if (!row) {
      return null;
    }

    if (!row.leagueMemberId) {
      return createContext(row.leagueId, discordGuildId, discordUserId, ["PLAYER"], []);
    }

    const staffAssignments = await transaction.query<RoleRow>(
      `SELECT role
       FROM staff_assignments
       WHERE league_id = ? AND league_member_id = ? AND ended_at IS NULL`,
      [row.leagueId, row.leagueMemberId]
    );
    const memberships = await transaction.query<MembershipRoleRow>(
      `SELECT membership_role AS role, team_id AS teamId
       FROM team_memberships
       WHERE league_id = ? AND league_member_id = ? AND status = 'ACTIVE'`,
      [row.leagueId, row.leagueMemberId]
    );
    const roles = uniqueRoles([
      ...staffAssignments.rows.map((assignment) => assignment.role),
      ...memberships.rows.map((membership) => membership.role)
    ]);
    const managedTeamIds = memberships.rows.flatMap((membership) => (
      membership.role === "MANAGER" && membership.teamId ? [membership.teamId] : []
    ));

    return createContext(row.leagueId, discordGuildId, discordUserId, roles, managedTeamIds, row.leagueMemberId);
  });

  return result;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ER_DUP_ENTRY";
}

function createContext(
  leagueId: string,
  discordGuildId: string,
  discordUserId: string,
  roles: readonly LeagueRole[],
  managedTeamIds: readonly string[],
  leagueMemberId?: string
): LeagueContext {
  const primaryRole = roles[0] ?? "PLAYER";
  const teamId = managedTeamIds[0];

  return {
    leagueId,
    discordGuildId,
    actor: {
      discordUserId,
      role: primaryRole,
      roles,
      managedTeamIds,
      ...(leagueMemberId ? { leagueMemberId } : {}),
      ...(teamId ? { teamId } : {})
    }
  };
}

function uniqueRoles(roles: readonly LeagueRole[]): LeagueRole[] {
  const roleRank: Readonly<Record<LeagueRole, number>> = {
    OWNER: 1,
    ADMINISTRATOR: 2,
    STAFF: 3,
    MANAGER: 4,
    CAPTAIN: 5,
    PLAYER: 6
  };
  const unique = new Set(roles);

  if (unique.size === 0) {
    return ["PLAYER"];
  }

  return [...unique].sort((left, right) => roleRank[left] - roleRank[right]);
}

function validateBootstrapInput(input: BootstrapLeagueInput): void {
  if (!input.discordGuildId.trim() || !input.actor.discordUserId.trim() || !input.actor.displayName.trim()) {
    throw new DomainError("INVALID_INPUT", "League setup details are required.");
  }

  if (!input.name.trim() || input.defaultRosterCap < 1 || input.defaultRosterCap > 99) {
    throw new DomainError("INVALID_INPUT", "League name and roster cap must be valid.");
  }
}
