const {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags,
} = require("discord.js");
const { loadConfig } = require("./config");
const db = require("./db");
const { loadCommands } = require("./discord/commands");
const importCmd = require("./discord/commands/import");
const helpCmd = require("./discord/commands/help");
const { handlePickInteraction, tryConsumePickMessage } = require("./discord/pick-assistant");
const {
  handleReviewInteraction,
  tryConsumeReviewUrl,
} = require("./discord/celeb-review");
const { fromInteraction } = require("./discord/msg-adapter");
const { logEvent, logError } = require("./discord/log");
const { registerSlashCommands } = require("./discord/slash");
const { suggestCommands } = require("./discord/usage");
const { startWikiPoller } = require("./jobs/wiki-poll");
const { startDailySummary } = require("./jobs/daily-summary");
const { startYearRollover, runYearRollover } = require("./jobs/year-rollover");
const { runDeathpoolChannelSetup, handleChannelSetupInteraction } = require("./jobs/channel-setup");
const { startAutoBackup } = require("./backup");
const { startPresence } = require("./discord/presence");

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const USER_ERROR_TEXT = "Das hat nicht geklappt. Der Admin sieht den Grund im Log.";
const GUILD_ONLY_TEXT = "Dieser Bot antwortet nur in seiner einen Guild.";
const ADMIN_ONLY_TEXT = "Nur der Admin darf das.";
const DATA_DM_TEXT = "Datenbefehle nur in der Guild.";

// Nicht-Admin-Befehle, die Punkte oder Listen zeigen. In der DM aus — auch für den Admin.
const DM_DATA_COMMANDS = new Set(["liste", "scores", "players", "celeb", "celebs"]);

// F18d: Präfix-Argumente sollen „note:Zwei Worte“ erhalten können. Der naive
// whitespace-Split lieferte nur „note:Zwei“. Bekannte Schlüssel/Flags markieren
// die Grenze, bis zu der ein note:-Wert Leerzeichen aufnehmen darf.
const NOTE_VALUE_KEYS = new Set(["note", "year", "start", "start_date", "channel", "scope", "max_picks"]);
const NOTE_VALUE_FLAGS = new Set(["repost", "force", "activate", "wipe", "confirm", "pool"]);

function rebuildPrefixArgs(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.startsWith("note:")) {
      out.push(p);
      continue;
    }
    const headline = p.slice("note:".length);
    let j = i + 1;
    const rest = [];
    while (j < parts.length) {
      const t = parts[j];
      const keyMatch = /^([a-z][a-z0-9_]*):/.exec(t);
      if ((keyMatch && NOTE_VALUE_KEYS.has(keyMatch[1])) || NOTE_VALUE_FLAGS.has(t)) break;
      rest.push(t);
      j++;
    }
    out.push(rest.length ? `note:${headline} ${rest.join(" ")}` : p);
    i = j - 1;
  }
  return out;
}

function isMissingModule(err, request) {
  if (!err || err.code !== "MODULE_NOT_FOUND") return false;
  const first = String(err.message || "").split("\n")[0];
  return first.includes(request);
}

function mentionOpts() {
  try {
    return require("./discord/safe-text").mentionOpts();
  } catch (e) {
    if (!isMissingModule(e, "./discord/safe-text")) throw e;
    // ANNAHME: M1-Modul fehlt in diesem Workspace. Vertragswert, bis safe-text.js da ist.
    return { allowedMentions: { parse: [] } };
  }
}

function withMentions(payload) {
  if (typeof payload === "string") return { content: payload, ...mentionOpts() };
  return { ...payload, ...mentionOpts() };
}

