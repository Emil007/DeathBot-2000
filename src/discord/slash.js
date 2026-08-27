const {
  SlashCommandBuilder,
  ApplicationCommandOptionType,
  InteractionContextType,
  ApplicationIntegrationType,
} = require("discord.js");
const { uniqueCommands } = require("./usage");

const TYPE_MAP = {
  STRING: ApplicationCommandOptionType.String,
  INTEGER: ApplicationCommandOptionType.Integer,
  USER: ApplicationCommandOptionType.User,
  BOOLEAN: ApplicationCommandOptionType.Boolean,
  ATTACHMENT: ApplicationCommandOptionType.Attachment,
};

function addOption(builder, opt) {
  const type = TYPE_MAP[String(opt.type || "STRING").toUpperCase()];
  const required = Boolean(opt.required);
  const desc = truncate(opt.description || opt.name, 100);
  const name = opt.name;

  if (type === ApplicationCommandOptionType.String) {
    builder.addStringOption((o) => {
      o.setName(name).setDescription(desc).setRequired(required);
      if (opt.choices?.length) {
        o.addChoices(...opt.choices.map((c) => ({ name: c.name, value: c.value })));
      }
      return o;
    });
  } else if (type === ApplicationCommandOptionType.Integer) {
    builder.addIntegerOption((o) => o.setName(name).setDescription(desc).setRequired(required));
  } else if (type === ApplicationCommandOptionType.User) {
    builder.addUserOption((o) => o.setName(name).setDescription(desc).setRequired(required));
  } else if (type === ApplicationCommandOptionType.Boolean) {
    builder.addBooleanOption((o) => o.setName(name).setDescription(desc).setRequired(required));
  } else if (type === ApplicationCommandOptionType.Attachment) {
    builder.addAttachmentOption((o) => o.setName(name).setDescription(desc).setRequired(required));
  }
}

function truncate(s, n) {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function buildSlashCommand(cmd) {
  const builder = new SlashCommandBuilder()
    .setName(cmd.name)
    .setDescription(truncate(cmd.description || cmd.name, 100))
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    )
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    );

  // Admin visibility: enforced at runtime via ADMIN_ID (ephemeral deny).
  // Do not use Discord role permissions — bot admin may lack ManageGuild.

  if (cmd.subcommands?.length) {
    for (const sub of cmd.subcommands) {
      builder.addSubcommand((sc) => {
        sc.setName(sub.name).setDescription(truncate(sub.description || sub.name, 100));
        for (const opt of sub.options || []) addOption(sc, opt);
        return sc;
      });
    }
  } else {
    for (const opt of cmd.options || []) addOption(builder, opt);
  }

  return builder;
}

function buildSlashPayload(commands) {
  return uniqueCommands(commands)
    .filter((c) => c.slash !== false)
    .map((c) => buildSlashCommand(c).toJSON());
}

async function registerSlashCommands(client, config, commands) {
  const body = buildSlashPayload(commands);
  const app = client.application;
  if (!app) throw new Error("client.application missing — register after ready");

  // Global: DMs + any guild (propagation can take time).
  await app.commands.set(body);
  console.log(`[slash] Registered ${body.length} global commands (incl. DM contexts)`);

  if (config.discordGuildId) {
    const guild = await client.guilds.fetch(config.discordGuildId).catch(() => null);
    if (!guild) {
      console.warn(`[slash] DISCORD_GUILD_ID=${config.discordGuildId} not found / bot not in guild`);
    } else {
      await guild.commands.set(body);
      console.log(`[slash] Registered ${body.length} guild commands on ${guild.name} (instant)`);
    }
  } else {
    console.log("[slash] No DISCORD_GUILD_ID — guild picker updates may lag until global propagates");
  }
}

module.exports = { buildSlashCommand, buildSlashPayload, registerSlashCommands };
