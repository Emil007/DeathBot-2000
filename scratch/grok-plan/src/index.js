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
const {
  handleReviewInteraction,
  tryConsumeReviewUrl,
} = require("./discord/celeb-review");
const { fromInteraction } = require("./discord/msg-adapter");
const { registerSlashCommands } = require("./discord/slash");
const { suggestCommands } = require("./discord/usage");
const { startWikiPoller } = require("./jobs/wiki-poll");
const { startDailySummary } = require("./jobs/daily-summary");
const { startAutoBackup } = require("./backup");
const { startPresence } = require("./discord/presence");

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

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
    startAutoBackup(config);
    startPresence(client, config, db);
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (await helpCmd.handleButton?.(ctx, interaction)) return;
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
    }

    try {
      if (await importCmd.tryConsumePaste(ctx, msg)) return;
    } catch (e) {
      console.error("[import paste]", e);
    }

    if (!msg.content.startsWith(config.prefix)) return;
    const parts = msg.content.slice(config.prefix.length).trim().split(/\s+/);
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
      await msg.reply(`Fehler: ${e.message}`).catch(() => {});
    }
  });

  await client.login(config.token);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
