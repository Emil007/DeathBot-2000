const db = require("../../db");

module.exports = {
  name: "unblacklist",
  admin: true,
  description: "!unblacklist <celeb> <term…>",
  async run(ctx, args, msg) {
    for (let len = args.length - 1; len >= 1; len--) {
      const name = args.slice(0, len).join(" ");
      const found = db.findCelebByName(name);
      if (found.length === 1) {
        const term = args.slice(len).join(" ").trim();
        db.removeBlacklist(found[0].id, term);
        await msg.reply(`Removed blacklist **${term}** from **${found[0].name}**.`);
        return;
      }
    }
    await msg.reply("Usage: `!unblacklist Celebrity Name term`");
  },
};
