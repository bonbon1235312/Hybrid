import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/platform/logger.js";

describe("createLogger", () => {
  it("redacts tokens and raw interaction content from structured logs", () => {
    const entries: string[] = [];
    const logger = createLogger("info", {
      write(chunk: string) {
        entries.push(chunk);
      }
    });

    logger.info({
      discordToken: "token-that-must-not-appear",
      interaction: { content: "private-message-that-must-not-appear" }
    }, "interaction failed");

    const output = entries.join("");
    expect(output).not.toContain("token-that-must-not-appear");
    expect(output).not.toContain("private-message-that-must-not-appear");
    expect(output).toContain("[Redacted]");
  });
});
