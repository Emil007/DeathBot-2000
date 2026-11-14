const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "exclude",
  admin: true,
  group: "match",
  description: "Celeb vom automatischen Wiki-Matching ausschließen",
  usage: "/exclude name:<Name>\n{prefix}exclude <Name>",
  examples: ["/exclude name:Foo Bar", "{prefix}exclude Foo Bar"],
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    return name ? name.split(/\s+/) : [];
  },
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) return msg.reply(usageReply(cmd, ctx.config));
    const found = db.findCelebByName(q);
    if (found.length !== 1) return msg.reply(found.length ? "Ambiguous." : "Not found.");
    db.setExcludeFromAuto(found[0].id, true);
    await msg.reply(
      `**${found[0].name}** excluded from auto wiki matching. Use \`/include\` to reverse.`
    );
  },
};

module.exports = cmd;
