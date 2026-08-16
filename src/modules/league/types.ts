import type { Permission } from "../permissions/types.js";

export type LeagueRole = "OWNER" | "ADMINISTRATOR" | "STAFF" | "MANAGER" | "CAPTAIN" | "PLAYER";

export type LeagueActor = Readonly<{
  discordUserId: string;
  leagueMemberId?: string;
  /** The highest-priority Hybrid role, retained for concise dashboard display. */
  role: LeagueRole;
  /** All active Hybrid grants used for authorization. */
  roles: readonly LeagueRole[];
  teamId?: string;
  /** Teams on which this actor currently has a Hybrid MANAGER assignment. */
  managedTeamIds: readonly string[];
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
  requirePermission(context: LeagueContext, permission: Permission, teamId?: string): void;
}>;
