import type { LeagueContext } from "../../modules/league/types.js";
import type { RegistrationSummary } from "../../modules/registrations/types.js";
import type { TeamDashboard } from "../../modules/teams/types.js";
import type { ComponentRouteIssuer, InteractionReplyOptions, ReplyComponent } from "../types.js";

export type LeagueDashboardInput = Readonly<{
  context: LeagueContext | null;
  canManageGuild: boolean;
  teams: readonly TeamDashboard[];
  pendingRegistrations: readonly RegistrationSummary[];
  pendingRegistrationId?: string;
  actorId?: string;
  guildId: string;
  routes: ComponentRouteIssuer;
}>;

export async function renderLeagueDashboard(input: LeagueDashboardInput): Promise<InteractionReplyOptions> {
  const actorId = input.context?.actor.discordUserId ?? input.actorId ?? "dashboard";

  if (!input.context) {
    const setup = input.canManageGuild
      ? [{ data: { type: "button" as const, label: "Set up Hybrid", style: "primary" as const, customId: await input.routes.issue({ guildId: input.guildId, action: "setup", actorId }) } }]
      : [];
    return {
      content: input.canManageGuild
        ? "**Hybrid League**\nThis server is not configured yet. Set up your league to begin."
        : "**Hybrid League**\nThis server has not been configured yet. Ask a server manager to run `/league`.",
      ephemeral: true,
      ...(setup.length > 0 ? { components: [{ components: setup }] } : {})
    };
  }

  const context = input.context;
  const actions: ReplyComponent[] = input.pendingRegistrationId
    ? [{ data: { type: "button", label: "Withdraw registration", style: "danger", customId: await input.routes.issue({ guildId: input.guildId, action: "registration.withdraw", entityId: input.pendingRegistrationId, actorId }) } }]
    : [{ data: { type: "button", label: "Register", style: "primary", customId: await input.routes.issue({ guildId: input.guildId, action: "registration.request", actorId }) } }];

  if (context.actor.roles.includes("OWNER") || context.actor.roles.includes("ADMINISTRATOR") || context.actor.roles.includes("STAFF")) {
    actions.push({ data: { type: "button", label: `Registrations (${input.pendingRegistrations.length})`, style: "secondary", customId: await input.routes.issue({ guildId: input.guildId, action: "registrations", actorId }) } });
  }
  if (context.actor.roles.includes("OWNER") || context.actor.roles.includes("ADMINISTRATOR")) {
    actions.push({ data: { type: "button", label: "Create team", style: "primary", customId: await input.routes.issue({ guildId: input.guildId, action: "team.create", actorId }) } });
  }
  const teamSelect: ReplyComponent | null = input.teams.length > 0
    ? {
      data: {
        type: "select" as const,
        customId: await input.routes.issue({ guildId: input.guildId, action: "team.detail", actorId }),
        options: await Promise.all(input.teams.slice(0, 25).map(async (team) => ({
          label: team.name.slice(0, 100),
          value: await input.routes.issue({ guildId: input.guildId, action: "team.detail", entityId: team.id, actorId }),
          description: `${team.rosterCount}/${team.rosterCap} · ${team.status}`
        })))
      }
    }
    : null;

  return {
    content: `**League Dashboard**\nRole: ${context.actor.role} · ${input.teams.length} team${input.teams.length === 1 ? "" : "s"}.`,
    ephemeral: true,
    components: [
      { components: actions },
      ...(teamSelect ? [{ components: [teamSelect] }] : [])
    ]
  };
}
