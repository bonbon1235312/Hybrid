import type { ComponentAction, ComponentRouteIssuer, InteractionReplyOptions } from "../types.js";

export async function renderConfirmation(input: Readonly<{
  actorId: string;
  guildId: string;
  routes: ComponentRouteIssuer;
  action: ComponentAction;
  entityId: string;
  title: string;
  detail: string;
  state?: unknown;
}>): Promise<InteractionReplyOptions> {
  return {
    content: `**${input.title}**\n${input.detail}`,
    ephemeral: true,
    components: [{
      components: [
        { data: { type: "button", label: "Confirm", style: "danger", customId: await input.routes.issue({ guildId: input.guildId, action: input.action, entityId: input.entityId, actorId: input.actorId, ...(input.state === undefined ? {} : { state: input.state }) }) } },
        { data: { type: "button", label: "Cancel", style: "secondary", customId: await input.routes.issue({ guildId: input.guildId, action: "cancel", actorId: input.actorId }) } }
      ]
    }]
  };
}
