const { usageReply } = require("../usage");
const db = require("../../db");

const cmd = {
  name: "celeb",
  admin: false,
  group: "everyone",
  description: "Sucht einen Celeb in der Datenbank (Status, Wiki, Picks)",
  usage: "/celeb name:<Name>\n{prefix}celeb <Name>",
  examples: ["/celeb name:Ozzy Osbourne", "{prefix}celeb Ozzy"],
  options: [
    {
      name: "name",
      description: "Name oder Teil des Namens",
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
    if (!q) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const found = db.findCelebByName(q);
    if (!found.length) {
      await msg.reply("Nichts gefunden.");
      return;
    }
    const lines = found.map((c) => {
      const season = db.getActiveSeason();
      const winners = db.getWinnersForCeleb(c.id, season.id);
      return [
        `${c.is_alive ? "🟢" : "💀"} **${c.name}** (id ${c.id})` +
          (c.exclude_from_auto ? " · excluded" : ""),
        c.age_at_pick != null ? `Age (season start): ${c.age_at_pick}` : null,
        c.description ? `Note: ${c.description}` : null,
        c.died_at ? `Died: ${c.died_at}` : null,
        c.wiki_url ? c.wiki_url : null,
        db.getAkas(c.id).length
          ? `AKA: ${db.getAkas(c.id).join(", ")}`
          : null,
        db.getBlacklist(c.id).length
          ? `Blacklist: ${db.getBlacklist(c.id).join(", ")}`
          : null,
        winners.length
          ? `Picked by: ${winners.map((w) => w.display_name).join(", ")}`
          : "Picked by nobody",
      ]
        .filter(Boolean)
        .join("\n");
    });
    await msg.reply(lines.join("\n\n").slice(0, 1900));
  },
};

module.exports = cmd;
