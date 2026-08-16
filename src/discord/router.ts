import { randomUUID } from "node:crypto";

import type { LeagueContext } from "../modules/league/types.js";
import { DomainError } from "../platform/errors.js";
import { renderConfirmation } from "./ui/confirmation.js";
import {
  consumeComponentRoute,
  decodeComponentId,
  encodeComponentId,
  encodeStatefulComponentId,
  takeComponentState
} from "./ui/ids.js";
import { renderLeagueDashboard } from "./ui/league-dashboard.js";
import { renderRegistrationDecisionCard, renderRegistrationPanel } from "./ui/registration-panel.js";
import { renderSetupWizard } from "./ui/setup-wizard.js";
import { renderTeamDashboard } from "./ui/team-dashboard.js";
import type {
  ApplicationServices,
  BaseInteractionLike,
  CommandInteractionLike,
  ComponentInteractionLike,
  ComponentRoute,
  InteractionLike,
  InteractionReplyOptions
} from "./types.js";

export async function handleInteraction(interaction: InteractionLike, services: ApplicationServices): Promise<void> {
  try {
    if (isCommandInteraction(interaction)) {
      await routeCommand(interaction, services);
      return;
    }
    await routeComponent(interaction, services);
  } catch (error) {
    await respondWithError(interaction, services, error);
  }
}