function isUnknownInteraction(err) {
  const code = Number(err?.code ?? err?.rawError?.code);
  return code === 10062 || code === 50027;
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

/**
 * Entscheidung ohne Socket.
 * ours: guildId ist config.discordGuildId.
 * dmSpecial: keine Guild und Custom-Id pka: oder crev: — kein Guild-Datenbefehl.
 * guildDataCommand: nur unsere Guild. Der DM-Sonderfall zeigt keine Punkte/Listen.
 */
function guildGateDecision(interaction, config) {
  const guildId = interaction?.guildId ?? null;
  const noGuild = guildId == null || guildId === "";
  const customId = String(interaction?.customId || "");
  const dmSpecial = noGuild && (customId.startsWith("pka:") || customId.startsWith("crev:"));
  // Das Kanal-Setup stellt die Frage als DM an den Admin — der Klick auf
  // "dp:setup:*" in der DM ist unser Pflichtkanal, der darf NICHT vom
  // Guild-Gate verschluckt werden. isSetupAdmin prüft die Berechtigung im
  // Handler selbst; dmSpecial/allowGuildDm passt hier nicht.
  const dmSetup = noGuild && customId.startsWith("dp:setup:");
  const ours = dmSetup || (!noGuild && String(guildId) === String(config?.discordGuildId || ""));
  return {
    ours,
    dm: noGuild,
    dmSpecial: dmSpecial || dmSetup,
    guildDataCommand: ours,
    foreign: !noGuild && !ours,
  };
}

function isOurGuild(interaction, config) {
  return guildGateDecision(interaction, config).ours;
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  const want = String(roleId);
  if (Array.isArray(member._roles) && member._roles.map(String).includes(want)) return true;
  const roles = member.roles;
  if (Array.isArray(roles) && roles.map(String).includes(want)) return true;
  const cache = roles?.cache;
  if (cache && typeof cache.has === "function" && (cache.has(want) || cache.has(roleId))) return true;
  return false;
}

/** In der Guild: adminId oder adminRoleId. In der DM nur adminId. */
function isAdminActor(actor, config) {
  const userId = actor?.user?.id ?? actor?.author?.id ?? null;
  if (userId != null && String(userId) === String(config?.adminId)) return true;
  const guildId = actor?.guildId ?? actor?.guild?.id ?? null;
  if (guildId == null || guildId === "") return false;
  if (!config?.adminRoleId) return false;
  return memberHasRole(actor?.member, config.adminRoleId);
}

function isDmDataCommand(cmd) {
  if (!cmd) return false;
  return DM_DATA_COMMANDS.has(cmd._aliasOf || cmd.name);
}

function isChatInput(interaction) {
  return typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand();
}

function isGuildComponent(interaction) {
  if (typeof interaction.isMessageComponent === "function" && interaction.isMessageComponent()) return true;
  if (typeof interaction.isModalSubmit === "function" && interaction.isModalSubmit()) return true;
  return false;
}

async function allowGuildDm(client, config, userId) {
  if (userId != null && String(userId) === String(config.adminId)) return true;
  if (!config?.discordGuildId || userId == null || userId === "") return false;
  let guild;
  try {
    guild = await client.guilds.fetch(config.discordGuildId);
  } catch (e) {
    console.warn(
      "[guild-gate] guild fetch failed; DM interaction dropped",
      isDiscordUnavailable(e) ? "unavailable" : e?.code || e?.status || "error"
    );
    return false;
  }
  if (!guild || guild.available === false) {
    console.warn("[guild-gate] guild unavailable; DM interaction dropped");
    return false;
  }
  try {
    const member = await guild.members.fetch(String(userId));
    return Boolean(member);
  } catch (e) {
    if (isDiscordUnavailable(e)) {
      console.warn("[guild-gate] member fetch unavailable; DM interaction dropped");
    }
    return false;
  }
}

async function replyGuildOnly(interaction) {
  const payload = withMentions({ content: GUILD_ONLY_TEXT, ...EPHEMERAL });
  if (typeof interaction.isRepliable === "function" && !interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => {});
  } else if (typeof interaction.reply === "function") {
    await interaction.reply(payload).catch(() => {});
  }
}

