const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "age",
  admin: true,
  group: "season",
  description: "Alter zum Saisonstart überschreiben",
  usage: "/age name:<Name> age:<Zahl>\n{prefix}age <Name> <Zahl>",
  examples: ["/age name:Ozzy Osbourne age:76", "{prefix}age Ozzy 76"],
  details: "Verweigert, wenn bereits Death-Awards existieren (Punkte würden nicht neu berechnet).",
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
    {
      name: "age",
      description: "Alter zum Saisonstart",
      type: "INTEGER",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    const age = interaction.options.getInteger("age");
    if (name == null || age == null) return [];
    return [name, String(age)];
  },
  async run(ctx, args, msg) {
    if (args.length < 2) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const age = parseInt(args[args.length - 1], 10);
    const name = args.slice(0, -1).join(" ");
    if (!Number.isFinite(age)) {
      await msg.reply("Alter muss eine ganze Zahl sein.");
      return;
    }
    const found = db.findCelebByName(name);
    if (found.length !== 1) {
      await msg.reply(found.length ? "Mehrdeutig." : "Nicht gefunden.");
      return;
    }
    const result = db.setCelebAge(found[0].id, age);
    if (!result.ok) {
      await msg.reply(
        `Abgelehnt: **${found[0].name}** hat schon ${result.awards} Death-Award(s). Änderung würde alte Punkte nicht neu schreiben.`
      );
      return;
    }
    await msg.reply(
      `**${result.celeb.name}** age_at_pick = **${age}** (Punkte pro Treffer = ${db.scoreForAge(age)}).`
    );
  },
};

module.exports = cmd;
