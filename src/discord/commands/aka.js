const db = require("../../db");
const { resolveCelebArgs } = require("../resolve-celeb");
const { usageReply } = require("../usage");

const cmd = {
  name: "aka",
  admin: true,
  group: "match",
  description: "AKA-Alias hinzufügen oder auflisten",
  usage: "/aka add|list …\n{prefix}aka <Name> <Alias…> | {prefix}aka list <Name>",
  examples: [
    "/aka add name:Ozzy Osbourne alias:John Osbourne",
    "/aka list name:Ozzy",
    "{prefix}aka Ozzy Osbourne John Osbourne",
  ],
  subcommands: [
    {
      name: "add",
      description: "Alias hinzufügen",
      options: [
        {
          name: "name",
          description: "Celeb-Name",
          type: "STRING",
          required: true,
        },
        {
          name: "alias",
          description: "AKA-Text",
          type: "STRING",
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "AKAs eines Celebs anzeigen",
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
    const alias = interaction.options.getString("alias") || "";
    return [name, ...alias.split(/\s+/).filter(Boolean)].filter(Boolean);
  },
  async run(ctx, args, msg) {
    if (!args.length) {
      await msg.reply(usageReply(cmd, ctx.config));
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
      return { error: usageReply(cmd, ctx.config) };
    })();
    if (error) return msg.reply(error);
    const alias = rest.join(" ").trim();
    if (!alias) return msg.reply("Missing alias.");
    db.addAka(celeb.id, alias);
    await msg.reply(`AKA **${alias}** added for **${celeb.name}**.`);
  },
};

module.exports = cmd;
