import { describe, expect, it } from "vitest";

import { startHybrid, type StartupDependencies } from "../src/main.js";
import type { AppConfig } from "../src/platform/config.js";

const config: AppConfig = {
  discordToken: "test-token",
  discordClientId: "123",
  componentSigningKey: "a-32-character-component-signing-key",
  databaseUrl: "mysql://test:test@localhost:3306/hybrid",
  logLevel: "error"
};

describe("startHybrid", () => {
  it("registers commands before constructing and starting the application", async () => {
    const calls: string[] = [];

    await startHybrid(dependencies(calls));

    expect(calls).toEqual(["register", "construct", "start"]);
  });

  it("does not construct or start the application when command registration fails", async () => {
    const calls: string[] = [];
    const failingDependencies: StartupDependencies = {
      ...dependencies(calls),
      registerDiscordCommands: async () => {
        calls.push("register");
        throw new Error("Discord unavailable");
      }
    };

    await expect(startHybrid(failingDependencies)).rejects.toThrow("Discord unavailable");
    expect(calls).toEqual(["register"]);
  });
});

function dependencies(calls: string[]): StartupDependencies {
  return {
    loadConfig: () => config,
    registerDiscordCommands: async () => { calls.push("register"); },
    createApplication: async () => {
      calls.push("construct");
      return {
        start: async () => { calls.push("start"); },
        stop: async () => { calls.push("stop"); }
      };
    }
  };
}
