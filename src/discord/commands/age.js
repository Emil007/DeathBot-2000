const db = require("../../db");

module.exports = {
  name: "age",
  admin: true,
  description: "!age <celeb> <n> — override age at season start",
  async run(ctx, args, msg) {
    if (args.length < 2) {
      await msg.reply("Usage: `!age Name 78`");
      return;
    }
    const age = parseInt(args[args.length - 1], 10);
    const name = args.slice(0, -1).join(" ");
    if (!Number.isFinite(age)) {
      await msg.reply("Age must be an integer.");
      return;
    }
    const found = db.findCelebByName(name);
    if (found.length !== 1) {
      await msg.reply(found.length ? "Ambiguous." : "Not found.");
      return;
    }
    const result = db.setCelebAge(found[0].id, age);
    if (!result.ok) {
      await msg.reply(
        `Refused: **${found[0].name}** already has ${result.awards} death award(s). Change would not rewrite past points.`
      );
      return;
    }
    await msg.reply(`**${result.celeb.name}** age_at_pick = **${age}** (score per hit = ${db.scoreForAge(age)}).`);
  },
};
