const db = require("../../db");

module.exports = {
  name: "blacklist",
  admin: true,
  description: "!blacklist <celeb> <term…> | !blacklist list <celeb>",
  async run(ctx, args, msg) {
    if (!args.length) {
      await msg.reply(
        "Usage: `!blacklist Name term…` · `!blacklist list Name` · `!unblacklist …`\nBlocks auto-match when all term words appear in the wiki line."
      );
      return;
    }
    if (args[0].toLowerCase() === "list") {
      const name = args.slice(1).join(" ");
      const found = db.findCelebByName(name);
      if (found.length !== 1) return msg.reply(found.length ? "Ambiguous name." : "Not found.");
      const list = db.getBlacklist(found[0].id);
      await msg.reply(
        list.length
          ? `Blacklist for **${found[0].name}**:\n` + list.map((t) => `• ${t}`).join("\n")
          : `No blacklist for **${found[0].name}**.`
      );
      return;
    }
    for (let len = args.length - 1; len >= 1; len--) {
      const name = args.slice(0, len).join(" ");
      const found = db.findCelebByName(name);
      if (found.length === 1) {
        const term = args.slice(len).join(" ").trim();
        db.addBlacklist(found[0].id, term);
        await msg.reply(`Blacklist **${term}** for **${found[0].name}**.`);
        return;
      }
    }
    await msg.reply("Usage: `!blacklist Celebrity Name block term`");
  },
};
