import { describe, expect, it } from "vitest";

import { COMMAND_DEFINITIONS } from "../../src/discord/commands.js";

describe("COMMAND_DEFINITIONS", () => {
  it("registers only league and help commands", () => {
    expect(COMMAND_DEFINITIONS.map((command) => command.name)).toEqual(["league", "help"]);
  });
});
