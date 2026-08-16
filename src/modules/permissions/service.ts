import { DomainError } from "../../platform/errors.js";
import type { LeagueContext, LeagueRole } from "../league/types.js";
import type { Permission } from "./types.js";

const permissionsByRole: Readonly<Record<LeagueRole, readonly Permission[]>> = {
  OWNER: ["LEAGUE_SETTINGS", "TEAM_MANAGE", "REGISTRATION_REVIEW", "ROSTER_MANAGE"],
  ADMINISTRATOR: ["TEAM_MANAGE", "REGISTRATION_REVIEW", "ROSTER_MANAGE"],
  STAFF: ["REGISTRATION_REVIEW"],
  MANAGER: ["ROSTER_MANAGE"],
  CAPTAIN: [],
  PLAYER: []
};

export function requirePermission(context: LeagueContext, permission: Permission, teamId?: string): void {
  const hasPermission = context.actor.roles.some((role) => permissionsByRole[role].includes(permission));

  if (!hasPermission || isOutsideManagerScope(context, permission, teamId)) {
    throw new DomainError("FORBIDDEN", "You are not permitted to perform this action.");
  }
}

function isOutsideManagerScope(context: LeagueContext, permission: Permission, teamId: string | undefined): boolean {
  if (permission !== "ROSTER_MANAGE" || !teamId) {
    return false;
  }

  const hasLeagueWideRosterAuthority = context.actor.roles.some(
    (role) => role === "OWNER" || role === "ADMINISTRATOR"
  );

  return !hasLeagueWideRosterAuthority && !context.actor.managedTeamIds.includes(teamId);
}
