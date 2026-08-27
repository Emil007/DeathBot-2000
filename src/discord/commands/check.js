const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");

module.exports = {
  name: "check",
  aliases: ["reconcile"],
  admin: true,
  description: "Wiki-Check: Setup=stiller Abgleich, Live=sofortiger Poll",
  async run(ctx, args, msg) {
    const season = db.getActiveSeason();
    if (!season.live) {
      await msg.reply(
        `Setup-Abgleich läuft (Start **${season.start_date || "?"}**) — keine Channel-Ankündigungen…`
      );
      const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
      const summary = formatReconcileSummary(hits, db.getActiveSeason());
      try {
        await msg.author.send(summary);
        await msg.reply(
          `Fertig: **${hits.length}** Todesfälle nachgetragen. Zusammenfassung per DM. Danach \`!scores\` / \`!go\`.`
        );
      } catch {
        await msg.reply(summary);
      }
      return;
    }

    await msg.reply("Live-Wiki-Check…");
    try {
      const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "live" });
      await msg.reply(`Wiki-Check fertig. Neue Pool-Treffer in diesem Lauf: **${hits.length}**.`);
    } catch (e) {
      await msg.reply(`Fehler: ${e.message}`);
    }
  },
};
