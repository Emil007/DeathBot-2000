const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");

const cmd = {
  name: "go",
  aliases: ["start-run", "live"],
  admin: true,
  group: "season",
  description: "Stiller Abgleich, dann Saison live schalten",
  usage: "/go\n{prefix}go",
  examples: ["/go", "{prefix}go"],
  details:
    "Führt zuerst silent reconcile aus (kein Channel-Spam für Historie), seedet All-Deaths-Cache, setzt live=ja.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const season = db.getActiveSeason();
    if (season.live) {
      await msg.reply("Bereits live.");
      return;
    }
    if (!season.start_date) {
      await msg.reply(
        "Kein Startdatum. Setze mit `/season` bzw. `/new-year confirm:true …`."
      );
      return;
    }

    await msg.reply(
      `Stiller Abgleich (ganzes Wiki-Jahr) für Start **${season.start_date}** — keine Channel-Ankündigungen…`
    );

    const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
    const summary = formatReconcileSummary(hits, db.getActiveSeason());
    try {
      await msg.author.send(summary);
    } catch {
      await msg.reply(summary.slice(0, 1900));
    }

    await msg.reply("All-Deaths-Cache wird geseedet (Ankündigungen erst ab jetzt)…");
    await runWikiPoll(ctx.client, ctx.config, { mode: "seed" });
    db.setSeasonLive(true);

    await msg.reply(
      [
        "▶️ **Live**",
        `• Saisonstart: **${season.start_date}**`,
        `• Nachgetragene Todesfälle (still): **${hits.length}** (siehe DM)`,
        "• Deathpool-Ankündigungen: an (Gewinner-Pings)",
        "• All-Deaths: nur neue Einträge ab jetzt",
        `• False Positives: Retract wenn innerhalb **${ctx.config.deathConfirmDays}** Tagen von Wiki-Listen weg (kein Auto-Unkill solange gelistet)`,
      ].join("\n")
    );
  },
};

module.exports = cmd;
