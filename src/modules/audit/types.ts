import type { SqlTransaction, TransactionalDatabase } from "../../platform/database.js";
import type { LeagueContext } from "../league/types.js";

export type AuditState = Readonly<Record<string, unknown>>;

export type AuditEventInput = Readonly<{
  leagueId: string;
  actorMemberId?: string;
  entityType: string;
  entityId?: string;
  action: string;
  correlationId?: string;
  beforeState?: AuditState;
  afterState?: AuditState;
}>;

export type AuditEvent = Readonly<{
  id: string;
  entityType: string;
  entityId: string | null;
  action: string;
  actorDiscordUserId: string | null;
  correlationId: string;
  beforeState: AuditState | null;
  afterState: AuditState | null;
  createdAt: Date;
}>;

export type AuditRepository = Readonly<{
  appendAuditEvent(transaction: SqlTransaction, event: AuditEventInput): Promise<void>;
  listEntityHistory(context: LeagueContext, entityType: string, entityId: string): Promise<AuditEvent[]>;
}>;

export type AuditRepositoryDependencies = Readonly<{
  database: TransactionalDatabase;
}>;
