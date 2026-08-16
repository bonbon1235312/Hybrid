import pino, { type DestinationStream, type Logger } from "pino";

import type { LogLevel } from "./config.js";

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino({
    level,
    redact: {
      censor: "[Redacted]",
      paths: [
        "authorization",
        "databaseUrl",
        "discordToken",
        "headers.authorization",
        "interaction",
        "token"
      ]
    }
  }, destination);
}
