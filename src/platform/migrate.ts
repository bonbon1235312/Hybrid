import "dotenv/config";

import { createDatabase } from "./mysql.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const database = createDatabase(config.databaseUrl);

try {
  await database.migrate();
} finally {
  await database.close();
}
