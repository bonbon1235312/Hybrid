import { encodeComponentId } from "./ids.js";
import type { RegistrationSummary } from "../../modules/registrations/types.js";
import type { InteractionReplyOptions } from "../types.js";

export function renderRegistrationPanel(input: Readonly<{ actorId: string; registrations: readonly RegistrationSummary[] }>): InteractionReplyOptions {
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
          customId: encodeComponentId({ action: "registration.select", actorId: input.actorId }),
          options: input.registrations.slice(0, 25).map((registration) => ({
            label: registration.displayName.slice(0, 100),
            value: encodeComponentId({ action: "registration.approve", entityId: registration.id, actorId: input.actorId }),
            description: "Review request"
          }))
        }
      }]
    }]
  };
}

export function renderRegistrationDecisionCard(input: Readonly<{ actorId: string; registrationId: string }>): InteractionReplyOptions {
  return {
    content: "**Review registration**\nChoose an outcome. The request is reloaded before the decision is applied.",
    ephemeral: true,
    components: [{
      components: [
        { data: { type: "button", label: "Confirm approval", style: "success", customId: encodeComponentId({ action: "registration.approve.confirm", entityId: input.registrationId, actorId: input.actorId }) } },
        { data: { type: "button", label: "Confirm decline", style: "danger", customId: encodeComponentId({ action: "registration.decline.confirm", entityId: input.registrationId, actorId: input.actorId }) } },
        { data: { type: "button", label: "Cancel", style: "secondary", customId: encodeComponentId({ action: "cancel", actorId: input.actorId }) } }
      ]
    }]
  };
}
