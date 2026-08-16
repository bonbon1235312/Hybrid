import type { ComponentRouteIssuer, ModalOptions } from "../types.js";

export async function renderSetupWizard(input: Readonly<{
  actorId: string;
  guildId: string;
  routes: ComponentRouteIssuer;
}>): Promise<ModalOptions> {
  return {
    customId: await input.routes.issue({ guildId: input.guildId, action: "setup.submit", actorId: input.actorId }),
    title: "Set up Hybrid League",
    inputs: [
      { customId: "league-name", label: "League name", required: true, placeholder: "Hybrid League" },
      { customId: "roster-cap", label: "Default roster cap", required: true, placeholder: "12" }
    ]
  };
}
