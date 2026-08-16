import { encodeComponentId } from "./ids.js";
import type { TeamDashboard } from "../../modules/teams/types.js";
import type { InteractionReplyOptions } from "../types.js";

export function renderTeamDashboard(input: Readonly<{ team: TeamDashboard; actorId: string; canManageRoster: boolean }>): InteractionReplyOptions {
  const action = input.canManageRoster
    ? [{ data: { type: "button" as const, label: "Assign player", style: "primary" as const, customId: encodeComponentId({ action: "roster.assign", entityId: input.team.id, actorId: input.actorId }) } }]
    : [];

  return {
    content: `**${input.team.name}** · ${input.team.rosterCount}/${input.team.rosterCap}\n${input.team.status} · Discord role ${input.team.discordRoleState.toLowerCase()}`,
    ephemeral: true,
    components: [{
      components: [
        ...action,
        { data: { type: "button", label: "Home", style: "secondary", customId: encodeComponentId({ action: "home", actorId: input.actorId }) } },
        { data: { type: "button", label: "Back", style: "secondary", customId: encodeComponentId({ action: "back", actorId: input.actorId }) } }
      ]
    }]
  };
}
