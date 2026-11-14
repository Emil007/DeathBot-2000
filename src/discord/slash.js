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
  CHANNEL: ApplicationCommandOptionType.Channel,
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
  } else if (type === ApplicationCommandOptionType.Channel) {
    builder.addChannelOption((o) => o.setName(name).setDescription(desc).setRequired(required));
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
    // Nur die eine Guild. Kein Bot-DM, kein Privatkanal, kein User-Install.
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

  // Sichtbarkeit im Picker: Discord kann nicht nach User-ID filtern.
  // Admin ist zur Laufzeit config.adminId oder (in der Guild) config.adminRoleId.

  if (cmd.subcommands?.length) {
    for (const sub of cmd.subcommands) {
      builder.addSubcommand((sc) => {
        sc.setName(sub.name).setDescription(truncate(sub.description || sub.name, 100));
        for (const opt of sub.options || []) addOption(sc, opt);
        return sc;
      });
    }
  } else {
    const opts = [...(cmd.options || [])].sort((a, b) => {
      // Discord: required options must come before optional ones
      return Number(Boolean(b.required)) - Number(Boolean(a.required));
    });
    for (const opt of opts) addOption(builder, opt);
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

function isDiscordUnavailable(err, guild) {
  if (guild && guild.available === false) return true;
  const status = Number(err?.status ?? err?.httpStatus ?? err?.response?.status);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const code = err?.code;
  if (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("timeout") || msg.includes("timed out") || msg.includes("rate limit");
}

async function registerSlashCommands(client, config, commands) {
  const body = buildSlashPayload(commands);
  const hash = payloadHash(body);
  const app = client.application;
  if (!app) throw new Error("client.application missing — register after ready");

  const db = require("../db");
  const database = db.getDb();
  const metaGet = (key) => database.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value;
  const metaSet = (key, value) =>
    database
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);

  // Globale Commands einmal leeren. Den Body nie global registrieren.
  if (!metaGet("slash_global_cleared")) {
    await app.commands.set([]);
    metaSet("slash_global_cleared", "1");
    console.log("[slash] Cleared global commands");
  }

  if (!config.discordGuildId) {
    console.warn("[slash] No DISCORD_GUILD_ID — guild commands not registered");
    return;
  }

  let guild;
  try {
    guild = await client.guilds.fetch(config.discordGuildId);
  } catch (e) {
    if (isDiscordUnavailable(e)) {
      console.warn(
        `[slash] DISCORD_GUILD_ID=${config.discordGuildId} unavailable — guild commands not changed`
      );
    } else {
      console.warn(`[slash] DISCORD_GUILD_ID=${config.discordGuildId} not found / bot not in guild`);
    }
    return;
  }
  if (!guild || guild.available === false) {
    console.warn(
      `[slash] DISCORD_GUILD_ID=${config.discordGuildId} unavailable — guild commands not changed`
    );
    return;
  }

  // Immer die Guild-Commands setzen (nicht nur bei Hash-Wechsel).
  await guild.commands.set(body);
  metaSet("slash_commands_hash_guild", hash);
  console.log(`[slash] Updated ${body.length} guild commands on ${guild.name || config.discordGuildId}`);
}

module.exports = { buildSlashCommand, buildSlashPayload, registerSlashCommands };
