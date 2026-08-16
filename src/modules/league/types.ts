import type { Permission } from "../permissions/types.js";

export type LeagueRole = "OWNER" | "ADMINISTRATOR" | "STAFF" | "MANAGER" | "CAPTAIN" | "PLAYER";

export type LeagueActor = Readonly<{
  discordUserId: string;
  leagueMemberId?: string;
  role: LeagueRole;
  teamId?: string;
  /** Discord privileges are bootstrap-only and must never grant an application permission. */
  discordAdministrator?: boolean;
}>;

export type LeagueContext = Readonly<{
  leagueId: string;
  discordGuildId: string;
  actor: LeagueActor;
}>;

export type BootstrapActor = Readonly<{
  discordUserId: string;
  displayName: string;
  manageGuild: boolean;
}>;

export type BootstrapLeagueInput = Readonly<{
  discordGuildId: string;
  actor: BootstrapActor;
  name: string;
  defaultRosterCap: number;
}>;

export type LeagueService = Readonly<{
  bootstrapLeague(input: BootstrapLeagueInput): Promise<LeagueContext>;
  resolveLeagueContext(discordGuildId: string, discordUserId: string): Promise<LeagueContext | null>;
  requirePermission(context: LeagueContext, permission: Permission): void;
}>;
