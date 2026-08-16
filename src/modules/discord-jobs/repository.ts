import { randomUUID } from "node:crypto";

import type { SqlTransaction, TransactionalDatabase } from "../../platform/database.js";

export type RoleSyncOperation = "ASSIGN" | "REMOVE";

export type RoleSyncJobInput = Readonly<{
  leagueId: string;
  membershipId: string;
  discordUserId: string;
  operation: RoleSyncOperation;
}>;

export type RoleSyncPayload = Readonly<{
  membershipId: string;
  discordUserId: string;
  operation: RoleSyncOperation;
}>;

export type DiscordJobStatus = "QUEUED" | "LEASED" | "COMPLETED" | "FAILED";

export type DiscordJob = Readonly<{
  id: string;
  leagueId: string;
  jobType: "ROLE_SYNC";
  deduplicationKey: string;
  payload: RoleSyncPayload;
  status: DiscordJobStatus;
  attemptCount: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
}>;

export type DiscordJobRepository = Readonly<{
  enqueueRoleSync(transaction: SqlTransaction, input: RoleSyncJobInput): Promise<DiscordJob>;
  listByDeduplicationKey(deduplicationKey: string): Promise<DiscordJob[]>;
  claimDiscordJobs(workerId: string, limit: number, leaseSeconds: number): Promise<DiscordJob[]>;
  completeClaimedJob(workerId: string, jobId: string): Promise<boolean>;
  retryClaimedJob(input: RetryClaimedJobInput): Promise<boolean>;
}>;

export type RetryClaimedJobInput = Readonly<{
  workerId: string;
  jobId: string;
  errorCode: string;
  delaySeconds: number;
  finalAttempt: boolean;
}>;

type DiscordJobRow = DiscordJob;

export function createDiscordJobRepository(database: TransactionalDatabase): DiscordJobRepository {
  return {
    enqueueRoleSync: async (transaction, input) => enqueueRoleSync(transaction, input),
    listByDeduplicationKey: async (deduplicationKey) => listByDeduplicationKey(database, deduplicationKey),
    claimDiscordJobs: async (workerId, limit, leaseSeconds) => claimDiscordJobs(database, workerId, limit, leaseSeconds),
    completeClaimedJob: async (workerId, jobId) => completeClaimedJob(database, workerId, jobId),
    retryClaimedJob: async (input) => retryClaimedJob(database, input)
  };
}

async function enqueueRoleSync(transaction: SqlTransaction, input: RoleSyncJobInput): Promise<DiscordJob> {
  const deduplicationKey = `role-sync:${input.membershipId}`;
  const payload: RoleSyncPayload = {
    membershipId: input.membershipId,
    discordUserId: input.discordUserId,
    operation: input.operation
  };
  const job = await findJobByDeduplicationKey(transaction, deduplicationKey);

  if (!job) {
    const inserted = await insertRoleSyncJob(transaction, input.leagueId, deduplicationKey, payload);

    if (inserted) {
      return inserted;
    }

    const collided = await findJobByDeduplicationKey(transaction, deduplicationKey);

    if (!collided) {
      throw new Error("Unable to resolve concurrent role-sync work.");
    }
    return coalesceRoleSyncJob(transaction, collided, deduplicationKey, input.leagueId, payload);
  }

  return coalesceRoleSyncJob(transaction, job, deduplicationKey, input.leagueId, payload);
}

async function coalesceRoleSyncJob(
  transaction: SqlTransaction,
  job: DiscordJob,
  deduplicationKey: string,
  leagueId: string,
  payload: RoleSyncPayload
): Promise<DiscordJob> {
  if (job.status === "COMPLETED") {
    await transaction.query(
      "UPDATE discord_jobs SET deduplication_key = $1, updated_at = NOW() WHERE id = $2",
      [`${deduplicationKey}:completed:${job.id}`, job.id]
    );
    const inserted = await insertRoleSyncJob(transaction, leagueId, deduplicationKey, payload);

    if (!inserted) {
      throw new Error("Unable to enqueue subsequent role-sync work.");
    }
    return inserted;
  }

  const coalesced = await transaction.query<DiscordJobRow>(
    `WITH updated_job AS (
       UPDATE discord_jobs
       SET payload = $1::jsonb,
           status = CASE WHEN status = 'FAILED' THEN 'QUEUED' ELSE status END,
           available_at = CASE WHEN status = 'FAILED' THEN NOW() ELSE available_at END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *
     )
     ${jobSelectColumns}
     FROM updated_job`,
    [JSON.stringify(payload), job.id]
  );
  const updated = coalesced.rows[0];

  if (!updated) {
    throw new Error("Unable to coalesce role-sync work.");
  }
  return updated;
}

