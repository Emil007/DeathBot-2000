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
const { startAutoBackup } = require("./backup");
const { startPresence } = require("./discord/presence");

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

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

function isUnknownInteraction(err) {
  return err?.code === 10062 || err?.rawError?.code === 10062;
}

async function runCommand(ctx, cmd, args, msg) {
  await cmd.run(ctx, args, msg);
}

async function main() {
  const config = loadConfig();
  db.openDb(config);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
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
    // F02: Nachholen nach Bot-Ausfall am 01.01. — der Cron läuft nur zur
    // festen Zeit. Beim (Wieder-)Start einmal prüfen: der Wiener Datums-Guard
    // lässt überfällige start_date durch und blockt zukünftige; ein zweiter
    // Lauf nach Erfolg ist durch getAnnouncedSeason()==null abgedeckt.
    runYearRollover(client, config).catch((e) => {
      console.error("[year-rollover] startup catch-up failed", e.message);
    });
    startAutoBackup(config, client);
    startPresence(client, config, db);
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (await helpCmd.handleButton?.(ctx, interaction)) return;
      if (await handlePickInteraction(ctx, interaction)) return;
      if (await handleReviewInteraction(ctx, interaction)) return;

      if (!interaction.isChatInputCommand()) return;

      const cmd = commands.get(interaction.commandName);
      if (!cmd || cmd._aliasOf) {
        await interaction.reply({ content: "Unbekannter Befehl. `/help`", ...EPHEMERAL });
        return;
      }

      if (cmd.admin && interaction.user.id !== config.adminId) {
        await interaction.reply({ content: "Nope. Nur Admin.", ...EPHEMERAL });
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
        console.warn(
          "[interaction] Discord ack too late (Unknown interaction) — usually right after restart or during a heavy wiki scrape. Retry the command."
        );
        return;
      }
      console.error("[interaction]", e);
      await logError(client, config, e, {
        where: `interaction ${interaction.commandName || interaction.customId || "?"}`,
        userId: interaction.user?.id,
      });
      const text = `Fehler: ${e.message}`;
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: text, ...EPHEMERAL }).catch(() => {});
        } else {
          await interaction.reply({ content: text, ...EPHEMERAL }).catch(() => {});
        }
      }
    }
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

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
      const isAdmin = msg.author.id === config.adminId;
      const suggestions = suggestCommands(name, commands, { admin: isAdmin });
      if (suggestions.length) {
        await msg.reply(
          `Unbekannter Befehl \`${config.prefix}${name}\`. Meintest du: ${suggestions
            .map((s) => `\`${config.prefix}${s}\` / \`/${s}\``)
            .join(", ")}?\nÜbersicht: \`/help\` oder \`${config.prefix}help\``
        );
      } else {
        await msg.reply(
          `Unbekannter Befehl. Übersicht: \`/help\` oder \`${config.prefix}help\``
        );
      }
      return;
    }

    if (cmd.admin && msg.author.id !== config.adminId) {
      await msg.reply("Nope. Admin only.");
      return;
    }

    try {
      await runCommand(ctx, cmd, parts, msg);
    } catch (e) {
      console.error(`[cmd ${name}]`, e);
      await logError(client, config, e, { where: `cmd ${name}`, userId: msg.author?.id });
      await msg.reply(`Fehler: ${e.message}`).catch(() => {});
    }
  });

  await client.login(config.token);
}

// F18d: Export für Tests; beim normalen Start wird main() ausgeführt.
module.exports = { rebuildPrefixArgs, main };

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
