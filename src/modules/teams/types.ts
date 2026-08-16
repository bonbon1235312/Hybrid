import type { LeagueContext } from "../league/types.js";

export type TeamStatus = "ACTIVE" | "INACTIVE";

export type CreateTeamInput = Readonly<{
  name: string;
  rosterCap: number;
  discordRoleId?: string;
}>;

export type TeamManager = Readonly<{
  leagueMemberId: string;
  discordUserId: string;
  displayName: string;
}>;

export type TeamDashboard = Readonly<{
  id: string;
  name: string;
  rosterCap: number;
  rosterCount: number;
  status: TeamStatus;
  discordRoleId: string | null;
  discordRoleState: "AVAILABLE" | "UNAVAILABLE" | "UNMAPPED";
  manager: TeamManager | null;
}>;

export type TeamService = Readonly<{
  createTeam(context: LeagueContext, input: CreateTeamInput): Promise<TeamDashboard>;
  getTeamDashboard(context: LeagueContext, teamId: string): Promise<TeamDashboard>;
  listTeams(context: LeagueContext): Promise<TeamDashboard[]>;
  setTeamStatus(context: LeagueContext, teamId: string, status: TeamStatus): Promise<TeamDashboard>;
}>;