async function findJobByDeduplicationKey(
  transaction: SqlTransaction,
  deduplicationKey: string
): Promise<DiscordJob | null> {
  const existing = await transaction.query<DiscordJobRow>(
    `${jobSelectColumns}
     FROM discord_jobs
     WHERE deduplication_key = $1
     FOR UPDATE`,
    [deduplicationKey]
  );

  return existing.rows[0] ?? null;
}

async function listByDeduplicationKey(database: TransactionalDatabase, deduplicationKey: string): Promise<DiscordJob[]> {
  const result = await database.transaction(async (transaction) => transaction.query<DiscordJobRow>(
    `${jobSelectColumns}
     FROM discord_jobs
     WHERE deduplication_key = $1`,
    [deduplicationKey]
  ));

  return result.rows;
}

async function claimDiscordJobs(
  database: TransactionalDatabase,
  workerId: string,
  limit: number,
  leaseSeconds: number
): Promise<DiscordJob[]> {
  if (!workerId.trim() || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("Worker ID, claim limit, and lease duration must be valid.");
  }

  return database.transaction(async (transaction) => {
    const candidates = await transaction.query<{ id: string }>(
      `SELECT id
       FROM discord_jobs
       WHERE (status = 'QUEUED' AND available_at <= NOW())
          OR (status = 'LEASED' AND lease_expires_at <= NOW())
       ORDER BY available_at ASC, id ASC
       LIMIT $1
       FOR UPDATE`,
      [limit]
    );
    const claimed: DiscordJob[] = [];

    for (const candidate of candidates.rows) {
      const result = await transaction.query<DiscordJobRow>(
        `WITH claimed_job AS (
           UPDATE discord_jobs
           SET status = 'LEASED',
               lease_owner = $1,
               lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
               attempt_count = attempt_count + 1,
               updated_at = NOW()
           WHERE id = $3
             AND ((status = 'QUEUED' AND available_at <= NOW())
               OR (status = 'LEASED' AND lease_expires_at <= NOW()))
           RETURNING *
         )
         ${jobSelectColumns}
         FROM claimed_job`,
        [workerId, leaseSeconds, candidate.id]
      );
      const job = result.rows[0];

      if (job) {
        claimed.push(job);
      }
    }

    return claimed;
  });
}

async function completeClaimedJob(database: TransactionalDatabase, workerId: string, jobId: string): Promise<boolean> {
  const result = await database.transaction(async (transaction) => transaction.query<{ id: string }>(
    `UPDATE discord_jobs
     SET status = 'COMPLETED',
         completed_at = NOW(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error_code = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = 'LEASED' AND lease_owner = $2
     RETURNING id`,
    [jobId, workerId]
  ));

  return Boolean(result.rows[0]);
}

async function retryClaimedJob(database: TransactionalDatabase, input: RetryClaimedJobInput): Promise<boolean> {
  if (!input.errorCode.trim() || !Number.isInteger(input.delaySeconds) || input.delaySeconds < 1) {
    throw new Error("Retry error code and delay must be valid.");
  }

  const result = await database.transaction(async (transaction) => transaction.query<{ id: string }>(
    `UPDATE discord_jobs
     SET status = CASE WHEN $1 THEN 'FAILED' ELSE 'QUEUED' END,
         available_at = CASE WHEN $1 THEN available_at ELSE NOW() + ($2 * INTERVAL '1 second') END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error_code = $3,
         updated_at = NOW()
     WHERE id = $4 AND status = 'LEASED' AND lease_owner = $5
     RETURNING id`,
    [input.finalAttempt, input.delaySeconds, input.errorCode, input.jobId, input.workerId]
  ));

  return Boolean(result.rows[0]);
}

async function insertRoleSyncJob(
  transaction: SqlTransaction,
  leagueId: string,
  deduplicationKey: string,
  payload: RoleSyncPayload
): Promise<DiscordJob | null> {
  const result = await transaction.query<DiscordJobRow>(
    `INSERT INTO discord_jobs (
       id, league_id, job_type, deduplication_key, payload, status, attempt_count, available_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
     ON CONFLICT (deduplication_key) DO NOTHING
     RETURNING
       id,
       league_id AS "leagueId",
       job_type AS "jobType",
       deduplication_key AS "deduplicationKey",
       payload,
       status,
       attempt_count AS "attemptCount",
       available_at AS "availableAt",
       lease_owner AS "leaseOwner",
       lease_expires_at AS "leaseExpiresAt",
       completed_at AS "completedAt"`,
    [randomUUID(), leagueId, "ROLE_SYNC", deduplicationKey, JSON.stringify(payload), "QUEUED", 0]
  );
  return result.rows[0] ?? null;
}

const jobSelectColumns = `SELECT
  id,
  league_id AS "leagueId",
  job_type AS "jobType",
  deduplication_key AS "deduplicationKey",
  payload,
  status,
  attempt_count AS "attemptCount",
  available_at AS "availableAt",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  completed_at AS "completedAt"`;
