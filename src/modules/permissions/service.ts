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

export function requirePermission(context: LeagueContext, permission: Permission): void {
  if (!permissionsByRole[context.actor.role].includes(permission)) {
    throw new DomainError("FORBIDDEN", "You are not permitted to perform this action.");
  }
}
