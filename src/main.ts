import "dotenv/config";

import { fileURLToPath } from "node:url";

import { createHybridApplication } from "./app.js";
import { loadConfig } from "./platform/config.js";

export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await createHybridApplication({ config });
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
