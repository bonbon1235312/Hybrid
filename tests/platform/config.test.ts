import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/platform/config.js";

describe("loadConfig", () => {
  it("returns a typed configuration from the minimum production environment", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "123",
      HYBRID_COMPONENT_SIGNING_KEY: "a-32-character-component-signing-key",
      DATABASE_URL: "postgres://hybrid:hybrid@localhost:5432/hybrid"
    });

    expect(config).toMatchObject({
      discordClientId: "123",
      logLevel: "info"
    });
  });

  it("names a missing database setting without exposing a token", () => {
    expect(() => loadConfig({
      DISCORD_TOKEN: "token-that-must-not-appear",
      DISCORD_CLIENT_ID: "123"
      ,HYBRID_COMPONENT_SIGNING_KEY: "a-32-character-component-signing-key"
    })).toThrow("DATABASE_URL is required");
  });
});
