import { describe, expect, it } from "vitest";

import { createHybridApplication } from "../src/app.js";
import type { DiscordRoleGateway, RoleSyncWorker } from "../src/modules/discord-jobs/worker.js";
import { createTestDatabase } from "../src/platform/test-db.js";

describe("HybridApplication worker lifecycle", () => {
  it("does not overlap a slow worker run and waits for it before closing the database", async () => {
    const database = await createTestDatabase();
    const slowWorker = new DeferredWorker();
    let closeCalls = 0;
    const app = await createHybridApplication({
      config: { discordToken: "test-token", discordClientId: "123", componentSigningKey: "a-32-character-component-signing-key", databaseUrl: "postgres://unused", logLevel: "error" },
      database: { transaction: database.transaction.bind(database), close: async () => { closeCalls += 1; await database.close(); } },
      discordClient: { login: async () => undefined, destroy: () => undefined },
      discordGateway: noOpGateway,
      roleSyncWorker: slowWorker,
      workerPollIntervalMs: 5
    });

    await app.start();
    await pause(25);
    expect(slowWorker.calls).toBe(1);

    const stopping = app.stop();
    await pause(5);
    expect(closeCalls).toBe(0);

    slowWorker.release();
    await stopping;
    expect(closeCalls).toBe(1);
  });
});

class DeferredWorker implements RoleSyncWorker {
  calls = 0;
  private releaseRun: (() => void) | null = null;

  async runOnce() {
    this.calls += 1;
    await new Promise<void>((resolve) => { this.releaseRun = resolve; });
    return { claimed: 0, completed: 0, retried: 0, failed: 0, recoveries: 0 };
  }

  release(): void {
    this.releaseRun?.();
  }
}

const noOpGateway: DiscordRoleGateway = {
  getMemberRoles: async () => [],
  setMemberRoles: async () => undefined,
  roleExists: async () => false
};

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