export async function routeComponent(interaction: ComponentInteractionLike, services: ApplicationServices): Promise<void> {
  let route = decodeRoute(interaction.customId);
  assertRouteActor(route, interaction.user.id);

  if (!consumeComponentRoute(route)) {
    throw new DomainError("ACTION_EXPIRED", "That control has expired. Open `/league` for a fresh dashboard.");
  }

  if ((route.action === "team.detail" || route.action === "registration.select") && !route.entityId) {
    route = selectedRoute(interaction, route);
  }

  const context = await resolveContext(interaction, services);

  switch (route.action) {
    case "cancel":
    case "back":
    case "home":
      await interaction.deferUpdate();
      await interaction.editReply(await renderDashboard(interaction, services, context));
      return;
    case "setup":
      if (context || !canManageGuild(interaction)) {
        throw new DomainError("FORBIDDEN", "Only a server manager can set up a new league.");
      }
      await interaction.showModal(renderSetupWizard(interaction.user.id));
      return;
    case "setup.submit":
      if (context || !canManageGuild(interaction)) {
        throw new DomainError("FORBIDDEN", "Only a server manager can set up a new league.");
      }
      await interaction.deferUpdate();
      await services.leagues.bootstrapLeague({
        discordGuildId: requiredGuildId(interaction),
        actor: { discordUserId: interaction.user.id, displayName: interaction.user.displayName, manageGuild: true },
        name: textField(interaction, "league-name"),
        defaultRosterCap: Number(textField(interaction, "roster-cap"))
      });
      await interaction.editReply(await renderDashboard(interaction, services, await resolveContext(interaction, services)));
      return;
    case "registration.request":
      requireContext(context);
      await interaction.showModal({
        customId: componentId("registration.submit", interaction.user.id),
        title: "Request registration",
        inputs: [{ customId: "display-name", label: "Display name", required: true, placeholder: interaction.user.displayName }]
      });
      return;
    case "registration.submit":
      requireContext(context);
      await interaction.deferUpdate();
      await services.registrations.requestRegistration(context, { displayName: textField(interaction, "display-name") });
      await interaction.editReply({ content: "Registration submitted for staff review.", ephemeral: true });
      return;
    case "registrations":
      requireContext(context);
      await interaction.deferUpdate();
      await interaction.editReply(renderRegistrationPanel({
        actorId: interaction.user.id,
        registrations: await services.registrations.listPendingRegistrations(context)
      }));
      return;
    case "registration.approve":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await interaction.editReply(renderRegistrationDecisionCard({ actorId: interaction.user.id, registrationId: route.entityId }));
      return;
    case "registration.approve.confirm":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await services.registrations.reviewRegistration(context, { registrationId: route.entityId, decision: "APPROVE" });
      await interaction.editReply({ content: "Registration approved.", ephemeral: true });
      return;
    case "registration.decline":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await interaction.editReply(renderConfirmation({
        actorId: interaction.user.id,
        action: "registration.decline.confirm",
        entityId: route.entityId,
        title: "Decline registration?",
        detail: "The player can submit another request later."
      }));
      return;
    case "registration.decline.confirm":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await services.registrations.reviewRegistration(context, { registrationId: route.entityId, decision: "DECLINE" });
      await interaction.editReply({ content: "Registration declined.", ephemeral: true });
      return;
    case "team.detail":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await interaction.editReply(renderTeamDashboard({
        team: await services.teams.getTeamDashboard(context, route.entityId),
        actorId: interaction.user.id,
        canManageRoster: context.actor.managedTeamIds.includes(route.entityId)
          || context.actor.roles.includes("OWNER") || context.actor.roles.includes("ADMINISTRATOR")
      }));
      return;
    case "roster.assign":
      requireContext(context);
      requireEntity(route);
      await interaction.showModal({
        customId: componentId("roster.assign.submit", interaction.user.id, route.entityId),
        title: "Assign player",
        inputs: [
          { customId: "player-id", label: "Player membership ID", required: true },
          { customId: "membership-role", label: "Role: PLAYER, CAPTAIN, or MANAGER", required: true, placeholder: "PLAYER" }
        ]
      });
      return;
    case "roster.assign.submit":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await interaction.editReply(renderConfirmation({
        actorId: interaction.user.id,
        action: "roster.assign.confirm",
        entityId: route.entityId,
        title: "Assign player?",
        detail: "This queues the player’s Discord role synchronization.",
        customId: encodeStatefulComponentId({ action: "roster.assign.confirm", entityId: route.entityId, actorId: interaction.user.id }, {
          playerId: textField(interaction, "player-id"),
          role: textField(interaction, "membership-role").toUpperCase()
        })
      }));
      return;
    case "roster.assign.confirm": {
      requireContext(context);
      requireEntity(route);
      const assignment = takeComponentState<{ playerId: string; role: string }>(route);
      if (!assignment) {
        throw new DomainError("ACTION_EXPIRED", "That assignment confirmation is no longer valid.");
      }
      await interaction.deferUpdate();
      await services.rosters.assignPlayerToTeam(context, {
        teamId: route.entityId,
        playerId: assignment.playerId,
        role: assignment.role as "PLAYER" | "CAPTAIN" | "MANAGER"
      });
      await interaction.editReply({ content: "Player assigned. Discord role sync is queued.", ephemeral: true });
      return;
    }
    case "roster.release":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await interaction.editReply(renderConfirmation({
        actorId: interaction.user.id,
        action: "roster.release.confirm",
        entityId: route.entityId,
        title: "Release player?",
        detail: "This ends the active membership and queues a role sync."
      }));
      return;
    case "roster.release.confirm":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.rosters.endTeamMembership(context, { membershipId: route.entityId });
      await interaction.editReply({ content: "Player released. Discord role sync is queued.", ephemeral: true });
      return;
  }
}

