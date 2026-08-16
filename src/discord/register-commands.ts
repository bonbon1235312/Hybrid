import "dotenv/config";

import { REST, Routes } from "discord.js";

import { COMMAND_DEFINITIONS } from "./commands.js";
import { loadConfig } from "../platform/config.js";

const config = loadConfig(process.env);
const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(Routes.applicationCommands(config.discordClientId), { body: COMMAND_DEFINITIONS });
