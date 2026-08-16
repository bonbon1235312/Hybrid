import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";

import { createAuditRepository } from "./modules/audit/repository.js";
import { createDiscordJobRepository } from "./modules/discord-jobs/repository.js";
import { createRoleSyncWorker, type DiscordRoleGateway, type RoleSyncWorker, type RoleSyncWorkerOptions } from "./modules/discord-jobs/worker.js";
import { createLeagueService } from "./modules/league/service.js";
import { createRegistrationService } from "./modules/registrations/service.js";
import { createRosterService } from "./modules/rosters/service.js";
import { createTeamService } from "./modules/teams/service.js";
import { createDiscordClient, createDiscordRoleGateway } from "./discord/client.js";
import type { ApplicationServices } from "./discord/types.js";
import { createRouteStore } from "./discord/ui/route-store.js";
import type { AppConfig } from "./platform/config.js";
import type { TransactionalDatabase } from "./platform/database.js";
import { createLogger } from "./platform/logger.js";
import { createDatabase } from "./platform/mysql.js";

type ClosableDatabase = TransactionalDatabase & Readonly<{
  close?: () => Promise<void>;
  migrate?: () => Promise<void>;
}>;

type DiscordClientRuntime = Readonly<{
  login(token: string): Promise<unknown>;
  destroy(): void;
}>;

export type HybridApplicationDependencies = Readonly<{
  config?: AppConfig;
  database?: ClosableDatabase;
  discordGateway?: DiscordRoleGateway;
  discordClient?: DiscordClientRuntime;
  roleSyncWorker?: RoleSyncWorker;
  workerOptions?: RoleSyncWorkerOptions;
  workerPollIntervalMs?: number;
}>;

export type HybridApplication = Readonly<{
  database: ClosableDatabase;
  services: ApplicationServices;
  worker: RoleSyncWorker;
  start(): Promise<void>;
  stop(): Promise<void>;
}>;

/** Builds all League Core services once and owns their production lifecycle. */
export async function createHybridApplication(dependencies: HybridApplicationDependencies = {}): Promise<HybridApplication> {
  const config = dependencies.config;
  const database = dependencies.database ?? createProductionDatabase(config);

  if (database.migrate) {
    await database.migrate();
  }

  const logger = createLogger(config?.logLevel ?? "info");
  const routes = createRouteStore(database, config?.componentSigningKey ?? requiredComponentSigningKey());
  const audit = createAuditRepository(database);
  const jobs = createDiscordJobRepository(database);
  const services: ApplicationServices = {
    leagues: createLeagueService(database),
    teams: createTeamService(database, audit, jobs),
    registrations: createRegistrationService(database, audit),
    rosters: createRosterService(database, audit, jobs),
    routes,
    logger
  };
  const client = dependencies.discordClient ?? createDiscordClient(services);
  const gateway = dependencies.discordGateway ?? createDiscordRoleGateway(client as Client);
  const worker = dependencies.roleSyncWorker ?? createRoleSyncWorker(
    database,
    jobs,
    audit,
    gateway,
    dependencies.workerOptions ?? defaultWorkerOptions()
  );
  const workerPollIntervalMs = dependencies.workerPollIntervalMs ?? 5_000;
  if (!Number.isInteger(workerPollIntervalMs) || workerPollIntervalMs < 1) {
    throw new Error("Worker poll interval must be a positive integer.");
  }
  let timer: NodeJS.Timeout | null = null;
  let inFlightWorkerRun: Promise<void> | null = null;
  let started = false;

  return {
    database,
    services,
    worker,
    start: async () => {
      if (started) {
        return;
      }
      if (!config) {
        throw new Error("AppConfig is required to start the Discord application.");
      }

      await client.login(config.discordToken);
      started = true;
      scheduleWorkerRun();
      timer = setInterval(scheduleWorkerRun, workerPollIntervalMs);
      timer.unref();
    },
    stop: async () => {
      started = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await inFlightWorkerRun;
      client.destroy();
      await database.close?.();
    }
  };

  function scheduleWorkerRun(): void {
    if (!started || inFlightWorkerRun) {
      return;
    }

    const execution = runWorker(worker, logger);
    inFlightWorkerRun = execution;
    void execution.finally(() => {
      if (inFlightWorkerRun === execution) {
        inFlightWorkerRun = null;
      }
    });
  }
}

function requiredComponentSigningKey(): string {
  const signingKey = process.env.HYBRID_COMPONENT_SIGNING_KEY;
  if (!signingKey) {
    throw new Error("HYBRID_COMPONENT_SIGNING_KEY is required when no AppConfig is supplied.");
  }
  return signingKey;
}

function createProductionDatabase(config: AppConfig | undefined): ClosableDatabase {
  if (!config) {
    throw new Error("AppConfig is required when no database is supplied.");
  }
  return createDatabase(config.databaseUrl);
}

async function runWorker(worker: RoleSyncWorker, logger: ApplicationServices["logger"]): Promise<void> {
  try {
    await worker.runOnce();
  } catch (error) {
    logger?.error({ err: error }, "Discord role-sync worker run failed");
  }
}

function defaultWorkerOptions(): RoleSyncWorkerOptions {
  return { workerId: `role-worker:${randomUUID()}`, claimLimit: 16, leaseSeconds: 60, maxAttempts: 5, retryBaseSeconds: 2 };
}
