import type { Logger } from "pino";

import type { LeagueService } from "../modules/league/types.js";
import type { RegistrationService } from "../modules/registrations/types.js";
import type { RosterService } from "../modules/rosters/types.js";
import type { TeamService } from "../modules/teams/types.js";

export type ApplicationServices = Readonly<{
  leagues: LeagueService;
  teams: TeamService;
  registrations: RegistrationService;
  rosters: RosterService;
  routes: ComponentRouteStore;
  logger?: Pick<Logger, "error">;
}>;

export type DiscordUserLike = Readonly<{
  id: string;
  displayName: string;
}>;

export type ReplyComponent = Readonly<{
  data: Readonly<{
    type: "button" | "select" | "user-select" | "role-select";
    label?: string;
    customId: string;
    style?: "primary" | "secondary" | "danger" | "success";
    options?: readonly Readonly<{ label: string; value: string; description?: string }>[];
  }>;
}>;

export type InteractionReplyOptions = Readonly<{
  content: string;
  ephemeral: true;
  components?: readonly Readonly<{ components: readonly ReplyComponent[] }>[];
}>;

export type ModalInput = Readonly<{
  customId: string;
  label: string;
  required: boolean;
  placeholder?: string;
}>;

export type ModalOptions = Readonly<{
  customId: string;
  title: string;
  inputs: readonly ModalInput[];
}>;

export type ComponentAction =
  | "home"
  | "back"
  | "cancel"
  | "setup"
  | "setup.submit"
  | "team.detail"
  | "team.create"
  | "team.create.submit"
  | "team.role.map"
  | "team.role.select"
  | "registration.request"
  | "registration.submit"
  | "registration.withdraw"
  | "registration.withdraw.confirm"
  | "registrations"
  | "registration.select"
  | "registration.approve"
  | "registration.approve.confirm"
  | "registration.decline"
  | "registration.decline.confirm"
  | "roster.assign"
  | "roster.assign.player"
  | "roster.assign.role"
  | "roster.assign.confirm"
  | "roster.membership.select"
  | "roster.release"
  | "roster.release.confirm";

export type ComponentRoute = Readonly<{
  action: ComponentAction;
  entityId?: string;
  actorId: string;
  expiresAt: number;
  nonce: string;
  state: unknown;
}>;

export type ComponentRouteIssue = Readonly<{
  guildId: string;
  action: ComponentAction;
  entityId?: string;
  actorId: string;
  expiresAt?: number;
  state?: unknown;
}>;

export type ComponentRouteStore = Readonly<{
  issue(input: ComponentRouteIssue): Promise<string>;
  consume(input: Readonly<{ guildId: string; actorId: string; customId: string }>): Promise<ComponentRoute | null>;
}>;

export type ComponentRouteIssuer = Pick<ComponentRouteStore, "issue">;

export type BaseInteractionLike = Readonly<{
  guildId: string | null;
  user: DiscordUserLike;
  manageGuild?: boolean;
  reply(options: InteractionReplyOptions): Promise<unknown>;
  editReply(options: InteractionReplyOptions): Promise<unknown>;
  showModal(options: ModalOptions): Promise<unknown>;
  acknowledged?: boolean;
}>;

export type CommandInteractionLike = BaseInteractionLike & Readonly<{
  commandName: string;
  isChatInputCommand(): boolean;
  deferReply(options: { ephemeral: true }): Promise<unknown>;
}>;

export type ComponentInteractionLike = BaseInteractionLike & Readonly<{
  customId: string;
  values?: readonly string[];
  isButton(): boolean;
  isStringSelectMenu(): boolean;
  isModalSubmit(): boolean;
  deferUpdate(): Promise<unknown>;
  fields?: Readonly<{ getTextInputValue(customId: string): string }>;
}>;

export type InteractionLike = CommandInteractionLike | ComponentInteractionLike;
