const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");
const { loadConfig } = require("./config");
const db = require("./db");
const { loadCommands } = require("./discord/commands");
const importCmd = require("./discord/commands/import");
const { startWikiPoller } = require("./jobs/wiki-poll");
const { startDailySummary } = require("./jobs/daily-summary");
const { startAutoBackup } = require("./backup");

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

  client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    startWikiPoller(client, config);
    startDailySummary(client, config);
    startAutoBackup(config);
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    try {
      if (await importCmd.tryConsumePaste(ctx, msg)) return;
    } catch (e) {
      console.error("[import paste]", e);
    }

    if (!msg.content.startsWith(config.prefix)) return;
    const parts = msg.content.slice(config.prefix.length).trim().split(/\s+/);
    const name = (parts.shift() || "").toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) return;

    if (cmd.admin && msg.author.id !== config.adminId) {
      await msg.reply("Nope. Admin only.");
      return;
    }

    try {
      await cmd.run(ctx, parts, msg);
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
