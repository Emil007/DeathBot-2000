const db = require("../../db");

module.exports = {
  name: "exclude",
  admin: true,
  description: "Exclude celeb from auto wiki matching",
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) return msg.reply("Usage: `!exclude Name`");
    const found = db.findCelebByName(q);
    if (found.length !== 1) return msg.reply(found.length ? "Ambiguous." : "Not found.");
    db.setExcludeFromAuto(found[0].id, true);
    await msg.reply(`**${found[0].name}** excluded from auto wiki matching. Use \`!include\` to reverse.`);
  },
};
