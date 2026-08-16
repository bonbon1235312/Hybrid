import type { LeagueContext } from "../league/types.js";

export type TeamMembershipRole = "PLAYER" | "MANAGER" | "CAPTAIN";
export type TeamMembershipStatus = "ACTIVE" | "ENDED";

export type TeamMembership = Readonly<{
  id: string;
  leagueId: string;
  leagueMemberId: string;
  /** Current Discord display name for roster presentation, when loaded as a list item. */
  playerDisplayName?: string;
  teamId: string;
  role: TeamMembershipRole;
  status: TeamMembershipStatus;
  endedAt: Date | null;
  endedByMemberId: string | null;
}>;

export type AssignPlayerToTeamInput = Readonly<{
  teamId: string;
  playerId: string;
  role: TeamMembershipRole;
}>;

export type EndTeamMembershipInput = Readonly<{
  membershipId: string;
}>;

export type RosterService = Readonly<{
  assignPlayerToTeam(context: LeagueContext, input: AssignPlayerToTeamInput): Promise<TeamMembership>;
  endTeamMembership(context: LeagueContext, input: EndTeamMembershipInput): Promise<TeamMembership>;
  listActiveTeamMemberships(context: LeagueContext, teamId: string): Promise<TeamMembership[]>;
  getActiveTeamMembership(context: LeagueContext, membershipId: string): Promise<TeamMembership>;
}>;