async function routeCommand(interaction: CommandInteractionLike, services: ApplicationServices): Promise<void> {
  if (interaction.commandName === "help") {
    await interaction.reply({
      content: "Use `/league` for setup, registration, team, roster, and staff review actions. All controls are private to you.",
      ephemeral: true
    });
    return;
  }
  if (interaction.commandName !== "league") {
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const context = await resolveContext(interaction, services);
  await interaction.editReply(await renderDashboard(interaction, services, context));
}

async function renderDashboard(
  interaction: BaseInteractionLike,
  services: ApplicationServices,
  context: Awaited<ReturnType<ApplicationServices["leagues"]["resolveLeagueContext"]>>
): Promise<InteractionReplyOptions> {
  if (!context) {
    return renderLeagueDashboard({
      context: null,
      canManageGuild: canManageGuild(interaction),
      teams: [],
      pendingRegistrations: [],
      actorId: interaction.user.id
    });
  }

  const teams = await services.teams.listTeams(context);
  const canReview = context.actor.roles.some((role) => role === "OWNER" || role === "ADMINISTRATOR" || role === "STAFF");
  const pendingRegistrations = canReview ? await services.registrations.listPendingRegistrations(context) : [];

  return renderLeagueDashboard({ context, canManageGuild: false, teams, pendingRegistrations, actorId: interaction.user.id });
}

function selectedRoute(interaction: ComponentInteractionLike, parent: ComponentRoute): ComponentRoute {
  const selected = interaction.values?.[0];
  const route = selected ? decodeComponentId(selected) : null;

  if (!route || route.actorId !== interaction.user.id || !consumeComponentRoute(route)) {
    throw new DomainError("ACTION_EXPIRED", "That selection has expired. Open `/league` for a fresh dashboard.");
  }
  if (parent.action === "team.detail" && route.action !== "team.detail") {
    throw new DomainError("ACTION_EXPIRED", "That selection is no longer valid.");
  }
  if (parent.action === "registration.select" && route.action !== "registration.approve") {
    throw new DomainError("ACTION_EXPIRED", "That selection is no longer valid.");
  }
  return route;
}

function decodeRoute(value: string): ComponentRoute {
  const route = decodeComponentId(value);
  if (!route) {
    throw new DomainError("ACTION_EXPIRED", "That control has expired. Open `/league` for a fresh dashboard.");
  }
  return route;
}

function assertRouteActor(route: ComponentRoute, actorId: string): void {
  if (route.actorId !== actorId) {
    throw new DomainError("FORBIDDEN", "This control belongs to another user.");
  }
}

async function resolveContext(interaction: BaseInteractionLike, services: ApplicationServices) {
  return interaction.guildId ? services.leagues.resolveLeagueContext(interaction.guildId, interaction.user.id) : null;
}

function requireContext(context: LeagueContext | null): asserts context is LeagueContext {
  if (!context) {
    throw new DomainError("FORBIDDEN", "Open `/league` in a configured server first.");
  }
}

function requireEntity(route: ComponentRoute): asserts route is ComponentRoute & { entityId: string } {
  if (!route.entityId) {
    throw new DomainError("ACTION_EXPIRED", "That control is incomplete. Open `/league` for a fresh dashboard.");
  }
}

function textField(interaction: ComponentInteractionLike, customId: string): string {
  const value = interaction.fields?.getTextInputValue(customId).trim();
  if (!value) {
    throw new DomainError("INVALID_INPUT", "Please complete the required field.");
  }
  return value;
}

function canManageGuild(interaction: BaseInteractionLike): boolean {
  return interaction.manageGuild === true;
}

function requiredGuildId(interaction: BaseInteractionLike): string {
  if (!interaction.guildId) {
    throw new DomainError("FORBIDDEN", "This action must be used in a server.");
  }
  return interaction.guildId;
}

function componentId(action: ComponentRoute["action"], actorId: string, entityId?: string): string {
  return encodeComponentId({ action, actorId, ...(entityId ? { entityId } : {}) });
}

function isCommandInteraction(interaction: InteractionLike): interaction is CommandInteractionLike {
  return "commandName" in interaction && interaction.isChatInputCommand();
}

async function respondWithError(interaction: BaseInteractionLike, services: ApplicationServices, error: unknown): Promise<void> {
  if (error instanceof DomainError) {
    const response = { content: error.message, ephemeral: true } as const;
    if (interaction.acknowledged) {
      await interaction.editReply(response);
    } else {
      await interaction.reply(response);
    }
    return;
  }

  const correlationId = randomUUID();
  services.logger?.error({ err: error, correlationId }, "Discord interaction failed");
  const response = { content: `Something went wrong. Reference: ${correlationId}`, ephemeral: true } as const;
  if (interaction.acknowledged) {
    await interaction.editReply(response);
  } else {
    await interaction.reply(response);
  }
}
