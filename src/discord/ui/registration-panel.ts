import type { RegistrationSummary } from "../../modules/registrations/types.js";
import type { ComponentRouteIssuer, InteractionReplyOptions } from "../types.js";

type RouteInput = Readonly<{ actorId: string; guildId: string; routes: ComponentRouteIssuer }>;

export async function renderRegistrationPanel(input: RouteInput & Readonly<{ registrations: readonly RegistrationSummary[] }>): Promise<InteractionReplyOptions> {
  if (input.registrations.length === 0) {
    return { content: "**Registration review**\nNo registrations are waiting for review.", ephemeral: true };
  }

  return {
    content: `**Registration review**\n${input.registrations.length} pending request${input.registrations.length === 1 ? "" : "s"}.`,
    ephemeral: true,
    components: [{
      components: [{
        data: {
          type: "select",
          customId: await input.routes.issue({ guildId: input.guildId, action: "registration.select", actorId: input.actorId }),
          options: await Promise.all(input.registrations.slice(0, 25).map(async (registration) => ({
            label: registration.displayName.slice(0, 100),
            value: await input.routes.issue({ guildId: input.guildId, action: "registration.approve", entityId: registration.id, actorId: input.actorId }),
            description: "Review request"
          })))
        }
      }]
    }]
  };
}

export async function renderRegistrationDecisionCard(input: RouteInput & Readonly<{ registrationId: string }>): Promise<InteractionReplyOptions> {
  return {
    content: "**Review registration**\nChoose an outcome. The request is reloaded before the decision is applied.",
    ephemeral: true,
    components: [{
      components: [
        { data: { type: "button", label: "Confirm approval", style: "success", customId: await input.routes.issue({ guildId: input.guildId, action: "registration.approve.confirm", entityId: input.registrationId, actorId: input.actorId }) } },
        { data: { type: "button", label: "Confirm decline", style: "danger", customId: await input.routes.issue({ guildId: input.guildId, action: "registration.decline.confirm", entityId: input.registrationId, actorId: input.actorId }) } },
        { data: { type: "button", label: "Cancel", style: "secondary", customId: await input.routes.issue({ guildId: input.guildId, action: "cancel", actorId: input.actorId }) } }
      ]
    }]
  };
}

export async function renderPendingRegistrationCard(input: RouteInput & Readonly<{ registrationId: string }>): Promise<InteractionReplyOptions> {
  return {
    content: "**Registration submitted**\nYour request is pending staff review. You can withdraw it while it is still pending.",
    ephemeral: true,
    components: [{
      components: [
        { data: { type: "button", label: "Withdraw registration", style: "danger", customId: await input.routes.issue({ guildId: input.guildId, action: "registration.withdraw", entityId: input.registrationId, actorId: input.actorId }) } },
        { data: { type: "button", label: "Home", style: "secondary", customId: await input.routes.issue({ guildId: input.guildId, action: "home", actorId: input.actorId }) } }
      ]
    }]
  };
}
