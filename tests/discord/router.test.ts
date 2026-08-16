import { describe, expect, it } from "vitest";

import { decodeComponentId, encodeComponentId } from "../../src/discord/ui/ids.js";
import { routeComponent } from "../../src/discord/router.js";
import { renderTeamDashboard } from "../../src/discord/ui/team-dashboard.js";
import type { ApplicationServices, ComponentInteractionLike, InteractionReplyOptions } from "../../src/discord/types.js";
import type { LeagueContext } from "../../src/modules/league/types.js";

describe("handleInteraction component routing", () => {
  it("rejects stale component actions", async () => {
    const staleApproveButton = encodeComponentId({
      action: "registration.approve",
      entityId: "registration-1",
      actorId: "player-1",
      version: 1,
      expiresAt: Date.now() - 1
    });
    const playerInteraction: ComponentInteractionLike = {
      customId: staleApproveButton,
      guildId: "guild-1",
      user: { id: "player-1", displayName: "Player One" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
      reply: async () => undefined,
      showModal: async () => undefined
    };

    await expect(routeComponent(playerInteraction, {} as ApplicationServices))
      .rejects.toMatchObject({ code: "ACTION_EXPIRED" });
  });

  it("rejects a component issued to another Discord user", async () => {
    const route = encodeComponentId({
      action: "home",
      actorId: "owner-1",
      version: 1,
      expiresAt: Date.now() + 60_000
    });
    const interaction: ComponentInteractionLike = {
      customId: route,
      guildId: "guild-1",
      user: { id: "player-1", displayName: "Player One" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
      reply: async () => undefined,
      showModal: async () => undefined
    };

    await expect(routeComponent(interaction, {} as ApplicationServices))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets the requesting player withdraw a reloaded pending registration after confirmation", async () => {
    const context = playerContext();
    const registrationReads: string[] = [];
    const registrations = {
      requestRegistration: async () => pendingRegistration(),
      getRegistration: async (_context: LeagueContext, registrationId: string) => {
        registrationReads.push(registrationId);
        return pendingRegistration();
      },
      withdrawRegistration: async (_context: LeagueContext, registrationId: string) => {
        withdrawn.push(registrationId);
        return { ...pendingRegistration(), status: "WITHDRAWN" as const };
      }
    };
    const withdrawn: string[] = [];
    const services = servicesFor(context, { registrations });
    const submitted = componentInteraction(componentId("registration.submit", "player-1"), "player-1", { "display-name": "Player One" });

    await routeComponent(submitted, services);
    const select = componentInteraction(buttonId(submitted, "Withdraw registration"), "player-1");
    await routeComponent(select, services);
    const confirm = componentInteraction(buttonId(select, "Confirm"), "player-1");
    await routeComponent(confirm, services);

    expect(withdrawn).toEqual(["registration-1"]);
    expect(registrationReads).toEqual(["registration-1", "registration-1"]);
    expect(confirm.edits.at(-1)?.content).toBe("Registration withdrawn.");
  });

  it("rejects a pending-registration withdrawal issued to another player before service access", async () => {
    const getRegistrationCalls: string[] = [];
    const services = servicesFor(playerContext(), {
      registrations: { getRegistration: async (_context: LeagueContext, id: string) => {
        getRegistrationCalls.push(id);
        return pendingRegistration();
      } }
    });
    const interaction = componentInteraction(encodeComponentId({
      action: "registration.withdraw",
      entityId: "registration-1",
      actorId: "player-1"
    }), "player-2");

    await expect(routeComponent(interaction, services)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(getRegistrationCalls).toEqual([]);
  });

  it("lets a manager release an active membership only after it is reloaded and confirmed", async () => {
    const context = managerContext();
    const released: string[] = [];
    const membershipReads: string[] = [];
    const rosters = {
      getActiveTeamMembership: async (_context: LeagueContext, membershipId: string) => {
        membershipReads.push(membershipId);
        return activeMembership();
      },
      endTeamMembership: async (_context: LeagueContext, input: { membershipId: string }) => {
        released.push(input.membershipId);
        return { ...activeMembership(), status: "ENDED" as const };
      }
    };
    const services = servicesFor(context, { rosters });
    const select = componentInteraction(
      encodeComponentId({ action: "roster.membership.select", actorId: "manager-1" }),
      "manager-1",
      undefined,
      [encodeComponentId({ action: "roster.release", entityId: "membership-1", actorId: "manager-1" })]
    );

    await routeComponent(select, services);
    const confirm = componentInteraction(buttonId(select, "Confirm"), "manager-1");
    await routeComponent(confirm, services);

    expect(released).toEqual(["membership-1"]);
    expect(membershipReads).toEqual(["membership-1", "membership-1"]);
    expect(confirm.edits.at(-1)?.content).toBe("Player released. Discord role sync is queued.");
  });

  it("rejects a roster release control replayed by a different manager before service access", async () => {
    const membershipReads: string[] = [];
    const services = servicesFor(managerContext(), {
      rosters: { getActiveTeamMembership: async (_context: LeagueContext, id: string) => {
        membershipReads.push(id);
        return activeMembership();
      } }
    });
    const interaction = componentInteraction(encodeComponentId({
      action: "roster.release",
      entityId: "membership-1",
      actorId: "manager-1"
    }), "manager-2");

    await expect(routeComponent(interaction, services)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(membershipReads).toEqual([]);
  });

  it("renders an actor-bound active roster selection for a manager", () => {
    const dashboard = renderTeamDashboard({
      team: { id: "team-1", name: "Blue", rosterCap: 8, rosterCount: 1, status: "ACTIVE", discordRoleId: null, discordRoleState: "UNMAPPED", manager: null },
      actorId: "manager-1",
      canManageRoster: true,
      memberships: [activeMembership()]
    });
    const select = dashboard.components?.flatMap((row) => row.components).find((component) => component.data.type === "select");
    const value = select?.data.options?.[0]?.value;

    expect(value).toBeDefined();
    expect(value && decodeComponentId(value)).toMatchObject({ action: "roster.release", actorId: "manager-1" });
  });
});

function playerContext(): LeagueContext {
  return {
    leagueId: "league-1",
    discordGuildId: "guild-1",
    actor: { discordUserId: "player-1", leagueMemberId: "member-player-1", role: "PLAYER", roles: ["PLAYER"], managedTeamIds: [] }
  };
}

function managerContext(): LeagueContext {
  return {
    leagueId: "league-1",
    discordGuildId: "guild-1",
    actor: { discordUserId: "manager-1", leagueMemberId: "member-manager-1", role: "MANAGER", roles: ["MANAGER"], managedTeamIds: ["team-1"] }
  };
}

function pendingRegistration() {
  return {
    id: "registration-1", leagueId: "league-1", leagueMemberId: "member-player-1", displayName: "Player One", status: "PENDING" as const,
    requestedAt: new Date("2026-08-16T00:00:00.000Z"), reviewedAt: null, reviewedByMemberId: null, declinedReason: null
  };
}

function activeMembership() {
  return {
    id: "membership-1", leagueId: "league-1", leagueMemberId: "member-player-1", teamId: "team-1", role: "PLAYER" as const,
    status: "ACTIVE" as const, endedAt: null, endedByMemberId: null
  };
}

function servicesFor(context: LeagueContext, overrides: Record<string, unknown>): ApplicationServices {
  return {
    leagues: { resolveLeagueContext: async () => context },
    ...overrides
  } as unknown as ApplicationServices;
}

function componentInteraction(
  customId: string,
  userId: string,
  fields?: Record<string, string>,
  values?: readonly string[]
): ComponentInteractionLike & { edits: InteractionReplyOptions[] } {
  const edits: InteractionReplyOptions[] = [];
  return {
    customId,
    guildId: "guild-1",
    user: { id: userId, displayName: userId },
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferUpdate: async () => undefined,
    editReply: async (options) => { edits.push(options); },
    reply: async () => undefined,
    showModal: async () => undefined,
    ...(fields ? { fields: { getTextInputValue: (id: string) => fields[id] ?? "" } } : {}),
    ...(values ? { values } : {}),
    edits
  };
}

function buttonId(interaction: ComponentInteractionLike & { edits: InteractionReplyOptions[] }, label: string): string {
  const options = interaction.edits.at(-1);
  const button = options?.components?.flatMap((row) => row.components).find((component) => component.data.label === label);
  if (!button) {
    throw new Error(`Expected ${label} button`);
  }
  return button.data.customId;
}

function componentId(action: "registration.submit", actorId: string): string {
  return encodeComponentId({ action, actorId });
}
