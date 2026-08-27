const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "blacklist",
  admin: true,
  group: "match",
  description: "Wiki-Auto-Match blockieren wenn Terme in der Zeile vorkommen",
  usage: "/blacklist add|list …\n{prefix}blacklist <Name> <term…> | {prefix}blacklist list <Name>",
  examples: [
    "/blacklist add name:Foo term:junior",
    "/blacklist list name:Foo",
    "{prefix}blacklist Foo junior",
  ],
  details: "Blockiert Auto-Match, wenn alle Term-Wörter in der Wiki-Zeile vorkommen.",
  subcommands: [
    {
      name: "add",
      description: "Blacklist-Term hinzufügen",
      options: [
        {
          name: "name",
          description: "Celeb-Name",
          type: "STRING",
          required: true,
        },
        {
          name: "term",
          description: "Block-Term(e)",
          type: "STRING",
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "Blacklist eines Celebs anzeigen",
      options: [
        {
          name: "name",
          description: "Celeb-Name",
          type: "STRING",
          required: true,
        },
      ],
    },
  ],
  parseSlash(interaction) {
    const sub = interaction.options.getSubcommand();
    const name = interaction.options.getString("name");
    if (sub === "list") return ["list", name].filter(Boolean);
    const term = interaction.options.getString("term") || "";
    return [name, ...term.split(/\s+/).filter(Boolean)].filter(Boolean);
  },
  async run(ctx, args, msg) {
    if (!args.length) {
      await msg.reply(usageReply(cmd, ctx.config));
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
    await msg.reply(usageReply(cmd, ctx.config));
  },
};

module.exports = cmd;
