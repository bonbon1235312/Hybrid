import { withTransaction, type TransactionalDatabase } from "../../platform/database.js";
import type { AuditRepository } from "../audit/types.js";
import type { DiscordJob, DiscordJobRepository } from "./repository.js";

export type DiscordRoleGateway = Readonly<{
  getMemberRoles(discordUserId: string): Promise<readonly string[]>;
  setMemberRoles(discordUserId: string, roleIds: readonly string[]): Promise<void>;
  roleExists(roleId: string): Promise<boolean>;
}>;

export type RoleSyncWorkerOptions = Readonly<{
  workerId: string;
  claimLimit: number;
  leaseSeconds: number;
  maxAttempts: number;
  retryBaseSeconds: number;
}>;

export type WorkerRunSummary = Readonly<{
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  recoveries: number;
}>;

export type RoleSyncWorker = Readonly<{
  runOnce(): Promise<WorkerRunSummary>;
}>;

type TeamRoleMapping = Readonly<{
  teamId: string;
  discordRoleId: string | null;
  discordRoleState: "AVAILABLE" | "UNAVAILABLE" | "UNMAPPED";
}>;

type MembershipRoleMapping = TeamRoleMapping & Readonly<{
  discordUserId: string;
  leagueMemberId: string;
}>;

type ReconciliationPlan = Readonly<{
  discordUserId: string;
  affected: TeamRoleMapping;
  desired: TeamRoleMapping | null;
}>;

export function createRoleSyncWorker(
  database: TransactionalDatabase,
  jobs: DiscordJobRepository,
  audit: AuditRepository,
  gateway: DiscordRoleGateway,
  options: RoleSyncWorkerOptions
): RoleSyncWorker {
  validateOptions(options);

  return {
    runOnce: async () => runOnce(database, jobs, audit, gateway, options)
  };
}

async function runOnce(
  database: TransactionalDatabase,
  jobs: DiscordJobRepository,
  audit: AuditRepository,
  gateway: DiscordRoleGateway,
  options: RoleSyncWorkerOptions
): Promise<WorkerRunSummary> {
  const claimed = await jobs.claimDiscordJobs(options.workerId, options.claimLimit, options.leaseSeconds);
  const summary = { claimed: claimed.length, completed: 0, retried: 0, failed: 0, recoveries: 0 };

  for (const job of claimed) {
    try {
      const recovery = await reconcileJob(database, audit, gateway, job);
      const completed = await jobs.completeClaimedJob(options.workerId, job.id);

      if (completed) {
        summary.completed += 1;
        if (recovery) {
          summary.recoveries += 1;
        }
      }
    } catch (error) {
      const finalAttempt = job.attemptCount >= options.maxAttempts;
      const updated = await jobs.retryClaimedJob({
        workerId: options.workerId,
        jobId: job.id,
        errorCode: errorCode(error),
        delaySeconds: retryDelaySeconds(job.attemptCount, options.retryBaseSeconds),
        finalAttempt
      });

      if (updated) {
        if (finalAttempt) {
          summary.failed += 1;
        } else {
          summary.retried += 1;
        }
      }
    }
  }

  return summary;
}

async function reconcileJob(
  database: TransactionalDatabase,
  audit: AuditRepository,
  gateway: DiscordRoleGateway,
  job: DiscordJob
): Promise<boolean> {
  const plan = await loadPlan(database, job);

  if (!plan) {
    return false;
  }

  const mappings = uniqueMappings([plan.affected, plan.desired]);
  const missing = await missingRoleMappings(gateway, mappings);

  if (missing.length > 0) {
    await markMappingsUnavailable(database, audit, job.leagueId, missing);
    return true;
  }

  try {
    const currentRoleIds = await gateway.getMemberRoles(plan.discordUserId);
    const nextRoleIds = reconcileRoleIds(currentRoleIds, plan.affected, plan.desired);

    if (!sameRoleIds(currentRoleIds, nextRoleIds)) {
      await gateway.setMemberRoles(plan.discordUserId, nextRoleIds);
    }
    return false;
  } catch (error) {
    if (!isMissingRoleError(error)) {
      throw error;
    }

    const availableMappings = mappings.filter((mapping) => mapping.discordRoleId && mapping.discordRoleState === "AVAILABLE");
    await markMappingsUnavailable(database, audit, job.leagueId, availableMappings);
    return true;
  }
}

