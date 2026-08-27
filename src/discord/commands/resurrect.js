const db = require("../../db");

module.exports = {
  name: "resurrect",
  admin: true,
  description: "Belebt einen Celeb wieder (Punkte-Rückbuchung wie Retract)",
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) {
      await msg.reply("Usage: `!resurrect Name`");
      return;
    }
    const found = db.findCelebByName(q);
    if (found.length !== 1) {
      await msg.reply(found.length ? "Mehrdeutig — genauer bitte." : "Nicht gefunden.");
      return;
    }
    const celeb = found[0];
    if (celeb.is_alive) {
      await msg.reply("Lebt bereits.");
      return;
    }
    const result = db.retractDeath(celeb.id);
    await msg.reply(
      `${result.celeb.name} lebt wieder. ${result.awards.length} Punkte-Buchungen rückgängig.`
    );
  },
};
