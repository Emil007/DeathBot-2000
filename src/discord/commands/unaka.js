const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "unaka",
  admin: true,
  group: "match",
  description: "AKA-Alias von einem Celeb entfernen",
  usage: "/unaka name:<Name> alias:<Alias>\n{prefix}unaka <Name> <Alias…>",
  examples: [
    "/unaka name:Ozzy Osbourne alias:John Osbourne",
    "{prefix}unaka Ozzy Osbourne John Osbourne",
  ],
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
    {
      name: "alias",
      description: "Zu entfernender Alias",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    const alias = interaction.options.getString("alias") || "";
    return [name, ...alias.split(/\s+/).filter(Boolean)].filter(Boolean);
  },
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
    await msg.reply(usageReply(cmd, ctx.config));
  },
};

module.exports = cmd;
