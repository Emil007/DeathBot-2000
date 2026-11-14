const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "resurrect",
  admin: true,
  group: "match",
  description: "Belebt einen Celeb wieder (Punkte-Rückbuchung wie Retract)",
  usage: "/resurrect name:<Name>\n{prefix}resurrect <Name>",
  examples: ["/resurrect name:Ozzy Osbourne", "{prefix}resurrect Ozzy Osbourne"],
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
    if (!q) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const found = db.findCelebByName(q);
    if (found.length !== 1) {
      await msg.reply(found.length ? "Mehrdeutig — genauer bitte." : "Nicht gefunden.");
      return;
    }
    const celeb = found[0];
    if (celeb.is_alive) {
      await msg.reply("Lebt bereits.");
      return;
    }
    const result = db.retractDeath(celeb.id);
    await msg.reply(
      `${result.celeb.name} lebt wieder. ${result.awards.length} Punkte-Buchungen rückgängig.`
    );
  },
};

module.exports = cmd;
