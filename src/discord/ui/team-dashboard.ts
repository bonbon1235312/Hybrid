import type { TeamMembership } from "../../modules/rosters/types.js";
import type { TeamDashboard } from "../../modules/teams/types.js";
import type { ComponentRouteIssuer, InteractionReplyOptions, ReplyComponent } from "../types.js";

export async function renderTeamDashboard(input: Readonly<{
  team: TeamDashboard;
  actorId: string;
  guildId: string;
  routes: ComponentRouteIssuer;
  canManageRoster: boolean;
  canManageTeam: boolean;
  memberships: readonly TeamMembership[];
}>): Promise<InteractionReplyOptions> {
  const actions: ReplyComponent[] = input.canManageRoster
    ? [{ data: { type: "button" as const, label: "Assign player", style: "primary" as const, customId: await input.routes.issue({ guildId: input.guildId, action: "roster.assign", entityId: input.team.id, actorId: input.actorId }) } }]
    : [];
  if (input.canManageTeam) {
    actions.push({ data: {
      type: "button",
      label: input.team.discordRoleId ? "Change Discord role" : "Map Discord role",
      style: "secondary",
      customId: await input.routes.issue({ guildId: input.guildId, action: "team.role.map", entityId: input.team.id, actorId: input.actorId })
    } });
  }

  return {
    content: `**${input.team.name}** · ${input.team.rosterCount}/${input.team.rosterCap}\n${input.team.status} · Discord role ${input.team.discordRoleState.toLowerCase()}`,
    ephemeral: true,
    components: [
      {
        components: [
        ...actions,
        { data: { type: "button", label: "Home", style: "secondary", customId: await input.routes.issue({ guildId: input.guildId, action: "home", actorId: input.actorId }) } },
        { data: { type: "button", label: "Back", style: "secondary", customId: await input.routes.issue({ guildId: input.guildId, action: "back", actorId: input.actorId }) } }
        ]
      },
      ...(input.canManageRoster && input.memberships.length > 0 ? [{
        components: [{
          data: {
            type: "select" as const,
            customId: await input.routes.issue({ guildId: input.guildId, action: "roster.membership.select", actorId: input.actorId }),
            options: await Promise.all(input.memberships.slice(0, 25).map(async (membership) => ({
              label: releaseLabel(membership),
              value: await input.routes.issue({ guildId: input.guildId, action: "roster.release", entityId: membership.id, actorId: input.actorId }),
              description: `${membership.role.toLowerCase()} membership`
            })))
          }
        }]
      }] : [])
    ]
  };
}

function releaseLabel(membership: TeamMembership): string {
  const displayName = membership.playerDisplayName?.trim().replace(/\s+/g, " ") || "Player";
  return `Release ${displayName.slice(0, 92)}`;
}
