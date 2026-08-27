const db = require("../../db");

module.exports = {
  name: "include",
  admin: true,
  description: "Re-include celeb in auto wiki matching",
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) return msg.reply("Usage: `!include Name`");
    const found = db.findCelebByName(q);
    if (found.length !== 1) return msg.reply(found.length ? "Ambiguous." : "Not found.");
    db.setExcludeFromAuto(found[0].id, false);
    await msg.reply(`**${found[0].name}** included in auto wiki matching again.`);
  },
};
