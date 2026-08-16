import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction
} from "discord.js";

import { handleInteraction } from "./router.js";
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

function adaptInteraction(interaction: Interaction): InteractionLike | null {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) {
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
    ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
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
  return new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(components);
}

function toDiscordComponent(component: ReplyComponent): ButtonBuilder | StringSelectMenuBuilder {
  const data = component.data;
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
