import { encodeComponentId } from "./ids.js";
import type { ComponentAction, InteractionReplyOptions } from "../types.js";

export function renderConfirmation(input: Readonly<{
  actorId: string;
  action: ComponentAction;
  entityId: string;
  title: string;
  detail: string;
  customId?: string;
}>): InteractionReplyOptions {
  return {
    content: `**${input.title}**\n${input.detail}`,
    ephemeral: true,
    components: [{
      components: [
        { data: { type: "button", label: "Confirm", style: "danger", customId: input.customId ?? encodeComponentId({ action: input.action, entityId: input.entityId, actorId: input.actorId }) } },
        { data: { type: "button", label: "Cancel", style: "secondary", customId: encodeComponentId({ action: "cancel", actorId: input.actorId }) } }
      ]
    }]
  };
}
