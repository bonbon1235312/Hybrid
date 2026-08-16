import "dotenv/config";

import { fileURLToPath } from "node:url";

import { createHybridApplication } from "./app.js";
import { registerDiscordCommands } from "./discord/register-commands.js";
import { loadConfig, type AppConfig } from "./platform/config.js";

type StartableApplication = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
}>;

export type StartupDependencies = Readonly<{
  loadConfig: (environment: NodeJS.ProcessEnv) => AppConfig;
  registerDiscordCommands: (config: AppConfig) => Promise<void>;
  createApplication: (input: Readonly<{ config: AppConfig }>) => Promise<StartableApplication>;
}>;

const productionDependencies: StartupDependencies = {
  loadConfig,
  registerDiscordCommands,
  createApplication: createHybridApplication
};

export async function main(): Promise<void> {
  await startHybrid();
}

export async function startHybrid(dependencies: StartupDependencies = productionDependencies): Promise<void> {
  const config = dependencies.loadConfig(process.env);
  await dependencies.registerDiscordCommands(config);
  const app = await dependencies.createApplication({ config });
  let stopping = false;

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await app.stop();
  };

  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await app.start();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error("Hybrid League Core failed to start.");
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
}
