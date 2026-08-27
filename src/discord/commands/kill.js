const db = require("../../db");
const { announceDeathpool } = require("../announce");

module.exports = {
  name: "kill",
  admin: true,
  description: "Markiert einen Celeb manuell als tot",
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) {
      await msg.reply("Usage: `!kill Name`");
      return;
    }
    const found = db.findCelebByName(q);
    if (!found.length) {
      await msg.reply("Nicht gefunden.");
      return;
    }
    if (found.length > 1) {
      await msg.reply(
        "Mehrdeutig:\n" + found.map((c) => `• ${c.name} (id ${c.id})`).join("\n")
      );
      return;
    }
    const celeb = found[0];
    if (!celeb.is_alive) {
      await msg.reply("Ist schon tot.");
      return;
    }
    const entry = {
      id: `manual:${celeb.id}`,
      text: `${celeb.name}, ${celeb.age_at_pick ?? "?"}`,
      url: celeb.wiki_url || null,
      lang: "en",
    };
    await announceDeathpool(ctx.client, ctx.config, {
      celeb,
      entry,
      age: celeb.age_at_pick,
    });
    await msg.reply(`Erledigt: ${celeb.name}`);
  },
};
