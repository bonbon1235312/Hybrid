import { randomUUID } from "node:crypto";

import type { TransactionalDatabase } from "../../platform/database.js";
import type { LeagueContext } from "../league/types.js";
import type { AuditEvent, AuditEventInput, AuditRepository } from "./types.js";

type AuditEventRow = AuditEvent;

export function createAuditRepository(database: TransactionalDatabase): AuditRepository {
  return {
    appendAuditEvent: async (transaction, event) => appendAuditEvent(transaction, event),
    listEntityHistory: async (context, entityType, entityId) => listEntityHistory(
      database,
      context,
      entityType,
      entityId
    )
  };
}

async function appendAuditEvent(
  transaction: Parameters<AuditRepository["appendAuditEvent"]>[0],
  event: AuditEventInput
): Promise<void> {
  await transaction.query(
    `INSERT INTO audit_events (
      id, league_id, actor_member_id, entity_type, entity_id, action, correlation_id, before_state, after_state
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      randomUUID(),
      event.leagueId,
      event.actorMemberId ?? null,
      event.entityType,
      event.entityId ?? null,
      event.action,
      event.correlationId ?? randomUUID(),
      event.beforeState === undefined ? null : JSON.stringify(event.beforeState),
      event.afterState === undefined ? null : JSON.stringify(event.afterState)
    ]
  );
}

async function listEntityHistory(
  database: TransactionalDatabase,
  context: LeagueContext,
  entityType: string,
  entityId: string
): Promise<AuditEvent[]> {
  const result = await database.transaction(async (transaction) => transaction.query<AuditEventRow>(
    `SELECT
       audit_events.id,
       audit_events.entity_type AS "entityType",
       audit_events.entity_id AS "entityId",
       audit_events.action,
       discord_users.discord_user_id AS "actorDiscordUserId",
       audit_events.correlation_id AS "correlationId",
       audit_events.before_state AS "beforeState",
       audit_events.after_state AS "afterState",
       audit_events.created_at AS "createdAt"
     FROM audit_events
     LEFT JOIN league_members
       ON league_members.id = audit_events.actor_member_id
       AND league_members.league_id = audit_events.league_id
     LEFT JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
     WHERE audit_events.league_id = $1
       AND audit_events.entity_type = $2
       AND audit_events.entity_id = $3
     ORDER BY audit_events.created_at ASC, audit_events.id ASC`,
    [context.leagueId, entityType, entityId]
  ));

  return result.rows;
}
