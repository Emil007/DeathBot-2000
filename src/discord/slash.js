const crypto = require("crypto");
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

  // Admin visibility: runtime ADMIN_ID check. Discord cannot hide by user id.
  // Optional ADMIN_ROLE_ID is documented only (no reliable role→picker mapping without
  // tying to a Discord permission bit the role already has).

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

function payloadHash(body) {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

async function registerSlashCommands(client, config, commands) {
  const body = buildSlashPayload(commands);
  const hash = payloadHash(body);
  const app = client.application;
  if (!app) throw new Error("client.application missing — register after ready");

  const db = require("../db");
  const prev = db
    .getDb()
    .prepare(`SELECT value FROM meta WHERE key = 'slash_commands_hash'`)
    .get()?.value;

  if (prev !== hash) {
    await app.commands.set(body);
    db.getDb()
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('slash_commands_hash', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(hash);
    console.log(`[slash] Updated ${body.length} global commands (hash changed)`);
  } else {
    console.log(`[slash] Global commands unchanged (hash ${hash.slice(0, 8)}…)`);
  }

  if (config.discordGuildId) {
    const guild = await client.guilds.fetch(config.discordGuildId).catch(() => null);
    if (!guild) {
      console.warn(`[slash] DISCORD_GUILD_ID=${config.discordGuildId} not found / bot not in guild`);
    } else {
      const gPrev = db
        .getDb()
        .prepare(`SELECT value FROM meta WHERE key = 'slash_guild_hash'`)
        .get()?.value;
      const gKey = `${config.discordGuildId}:${hash}`;
      if (gPrev !== gKey) {
        await guild.commands.set(body);
        db.getDb()
          .prepare(
            `INSERT INTO meta (key, value) VALUES ('slash_guild_hash', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          )
          .run(gKey);
        console.log(`[slash] Updated ${body.length} guild commands on ${guild.name}`);
      } else {
        console.log(`[slash] Guild commands unchanged on ${guild.name}`);
      }
    }
  } else {
    console.log("[slash] No DISCORD_GUILD_ID — guild picker updates may lag until global propagates");
  }
}

module.exports = { buildSlashCommand, buildSlashPayload, registerSlashCommands };
