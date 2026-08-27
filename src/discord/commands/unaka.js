const db = require("../../db");

module.exports = {
  name: "unaka",
  admin: true,
  description: "!unaka <celeb> <alias…>",
  async run(ctx, args, msg) {
    for (let len = args.length - 1; len >= 1; len--) {
      const name = args.slice(0, len).join(" ");
      const found = db.findCelebByName(name);
      if (found.length === 1) {
        const alias = args.slice(len).join(" ").trim();
        db.removeAka(found[0].id, alias);
        await msg.reply(`Removed AKA **${alias}** from **${found[0].name}**.`);
        return;
      }
    }
    await msg.reply("Usage: `!unaka Celebrity Name The Alias`");
  },
};
