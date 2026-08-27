const db = require("../../db");
const { resolveCelebArgs } = require("../resolve-celeb");

module.exports = {
  name: "aka",
  admin: true,
  description: "!aka <celeb> <alias…> | !aka list <celeb>",
  async run(ctx, args, msg) {
    if (!args.length) {
      await msg.reply("Usage: `!aka Name Alias…` · `!aka list Name` · see also `!unaka`");
      return;
    }
    if (args[0].toLowerCase() === "list") {
      const { celeb, error } = resolveCelebArgs(args.slice(1));
      if (error) return msg.reply(error);
      const list = db.getAkas(celeb.id);
      await msg.reply(
        list.length
          ? `AKA for **${celeb.name}**:\n` + list.map((a) => `• ${a}`).join("\n")
          : `No AKAs for **${celeb.name}**.`
      );
      return;
    }
    // alias is last token(s): find celeb as longest prefix
    const { celeb, rest, error } = (() => {
      for (let len = args.length - 1; len >= 1; len--) {
        const name = args.slice(0, len).join(" ");
        const found = db.findCelebByName(name);
        if (found.length === 1) {
          return { celeb: found[0], rest: args.slice(len) };
        }
        if (found.length > 1) {
          return {
            error: "Ambiguous:\n" + found.map((c) => `• ${c.name}`).join("\n"),
          };
        }
      }
      return { error: "Usage: `!aka Celebrity Name The Alias`" };
    })();
    if (error) return msg.reply(error);
    const alias = rest.join(" ").trim();
    if (!alias) return msg.reply("Missing alias.");
    db.addAka(celeb.id, alias);
    await msg.reply(`AKA **${alias}** added for **${celeb.name}**.`);
  },
};
