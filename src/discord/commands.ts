export type CommandDefinition = Readonly<{
  name: "league" | "help";
  description: string;
}>;

/** The complete public slash-command surface. Keep this intentionally small. */
export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  { name: "league", description: "Open your Hybrid League dashboard" },
  { name: "help", description: "Show Hybrid League help" }
];
