import { encodeComponentId } from "./ids.js";
import type { ModalOptions } from "../types.js";

export function renderSetupWizard(actorId: string): ModalOptions {
  return {
    customId: encodeComponentId({ action: "setup.submit", actorId }),
    title: "Set up Hybrid League",
    inputs: [
      { customId: "league-name", label: "League name", required: true, placeholder: "Hybrid League" },
      { customId: "roster-cap", label: "Default roster cap", required: true, placeholder: "12" }
    ]
  };
}
