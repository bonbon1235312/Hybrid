import { z } from "zod";

const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

export type AppConfig = Readonly<{
  discordToken: string;
  discordClientId: string;
  databaseUrl: string;
  logLevel: LogLevel;
}>;

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().regex(/^\d+$/, "DISCORD_CLIENT_ID is required"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  LOG_LEVEL: z.enum(logLevels).default("info")
});

const requiredKeys = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DATABASE_URL"] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  for (const key of requiredKeys) {
    if (!env[key]) {
      throw new Error(`${key} is required`);
    }
  }

  const parsed = environmentSchema.parse(env);

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    databaseUrl: parsed.DATABASE_URL,
    logLevel: parsed.LOG_LEVEL
  };
}
