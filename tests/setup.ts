import { afterAll } from "vitest";

import { stopTestDatabaseRuntime } from "../src/platform/test-db.js";

process.env.HYBRID_COMPONENT_SIGNING_KEY = "test-component-signing-secret-32chars";

afterAll(async () => {
  await stopTestDatabaseRuntime();
});
