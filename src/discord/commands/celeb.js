const db = require("../../db");

module.exports = {
  name: "celeb",
  description: "Suche einen Celeb in der DB",
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) {
      await msg.reply("Usage: `!celeb Name`");
      return;
    }
    const found = db.findCelebByName(q);
    if (!found.length) {
      await msg.reply("Nichts gefunden.");
      return;
    }
    const lines = found.map((c) => {
      const season = db.getActiveSeason();
      const winners = db.getWinnersForCeleb(c.id, season.id);
      return [
        `${c.is_alive ? "🟢" : "💀"} **${c.name}** (id ${c.id})`,
        c.age_at_pick != null ? `Alter: ${c.age_at_pick}` : null,
        c.description ? `Notiz: ${c.description}` : null,
        c.died_at ? `Gestorben: ${c.died_at}` : null,
        c.wiki_url ? c.wiki_url : null,
        winners.length
          ? `Gepickt von: ${winners.map((w) => w.display_name).join(", ")}`
          : "Von niemandem gepickt",
      ]
        .filter(Boolean)
        .join("\n");
    });
    await msg.reply(lines.join("\n\n").slice(0, 1900));
  },
};
