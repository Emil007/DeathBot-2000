const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "unblacklist",
  admin: true,
  group: "match",
  description: "Blacklist-Term von einem Celeb entfernen",
  usage: "/unblacklist name:<Name> term:<Term>\n{prefix}unblacklist <Name> <term…>",
  examples: [
    "/unblacklist name:Foo term:junior",
    "{prefix}unblacklist Foo junior",
  ],
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
    {
      name: "term",
      description: "Zu entfernender Term",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    const term = interaction.options.getString("term") || "";
    return [name, ...term.split(/\s+/).filter(Boolean)].filter(Boolean);
  },
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
    await msg.reply(usageReply(cmd, ctx.config));
  },
};

module.exports = cmd;
