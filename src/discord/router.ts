import { randomUUID } from "node:crypto";

import type { LeagueContext } from "../modules/league/types.js";
import { DomainError } from "../platform/errors.js";
import { renderConfirmation } from "./ui/confirmation.js";
import { renderLeagueDashboard } from "./ui/league-dashboard.js";
import { renderPendingRegistrationCard, renderRegistrationDecisionCard, renderRegistrationPanel } from "./ui/registration-panel.js";
import { renderSetupWizard } from "./ui/setup-wizard.js";
import { renderTeamDashboard } from "./ui/team-dashboard.js";
import type {
  ApplicationServices,
  BaseInteractionLike,
  CommandInteractionLike,
  ComponentInteractionLike,
  ComponentRoute,
  InteractionLike,
  InteractionReplyOptions,
  ModalOptions
} from "./types.js";

const expiredControlMessage = "That control has expired or was already used. Open `/league` for a fresh dashboard.";

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
  let route = await consumeRoute(interaction, services, interaction.customId);
  if (isRouteSelection(route)) {
    route = await selectedRoute(interaction, services, route);
  }

  const guildId = requiredGuildId(interaction);
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
      await interaction.showModal(await renderSetupWizard({ actorId: interaction.user.id, guildId, routes: services.routes }));
      return;
    case "setup.submit":
      if (context || !canManageGuild(interaction)) {
        throw new DomainError("FORBIDDEN", "Only a server manager can set up a new league.");
      }
      await interaction.deferUpdate();
      await services.leagues.bootstrapLeague({
        discordGuildId: guildId,
        actor: { discordUserId: interaction.user.id, displayName: interaction.user.displayName, manageGuild: true },
        name: textField(interaction, "league-name"),
        defaultRosterCap: Number(textField(interaction, "roster-cap"))
      });
      await interaction.editReply(await renderDashboard(interaction, services, await resolveContext(interaction, services)));
      return;
    case "registration.request":
      requireContext(context);
      await interaction.showModal(await registrationModal(interaction, services));
      return;
    case "registration.submit": {
      requireContext(context);
      await interaction.deferUpdate();
      const registration = await services.registrations.requestRegistration(context, { displayName: textField(interaction, "display-name") });
      await interaction.editReply(await renderPendingRegistrationCard({
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
        registrationId: registration.id
      }));
      return;
    }
    case "registration.withdraw":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await interaction.editReply(await renderConfirmation({
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
        action: "registration.withdraw.confirm",
        entityId: route.entityId,
        title: "Withdraw registration?",
        detail: "Your pending request will be withdrawn. You can submit a new request later."
      }));
      return;
    case "registration.withdraw.confirm":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await services.registrations.withdrawRegistration(context, route.entityId);
      await interaction.editReply({ content: "Registration withdrawn.", ephemeral: true });
      return;
    case "registrations":
      requireContext(context);
      await interaction.deferUpdate();
      await interaction.editReply(await renderRegistrationPanel({
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
        registrations: await services.registrations.listPendingRegistrations(context)
      }));
      return;
    case "registration.approve":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.registrations.getRegistration(context, route.entityId);
      await interaction.editReply(await renderRegistrationDecisionCard({
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
        registrationId: route.entityId
      }));
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
      await interaction.editReply(await renderConfirmation({
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
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
    case "team.create":
      requireContext(context);
      await interaction.showModal(await teamCreationModal(interaction, services));
      return;
    case "team.create.submit":
      requireContext(context);
      await interaction.deferUpdate();
      await services.teams.createTeam(context, {
        name: textField(interaction, "team-name"),
        rosterCap: Number(textField(interaction, "roster-cap"))
      });
      await interaction.editReply(await renderDashboard(interaction, services, context));
      return;
    case "team.detail": {
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      const team = await services.teams.getTeamDashboard(context, route.entityId);
      const canManageRoster = context.actor.managedTeamIds.includes(route.entityId)
        || context.actor.roles.includes("OWNER") || context.actor.roles.includes("ADMINISTRATOR");
      await interaction.editReply(await renderTeamDashboard({
        team,
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
        canManageRoster,
        memberships: canManageRoster ? await services.rosters.listActiveTeamMemberships(context, team.id) : []
      }));
      return;
    }
    case "roster.assign":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.teams.getTeamDashboard(context, route.entityId);
      await interaction.editReply({
        content: "**Assign player**\nChoose a Discord member. Hybrid checks their current league status before assignment.",
        ephemeral: true,
        components: [{
          components: [{
            data: {
              type: "user-select",
              customId: await services.routes.issue({
                guildId,
                actorId: interaction.user.id,
                action: "roster.assign.player",
                entityId: route.entityId
              })
            }
          }]
        }]
      });
      return;
    case "roster.assign.player": {
      requireContext(context);
      requireEntity(route);
      const discordUserId = interaction.values?.[0];
      if (!discordUserId) {
        throw new DomainError("INVALID_INPUT", "Choose a player from this server.");
      }
      // Resolve the selected Discord user at action time rather than trusting
      // any cached roster value or client-provided application identity.
      const playerContext = await services.leagues.resolveLeagueContext(guildId, discordUserId);
      if (!playerContext?.actor.leagueMemberId) {
        throw new DomainError("PLAYER_NOT_APPROVED", "That Discord member has no active league membership.");
      }
      await interaction.deferUpdate();
      await services.teams.getTeamDashboard(context, route.entityId);
      await services.rosters.assignPlayerToTeam(context, {
        teamId: route.entityId,
        playerId: playerContext.actor.leagueMemberId,
        role: "PLAYER"
      });
      await interaction.editReply({ content: "Player assigned. Discord role sync is queued.", ephemeral: true });
      return;
    }
    case "roster.release":
      requireContext(context);
      requireEntity(route);
      await interaction.deferUpdate();
      await services.rosters.getActiveTeamMembership(context, route.entityId);
      await interaction.editReply(await renderConfirmation({
        actorId: interaction.user.id,
        guildId,
        routes: services.routes,
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
      await services.rosters.getActiveTeamMembership(context, route.entityId);
      await services.rosters.endTeamMembership(context, { membershipId: route.entityId });
      await interaction.editReply({ content: "Player released. Discord role sync is queued.", ephemeral: true });
      return;
  }
}

async function routeCommand(interaction: CommandInteractionLike, services: ApplicationServices): Promise<void> {
  if (interaction.commandName === "help") {
    await interaction.reply({
      content: "Use `/league` for setup, registration, teams, roster, and staff review. Controls are private to you and guide the next step.",
      ephemeral: true
    });
    return;
  }
  if (interaction.commandName !== "league") {
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(await renderDashboard(interaction, services, await resolveContext(interaction, services)));
}

async function renderDashboard(
  interaction: BaseInteractionLike,
  services: ApplicationServices,
  context: Awaited<ReturnType<ApplicationServices["leagues"]["resolveLeagueContext"]>>
): Promise<InteractionReplyOptions> {
  const guildId = requiredGuildId(interaction);
  if (!context) {
    return renderLeagueDashboard({
      context: null,
      canManageGuild: canManageGuild(interaction),
      teams: [],
      pendingRegistrations: [],
      actorId: interaction.user.id,
      guildId,
      routes: services.routes
    });
  }

  const teams = await services.teams.listTeams(context);
  const canReview = context.actor.roles.some((role) => role === "OWNER" || role === "ADMINISTRATOR" || role === "STAFF");
  const pendingRegistrations = canReview ? await services.registrations.listPendingRegistrations(context) : [];
  const ownPendingRegistration = await services.registrations.getPendingRegistrationForActor(context);

  return renderLeagueDashboard({
    context,
    canManageGuild: false,
    teams,
    pendingRegistrations,
    ...(ownPendingRegistration ? { pendingRegistrationId: ownPendingRegistration.id } : {}),
    actorId: interaction.user.id,
    guildId,
    routes: services.routes
  });
}

async function selectedRoute(
  interaction: ComponentInteractionLike,
  services: ApplicationServices,
  parent: ComponentRoute
): Promise<ComponentRoute> {
  const selectedId = interaction.values?.[0];
  if (!selectedId) {
    throw new DomainError("ACTION_EXPIRED", expiredControlMessage);
  }
  const route = await consumeRoute(interaction, services, selectedId);
  if ((parent.action === "team.detail" && route.action !== "team.detail")
    || (parent.action === "registration.select" && route.action !== "registration.approve")
    || (parent.action === "roster.membership.select" && route.action !== "roster.release")) {
    throw new DomainError("ACTION_EXPIRED", expiredControlMessage);
  }
  return route;
}

function isRouteSelection(route: ComponentRoute): boolean {
  return route.action === "team.detail" || route.action === "registration.select" || route.action === "roster.membership.select";
}

async function consumeRoute(
  interaction: ComponentInteractionLike,
  services: ApplicationServices,
  customId: string
): Promise<ComponentRoute> {
  const route = await services.routes.consume({
    guildId: requiredGuildId(interaction),
    actorId: interaction.user.id,
    customId
  });
  if (!route) {
    throw new DomainError("ACTION_EXPIRED", expiredControlMessage);
  }
  return route;
}

async function registrationModal(interaction: ComponentInteractionLike, services: ApplicationServices): Promise<ModalOptions> {
  return {
    customId: await services.routes.issue({
      guildId: requiredGuildId(interaction),
      actorId: interaction.user.id,
      action: "registration.submit"
    }),
    title: "Request registration",
    inputs: [{ customId: "display-name", label: "Display name", required: true, placeholder: interaction.user.displayName }]
  };
}

async function teamCreationModal(interaction: ComponentInteractionLike, services: ApplicationServices): Promise<ModalOptions> {
  return {
    customId: await services.routes.issue({
      guildId: requiredGuildId(interaction),
      actorId: interaction.user.id,
      action: "team.create.submit"
    }),
    title: "Create team",
    inputs: [
      { customId: "team-name", label: "Team name", required: true },
      { customId: "roster-cap", label: "Roster cap", required: true, placeholder: "12" }
    ]
  };
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
    throw new DomainError("ACTION_EXPIRED", expiredControlMessage);
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
