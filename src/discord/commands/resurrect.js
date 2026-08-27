const db = require("../../db");

module.exports = {
  name: "resurrect",
  admin: true,
  description: "Belebt einen Celeb wieder",
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
    db.getDb()
      .prepare("UPDATE celebs SET is_alive = 1, died_at = NULL WHERE id = ?")
      .run(found[0].id);
    await msg.reply(`${found[0].name} lebt wieder (zumindest in meiner DB).`);
  },
};