async function loadPlan(database: TransactionalDatabase, job: DiscordJob): Promise<ReconciliationPlan | null> {
  return database.transaction(async (transaction) => {
    const affectedResult = await transaction.query<MembershipRoleMapping>(
      `SELECT
         team_memberships.league_member_id AS "leagueMemberId",
         discord_users.discord_user_id AS "discordUserId",
         teams.id AS "teamId",
         teams.discord_role_id AS "discordRoleId",
         teams.discord_role_state AS "discordRoleState"
       FROM team_memberships
       JOIN league_members ON league_members.id = team_memberships.league_member_id
       JOIN discord_users ON discord_users.discord_user_id = league_members.discord_user_id
       JOIN teams ON teams.id = team_memberships.team_id AND teams.league_id = team_memberships.league_id
       WHERE team_memberships.id = $1 AND team_memberships.league_id = $2`,
      [job.payload.membershipId, job.leagueId]
    );
    const affected = affectedResult.rows[0];

    if (!affected) {
      return null;
    }

    const desiredResult = await transaction.query<TeamRoleMapping>(
      `SELECT
         teams.id AS "teamId",
         teams.discord_role_id AS "discordRoleId",
         teams.discord_role_state AS "discordRoleState"
       FROM team_memberships
       JOIN league_members ON league_members.id = team_memberships.league_member_id
       JOIN teams ON teams.id = team_memberships.team_id AND teams.league_id = team_memberships.league_id
       WHERE team_memberships.league_id = $1
         AND team_memberships.league_member_id = $2
         AND team_memberships.status = 'ACTIVE'
         AND league_members.status = 'ACTIVE'
       LIMIT 1`,
      [job.leagueId, affected.leagueMemberId]
    );

    return { discordUserId: affected.discordUserId, affected, desired: desiredResult.rows[0] ?? null };
  });
}

async function missingRoleMappings(
  gateway: DiscordRoleGateway,
  mappings: readonly TeamRoleMapping[]
): Promise<TeamRoleMapping[]> {
  const missing: TeamRoleMapping[] = [];

  for (const mapping of mappings) {
    if (!mapping.discordRoleId || mapping.discordRoleState !== "AVAILABLE") {
      continue;
    }
    if (!await gateway.roleExists(mapping.discordRoleId)) {
      missing.push(mapping);
    }
  }

  return missing;
}

async function markMappingsUnavailable(
  database: TransactionalDatabase,
  audit: AuditRepository,
  leagueId: string,
  mappings: readonly TeamRoleMapping[]
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    for (const mapping of mappings) {
      if (!mapping.discordRoleId) {
        continue;
      }
      const updated = await transaction.query<{ id: string }>(
        `UPDATE teams
         SET discord_role_state = 'UNAVAILABLE', updated_at = NOW()
         WHERE id = $1 AND league_id = $2 AND discord_role_state = 'AVAILABLE'
         RETURNING id`,
        [mapping.teamId, leagueId]
      );

      if (updated.rows[0]) {
        await audit.appendAuditEvent(transaction, {
          leagueId,
          entityType: "team",
          entityId: mapping.teamId,
          action: "discord.role_unavailable",
          afterState: { discordRoleId: mapping.discordRoleId, state: "UNAVAILABLE" }
        });
      }
    }
  });
}

function reconcileRoleIds(
  currentRoleIds: readonly string[],
  affected: TeamRoleMapping,
  desired: TeamRoleMapping | null
): string[] {
  const next = new Set(currentRoleIds);

  if (affected.discordRoleId && affected.discordRoleState === "AVAILABLE") {
    next.delete(affected.discordRoleId);
  }
  if (desired?.discordRoleId && desired.discordRoleState === "AVAILABLE") {
    next.add(desired.discordRoleId);
  }

  return [...next].sort();
}

function sameRoleIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftSet = new Set(left);
  return leftSet.size === right.length && right.every((roleId) => leftSet.has(roleId));
}

function uniqueMappings(mappings: readonly (TeamRoleMapping | null)[]): TeamRoleMapping[] {
  const byTeamId = new Map<string, TeamRoleMapping>();

  for (const mapping of mappings) {
    if (mapping) {
      byTeamId.set(mapping.teamId, mapping);
    }
  }
  return [...byTeamId.values()];
}

function retryDelaySeconds(attemptCount: number, baseSeconds: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 6);
  return Math.min(baseSeconds * (2 ** exponent), 300);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 64);
  }
  return "DISCORD_GATEWAY_ERROR";
}

function isMissingRoleError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = String(error.code);
  return code === "10011" || code === "UNKNOWN_ROLE" || code === "ROLE_NOT_FOUND";
}

function validateOptions(options: RoleSyncWorkerOptions): void {
  if (!options.workerId.trim()
    || !Number.isInteger(options.claimLimit) || options.claimLimit < 1
    || !Number.isInteger(options.leaseSeconds) || options.leaseSeconds < 1
    || !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1
    || !Number.isInteger(options.retryBaseSeconds) || options.retryBaseSeconds < 1) {
    throw new Error("Role-sync worker options must be valid.");
  }
}
