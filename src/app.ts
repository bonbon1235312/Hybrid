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
import type { AppConfig } from "./platform/config.js";
import type { TransactionalDatabase } from "./platform/database.js";
import { createLogger } from "./platform/logger.js";
import { createDatabase } from "./platform/postgres.js";

type ClosableDatabase = TransactionalDatabase & Readonly<{
  close?: () => Promise<void>;
  migrate?: () => Promise<void>;
}>;

export type HybridApplicationDependencies = Readonly<{
  config?: AppConfig;
  database?: ClosableDatabase;
  discordGateway?: DiscordRoleGateway;
  discordClient?: Client;
  workerOptions?: RoleSyncWorkerOptions;
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
  const audit = createAuditRepository(database);
  const jobs = createDiscordJobRepository(database);
  const services: ApplicationServices = {
    leagues: createLeagueService(database),
    teams: createTeamService(database, audit),
    registrations: createRegistrationService(database, audit),
    rosters: createRosterService(database, audit, jobs),
    logger
  };
  const client = dependencies.discordClient ?? createDiscordClient(services);
  const gateway = dependencies.discordGateway ?? createDiscordRoleGateway(client);
  const worker = createRoleSyncWorker(database, jobs, audit, gateway, dependencies.workerOptions ?? defaultWorkerOptions());
  let timer: NodeJS.Timeout | null = null;
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
      await runWorker(worker, logger);
      timer = setInterval(() => { void runWorker(worker, logger); }, 5_000);
      timer.unref();
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      client.destroy();
      started = false;
      await database.close?.();
    }
  };
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
