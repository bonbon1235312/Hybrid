import { randomUUID } from "node:crypto";

import { withTransaction, type TransactionalDatabase } from "../../platform/database.js";
import { DomainError } from "../../platform/errors.js";
import { requirePermission } from "../permissions/service.js";
import type { LeagueContext, LeagueRole, LeagueService, BootstrapLeagueInput } from "./types.js";

type LeagueRow = {
  leagueId: string;
  leagueMemberId: string | null;
  role: LeagueRole;
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
    const league = await transaction.query<{ id: string }>(
      `INSERT INTO leagues (id, discord_guild_id, name, default_roster_cap)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_guild_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), input.discordGuildId, input.name.trim(), input.defaultRosterCap]
    );
    const leagueId = league.rows[0]?.id;

    if (!leagueId) {
      throw new DomainError("LEAGUE_ALREADY_EXISTS", "A league is already configured for this server.");
    }

    await transaction.query(
      `INSERT INTO discord_users (discord_user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, last_seen_at = NOW(), updated_at = NOW()`,
      [input.actor.discordUserId, input.actor.displayName.trim()]
    );

    const member = await transaction.query<{ id: string }>(
      `INSERT INTO league_members (id, league_id, discord_user_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [randomUUID(), leagueId, input.actor.discordUserId]
    );
    const leagueMemberId = member.rows[0]?.id;

    if (!leagueMemberId) {
      throw new DomainError("LEAGUE_NOT_FOUND", "The new league could not be resolved.");
    }

    await transaction.query(
      "INSERT INTO staff_assignments (id, league_id, league_member_id, role) VALUES ($1, $2, $3, $4)",
      [randomUUID(), leagueId, leagueMemberId, "OWNER"]
    );
    await transaction.query(
      `INSERT INTO audit_events (
        id, league_id, actor_member_id, entity_type, entity_id, action, correlation_id, after_state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
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
        role: "OWNER"
      }
    };
  });
}

async function resolveLeagueContext(
  database: TransactionalDatabase,
  discordGuildId: string,
  discordUserId: string
): Promise<LeagueContext | null> {
  const result = await database.transaction(async (transaction) => transaction.query<LeagueRow>(
    `SELECT
       leagues.id AS "leagueId",
       league_members.id AS "leagueMemberId",
       COALESCE(
         (
           SELECT staff_assignments.role
           FROM staff_assignments
           WHERE staff_assignments.league_id = leagues.id
             AND staff_assignments.league_member_id = league_members.id
             AND staff_assignments.ended_at IS NULL
           ORDER BY CASE staff_assignments.role
             WHEN 'OWNER' THEN 1
             WHEN 'ADMINISTRATOR' THEN 2
             WHEN 'STAFF' THEN 3
           END
           LIMIT 1
         ),
         (
           SELECT team_memberships.membership_role
           FROM team_memberships
           WHERE team_memberships.league_id = leagues.id
             AND team_memberships.league_member_id = league_members.id
             AND team_memberships.status = 'ACTIVE'
           ORDER BY CASE team_memberships.membership_role
             WHEN 'MANAGER' THEN 1
             WHEN 'CAPTAIN' THEN 2
             WHEN 'PLAYER' THEN 3
           END
           LIMIT 1
         ),
         'PLAYER'
       ) AS role,
       (
         SELECT team_memberships.team_id
         FROM team_memberships
         WHERE team_memberships.league_id = leagues.id
           AND team_memberships.league_member_id = league_members.id
           AND team_memberships.status = 'ACTIVE'
         ORDER BY CASE team_memberships.membership_role
           WHEN 'MANAGER' THEN 1
           WHEN 'CAPTAIN' THEN 2
           WHEN 'PLAYER' THEN 3
         END
         LIMIT 1
       ) AS "teamId"
     FROM leagues
     LEFT JOIN league_members
       ON league_members.league_id = leagues.id
       AND league_members.discord_user_id = $2
       AND league_members.status = 'ACTIVE'
     WHERE leagues.discord_guild_id = $1`,
    [discordGuildId, discordUserId]
  ));
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    leagueId: row.leagueId,
    discordGuildId,
    actor: {
      discordUserId,
      role: row.role,
      ...(row.leagueMemberId ? { leagueMemberId: row.leagueMemberId } : {}),
      ...(row.teamId ? { teamId: row.teamId } : {})
    }
  };
}

function validateBootstrapInput(input: BootstrapLeagueInput): void {
  if (!input.discordGuildId.trim() || !input.actor.discordUserId.trim() || !input.actor.displayName.trim()) {
    throw new DomainError("INVALID_INPUT", "League setup details are required.");
  }

  if (!input.name.trim() || input.defaultRosterCap < 1 || input.defaultRosterCap > 99) {
    throw new DomainError("INVALID_INPUT", "League name and roster cap must be valid.");
  }
}