function shouldNotifyGuildOnly(interaction) {
  if (isChatInput(interaction)) return true;
  const noGuild = interaction?.guildId == null || interaction.guildId === "";
  if (!noGuild && isGuildComponent(interaction)) return true;
  return false;
}

function unknownCommandText(name, config, suggestions) {
  const shown = `${config.prefix || ""}${name}`.replace(/[\u0000-\u001F`]/g, "");
  let text = `Befehl \`${shown}\` gibt es nicht.`;
  if (suggestions.length) {
    text += ` Meintest du: ${suggestions
      .map((s) => `\`${config.prefix}${s}\` / \`/${s}\``)
      .join(", ")}?`;
  }
  text += `\nÜbersicht: \`/help\` oder \`${config.prefix}help\``;
  return text;
}

async function runCommand(ctx, cmd, args, msg) {
  await cmd.run(ctx, args, msg);
}

async function main() {
  const config = loadConfig();
  // M1: TZ setzen, bevor openDb das Saison-Jahr aus der lokalen Zeit ableitet.
  require("./db/time").applyProcessTimezone(config);
  db.openDb(config);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [] },
  });

  const commands = loadCommands();
  const ctx = { client, config, commands };

  client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
      await registerSlashCommands(client, config, commands);
    } catch (e) {
      console.error("[slash] registration failed:", e);
    }
    // Let the gateway settle before the heavy startup seed (avoids missed 3s slash acks)
    setTimeout(() => startWikiPoller(client, config), 1500);
    startDailySummary(client, config);
    startYearRollover(client, config);
    // Interaktives Deathpool-Kanal-Setup (ersetzt CHANNEL_DEATHPOOL):
    // Der Start-Nachhol (runYearRollover) läuft erst, wenn ein Zielkanal sicher
    // ist — das Kanal-Setup feuert onDecided genau einmal, sobald entschieden
    // ist (oder sofort synchron, wenn die aktive Saison schon einen Kanal hat).
    // Die übrige Start-Routine (slash-Registrierung, Poller, Backup) läuft
    // weiter, NUR der Deathpool-Start-Nachhol wartet auf den Kanaldi.
    runDeathpoolChannelSetup(client, config, {
      onDecided: () =>
        runYearRollover(client, config).catch((e) => {
          // F25: Fehler über logError in den Logkanal, nicht nur stdout.
          console.error("[year-rollover] startup catch-up failed", e.message);
          logError(client, config, e, { where: "year-rollover startup catch-up" });
        }),
    });
    startAutoBackup(config, client);
    startPresence(client, config, db);
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      const gate = guildGateDecision(interaction, config);
      if (!gate.ours) {
        if (gate.dmSpecial) {
          // pka:/crev: nur für Mitglieder dieser Guild (oder adminId). Sonst keine Daten.
          const allowed = await allowGuildDm(client, config, interaction.user?.id);
          if (!allowed) return;
        } else {
          if (shouldNotifyGuildOnly(interaction)) await replyGuildOnly(interaction);
          return;
        }
      }

      if (await helpCmd.handleButton?.(ctx, interaction)) return;
      // Interaktives Kanal-Setup VOR dem Pick-Assistenten — Buttons/Select des
      // Deathpool-Kanal-Setups sind keine pka:-Interaktionen.
      if (await handleChannelSetupInteraction(interaction, client, config)) return;
      if (await handlePickInteraction(ctx, interaction)) return;
      if (await handleReviewInteraction(ctx, interaction)) return;

      if (!interaction.isChatInputCommand()) return;

      const cmd = commands.get(interaction.commandName);
      if (!cmd || cmd._aliasOf) {
        await interaction.reply(
          withMentions({
            content: `Befehl \`${interaction.commandName}\` gibt es nicht.`,
            ...EPHEMERAL,
          })
        );
        return;
      }

      if (cmd.admin && !isAdminActor(interaction, config)) {
        await interaction.reply(withMentions({ content: ADMIN_ONLY_TEXT, ...EPHEMERAL }));
        return;
      }

      // Ack within Discord's ~3s window before any wiki/DB work
      // Admin slash in guild channels: ephemeral so sheet/go/restore stay private.
      const ephemeral = Boolean(cmd.admin && interaction.guildId);
      await interaction.deferReply(ephemeral ? EPHEMERAL : {});
      const msg = fromInteraction(interaction);
      const args = typeof cmd.parseSlash === "function" ? cmd.parseSlash(interaction) : [];
      await runCommand(ctx, cmd, args, msg);
    } catch (e) {
      if (isUnknownInteraction(e)) {
        // 10062 Unknown interaction, 50027 Invalid Webhook Token: kein Nutzertext.
        console.warn(
          `[interaction] Discord ack too late (code ${Number(e?.code ?? e?.rawError?.code)}) — no user reply.`
        );
        return;
      }
      console.error("[interaction]", e);
      await logError(client, config, e, {
        where: `interaction ${interaction.commandName || interaction.customId || "?"}`,
        userId: interaction.user?.id,
      });
      const text = USER_ERROR_TEXT;
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(withMentions({ content: text, ...EPHEMERAL })).catch(() => {});
        } else {
          await interaction.reply(withMentions({ content: text, ...EPHEMERAL })).catch(() => {});
        }
      }
    }
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    // Fremde Guild: nichts importieren, nichts reviewen, keine Picks, keine Prefix-Befehle.
    if (msg.guildId && String(msg.guildId) !== String(config.discordGuildId)) return;

    try {
      if (await tryConsumeReviewUrl(ctx, msg)) return;
    } catch (e) {
      console.error("[review url]", e);
      await logError(client, config, e, { where: "tryConsumeReviewUrl", userId: msg.author?.id });
    }

    try {
      if (await importCmd.tryConsumePaste(ctx, msg)) return;
    } catch (e) {
      console.error("[import paste]", e);
      await logError(client, config, e, { where: "tryConsumePaste", userId: msg.author?.id });
    }

    try {
      if (await tryConsumePickMessage(ctx, msg)) return;
    } catch (e) {
      console.error("[pick message]", e);
      await logError(client, config, e, { where: "tryConsumePickMessage", userId: msg.author?.id });
    }

    if (!msg.content.startsWith(config.prefix)) return;
    const parts = rebuildPrefixArgs(msg.content.slice(config.prefix.length).trim().split(/\s+/));
    const name = (parts.shift() || "").toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) {
      const suggestions = suggestCommands(name, commands, { admin: isAdminActor(msg, config) });
      await msg.reply(withMentions(unknownCommandText(name, config, suggestions))).catch(() => {});
      return;
    }

    // ANNAHME: liste/scores/players/celeb/celebs (inkl. Aliase) sind in der DM für alle aus.
    if (!msg.guildId && isDmDataCommand(cmd)) {
      await msg.reply(withMentions(DATA_DM_TEXT)).catch(() => {});
      return;
    }

    if (cmd.admin && !isAdminActor(msg, config)) {
      await msg.reply(withMentions(ADMIN_ONLY_TEXT)).catch(() => {});
      return;
    }

    try {
      await runCommand(ctx, cmd, parts, msg);
    } catch (e) {
      console.error(`[cmd ${name}]`, e);
      await logError(client, config, e, { where: `cmd ${name}`, userId: msg.author?.id });
      await msg.reply(withMentions(USER_ERROR_TEXT)).catch(() => {});
    }
  });

  await client.login(config.token);
}

// F18d: Export für Tests; beim normalen Start wird main() ausgeführt.
module.exports = {
  rebuildPrefixArgs,
  main,
  isOurGuild,
  guildGateDecision,
  isAdminActor,
  isDmDataCommand,
  isUnknownInteraction,
  allowGuildDm,
};

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
