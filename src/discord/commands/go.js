const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");

module.exports = {
  name: "go",
  aliases: ["start-run", "live"],
  admin: true,
  description: "Beendet Setup und startet Live-Ankündigungen",
  async run(ctx, args, msg) {
    const season = db.getActiveSeason();
    if (season.live) {
      await msg.reply("Läuft bereits live.");
      return;
    }
    if (!season.start_date) {
      await msg.reply("Kein Startdatum. Setze mit `!season 2026-01-01` oder `!new-year confirm …`.");
      return;
    }

    await msg.reply("Seed All-Deaths-Cache (nur Tode ab jetzt) und schalte Live…");
    await runWikiPoll(ctx.client, ctx.config, { mode: "seed" });
    db.setSeasonLive(true);

    await msg.reply(
      [
        "▶️ **Live**",
        `• Saison-Start: **${season.start_date}**`,
        "• Deathpool-Ankündigungen: an (mit Pings)",
        "• All-Deaths: nur neue Einträge ab jetzt",
        `• Falsch-Positive: Rücknahme wenn innerhalb von **${ctx.config.deathConfirmDays}** Tagen nicht mehr auf Wiki-Listen`,
      ].join("\n")
    );
  },
};
