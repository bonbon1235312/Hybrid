import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction
} from "discord.js";

import { handleInteraction } from "./router.js";
import type { DiscordRoleGateway } from "../modules/discord-jobs/worker.js";
import type {
  ApplicationServices,
  BaseInteractionLike,
  ComponentInteractionLike,
  InteractionLike,
  InteractionReplyOptions,
  ModalOptions,
  ReplyComponent
} from "./types.js";

/** Creates the discord.js transport adapter. Command registration remains an explicit deployment concern. */
export function createDiscordClient(services: ApplicationServices): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on("interactionCreate", (interaction) => {
    const adapted = adaptInteraction(interaction);
    if (adapted) {
      void handleInteraction(adapted, services);
    }
  });
  return client;
}

/** Discord.js implementation of the tenant-aware role reconciliation port. */
export function createDiscordRoleGateway(client: Client): DiscordRoleGateway {
  return {
    getMemberRoles: async (discordGuildId, discordUserId) => {
      const guild = await client.guilds.fetch(discordGuildId);
      const member = await guild.members.fetch(discordUserId);
      return [...member.roles.cache.keys()].filter((roleId) => roleId !== guild.id);
    },
    addMemberRole: async (discordGuildId, discordUserId, roleId) => {
      const guild = await client.guilds.fetch(discordGuildId);
      if (roleId !== guild.id) await (await guild.members.fetch(discordUserId)).roles.add(roleId);
    },
    removeMemberRole: async (discordGuildId, discordUserId, roleId) => {
      const guild = await client.guilds.fetch(discordGuildId);
      if (roleId !== guild.id) await (await guild.members.fetch(discordUserId)).roles.remove(roleId);
    },
    roleExists: async (discordGuildId, roleId) => {
      if (roleId === discordGuildId) {
        return false;
      }
      const guild = await client.guilds.fetch(discordGuildId);
      try {
        return Boolean(await guild.roles.fetch(roleId));
      } catch (error) {
        if (isUnknownRole(error)) {
          return false;
        }
        throw error;
      }
    }
  };
}

function isUnknownRole(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && String(error.code) === "10011";
}

function adaptInteraction(interaction: Interaction): InteractionLike | null {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isUserSelectMenu() && !interaction.isRoleSelectMenu() && !interaction.isModalSubmit()) {
    return null;
  }

  let acknowledged = false;
  const base: BaseInteractionLike = {
    guildId: interaction.guildId,
    user: { id: interaction.user.id, displayName: interaction.user.globalName ?? interaction.user.username },
    manageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    get acknowledged() { return acknowledged; },
    reply: async (options) => {
      acknowledged = true;
      return interaction.reply(toDiscordReply(options));
    },
    editReply: async (options) => interaction.editReply(toDiscordReply(options)),
    showModal: async (options) => {
      acknowledged = true;
      if (!("showModal" in interaction)) {
        throw new Error("Modal submissions cannot open another modal.");
      }
      return interaction.showModal(toDiscordModal(options));
    }
  };

  if (interaction.isChatInputCommand()) {
    return {
      ...base,
      commandName: interaction.commandName,
      isChatInputCommand: () => true,
      get acknowledged() { return acknowledged; },
      deferReply: async (options) => {
        acknowledged = true;
        return interaction.deferReply(options);
      }
    };
  }

  return {
    ...base,
    customId: interaction.customId,
    ...(interaction.isStringSelectMenu() || interaction.isUserSelectMenu() || interaction.isRoleSelectMenu() ? { values: interaction.values } : {}),
    isButton: () => interaction.isButton(),
    isStringSelectMenu: () => interaction.isStringSelectMenu(),
    isModalSubmit: () => interaction.isModalSubmit(),
    get acknowledged() { return acknowledged; },
    deferUpdate: async () => {
      acknowledged = true;
      if (interaction.isModalSubmit()) {
        return interaction.deferReply({ ephemeral: true });
      }
      return interaction.deferUpdate();
    },
    ...(interaction.isModalSubmit() ? {
      fields: { getTextInputValue: (customId: string) => interaction.fields.getTextInputValue(customId) }
    } : {})
  } as ComponentInteractionLike;
}

function toDiscordReply(options: InteractionReplyOptions) {
  return {
    content: options.content,
    ephemeral: options.ephemeral,
    ...(options.components ? { components: options.components.map(toDiscordRow) } : {})
  };
}

function toDiscordRow(row: Readonly<{ components: readonly ReplyComponent[] }>) {
  const components = row.components.map((component) => toDiscordComponent(component));
  return new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder | RoleSelectMenuBuilder>().addComponents(components);
}

function toDiscordComponent(component: ReplyComponent): ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder | RoleSelectMenuBuilder {
  const data = component.data;
  if (data.type === "user-select") return new UserSelectMenuBuilder().setCustomId(data.customId);
  if (data.type === "role-select") return new RoleSelectMenuBuilder().setCustomId(data.customId);
  if (data.type === "select") {
    return new StringSelectMenuBuilder()
      .setCustomId(data.customId)
      .setOptions((data.options ?? []).map((option) => ({
        label: option.label,
        value: option.value,
        ...(option.description ? { description: option.description } : {})
      })));
  }

  return new ButtonBuilder()
    .setCustomId(data.customId)
    .setLabel(data.label ?? "Continue")
    .setStyle(buttonStyle(data.style));
}

function toDiscordModal(options: ModalOptions): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(options.customId)
    .setTitle(options.title)
    .addComponents(options.inputs.map((input) => new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(input.customId)
        .setLabel(input.label)
        .setRequired(input.required)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(input.placeholder ?? "")
    )));
}

function buttonStyle(style: ReplyComponent["data"]["style"]): ButtonStyle {
  switch (style) {
    case "danger": return ButtonStyle.Danger;
    case "success": return ButtonStyle.Success;
    case "secondary": return ButtonStyle.Secondary;
    default: return ButtonStyle.Primary;
  }
}
