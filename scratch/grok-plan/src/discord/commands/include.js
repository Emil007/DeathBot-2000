const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "include",
  admin: true,
  group: "match",
  description: "Celeb wieder in Auto-Wiki-Matching aufnehmen",
  usage: "/include name:<Name>\n{prefix}include <Name>",
  examples: ["/include name:Foo Bar", "{prefix}include Foo Bar"],
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
    const c = found[0];
    if (!c.wiki_confirmed) {
      return msg.reply(
        `**${c.name}** ist noch nicht wiki-bestätigt. Zuerst \`/review\` oder \`/wiki\` — Include umgeht das nicht.`
      );
    }
    if (c.manual_only) {
      return msg.reply(
        `**${c.name}** ist manual-only. Auto-Match geht nur nach \`/wiki\` mit echter URL (nicht none).`
      );
    }
    db.setExcludeFromAuto(c.id, false);
    await msg.reply(`**${c.name}** wieder im Auto-Wiki-Matching.`);
  },
};

module.exports = cmd;
