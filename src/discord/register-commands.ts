import "dotenv/config";

import { fileURLToPath } from "node:url";

import { REST, Routes } from "discord.js";

import { COMMAND_DEFINITIONS } from "./commands.js";
import { loadConfig, type AppConfig } from "../platform/config.js";

export async function registerDiscordCommands(
  config: Pick<AppConfig, "discordToken" | "discordClientId">
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  await rest.put(Routes.applicationCommands(config.discordClientId), { body: COMMAND_DEFINITIONS });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env);
  await registerDiscordCommands(config);
}
