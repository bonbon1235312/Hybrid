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

type DiscordJobRow = Omit<DiscordJob, "payload"> & Readonly<{
  payload: RoleSyncPayload | string;
}>;

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
      "UPDATE discord_jobs SET deduplication_key = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [`${deduplicationKey}:completed:${job.id}`, job.id]
    );
    const inserted = await insertRoleSyncJob(transaction, leagueId, deduplicationKey, payload);

    if (!inserted) {
      throw new Error("Unable to enqueue subsequent role-sync work.");
    }
    return inserted;
  }

  const coalesced = await transaction.query(
    `UPDATE discord_jobs
     SET payload = ?,
         status = CASE WHEN status = 'FAILED' THEN 'QUEUED' ELSE status END,
         available_at = CASE WHEN status = 'FAILED' THEN UTC_TIMESTAMP(3) ELSE available_at END,
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?`,
    [JSON.stringify(payload), job.id]
  );

  if (coalesced.affectedRows !== 1) {
    throw new Error("Unable to coalesce role-sync work.");
  }
  return findJobById(transaction, job.id);
}

async function findJobByDeduplicationKey(
  transaction: SqlTransaction,
  deduplicationKey: string
): Promise<DiscordJob | null> {
  const existing = await transaction.query<DiscordJobRow>(
    `${jobSelectColumns}
     FROM discord_jobs
     WHERE deduplication_key = ?
     FOR UPDATE`,
    [deduplicationKey]
  );

  return existing.rows[0] ? toDiscordJob(existing.rows[0]) : null;
}

async function findJobById(transaction: SqlTransaction, jobId: string): Promise<DiscordJob> {
  const result = await transaction.query<DiscordJobRow>(
    `${jobSelectColumns}
     FROM discord_jobs
     WHERE id = ?`,
    [jobId]
  );
  const job = result.rows[0];
  if (!job) {
    throw new Error("Unable to resolve durable role-sync work.");
  }
  return toDiscordJob(job);
}

async function listByDeduplicationKey(database: TransactionalDatabase, deduplicationKey: string): Promise<DiscordJob[]> {
  const result = await database.transaction(async (transaction) => transaction.query<DiscordJobRow>(
    `${jobSelectColumns}
     FROM discord_jobs
     WHERE deduplication_key = ?`,
    [deduplicationKey]
  ));

  return result.rows.map(toDiscordJob);
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
       WHERE (status = 'QUEUED' AND available_at <= UTC_TIMESTAMP(3))
          OR (status = 'LEASED' AND lease_expires_at <= UTC_TIMESTAMP(3))
       ORDER BY available_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`
    );
    const claimed: DiscordJob[] = [];

    for (const candidate of candidates.rows) {
      const result = await transaction.query(
        `UPDATE discord_jobs
         SET status = 'LEASED',
             lease_owner = ?,
             lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
             attempt_count = attempt_count + 1,
             updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?
           AND ((status = 'QUEUED' AND available_at <= UTC_TIMESTAMP(3))
             OR (status = 'LEASED' AND lease_expires_at <= UTC_TIMESTAMP(3)))`,
        [workerId, leaseSeconds, candidate.id]
      );
      if (result.affectedRows === 1) {
        claimed.push(await findJobById(transaction, candidate.id));
      }
    }

    return claimed;
  });
}

async function completeClaimedJob(database: TransactionalDatabase, workerId: string, jobId: string): Promise<boolean> {
  const result = await database.transaction(async (transaction) => transaction.query(
    `UPDATE discord_jobs
     SET status = 'COMPLETED',
         completed_at = UTC_TIMESTAMP(3),
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error_code = NULL,
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ? AND status = 'LEASED' AND lease_owner = ?`,
    [jobId, workerId]
  ));

  return result.affectedRows === 1;
}

async function retryClaimedJob(database: TransactionalDatabase, input: RetryClaimedJobInput): Promise<boolean> {
  if (!input.errorCode.trim() || !Number.isInteger(input.delaySeconds) || input.delaySeconds < 1) {
    throw new Error("Retry error code and delay must be valid.");
  }

  const result = await database.transaction(async (transaction) => transaction.query(
    `UPDATE discord_jobs
     SET status = CASE WHEN ? THEN 'FAILED' ELSE 'QUEUED' END,
         available_at = CASE WHEN ? THEN available_at ELSE DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND) END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error_code = ?,
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ? AND status = 'LEASED' AND lease_owner = ?`,
    [input.finalAttempt, input.finalAttempt, input.delaySeconds, input.errorCode, input.jobId, input.workerId]
  ));

  return result.affectedRows === 1;
}

async function insertRoleSyncJob(
  transaction: SqlTransaction,
  leagueId: string,
  deduplicationKey: string,
  payload: RoleSyncPayload
): Promise<DiscordJob | null> {
  const id = randomUUID();
  try {
    await transaction.query(
      `INSERT INTO discord_jobs (
       id, league_id, job_type, deduplication_key, payload, status, attempt_count, available_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [id, leagueId, "ROLE_SYNC", deduplicationKey, JSON.stringify(payload), "QUEUED", 0]
    );
  } catch (error) {
    if (isDuplicateKey(error)) {
      return null;
    }
    throw error;
  }
  return findJobById(transaction, id);
}

const jobSelectColumns = `SELECT
  id,
  league_id AS leagueId,
  job_type AS jobType,
  deduplication_key AS deduplicationKey,
  payload,
  status,
  attempt_count AS attemptCount,
  available_at AS availableAt,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  completed_at AS completedAt`;

function toDiscordJob(row: DiscordJobRow): DiscordJob {
  return { ...row, payload: parseRoleSyncPayload(row.payload) };
}

function parseRoleSyncPayload(value: RoleSyncPayload | string): RoleSyncPayload {
  const payload = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRoleSyncPayload(payload)) {
    throw new Error("Invalid durable role-sync payload.");
  }
  return payload;
}

function isRoleSyncPayload(value: unknown): value is RoleSyncPayload {
  return typeof value === "object"
    && value !== null
    && "membershipId" in value
    && typeof value.membershipId === "string"
    && "discordUserId" in value
    && typeof value.discordUserId === "string"
    && "operation" in value
    && (value.operation === "ASSIGN" || value.operation === "REMOVE");
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ER_DUP_ENTRY";
}
