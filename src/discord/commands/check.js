const { runWikiPoll } = require("../../jobs/wiki-poll");

module.exports = {
  name: "check",
  admin: true,
  description: "Sofortiger Wiki-Poll",
  async run(ctx, args, msg) {
    await msg.reply("Starte Wiki-Check…");
    try {
      await runWikiPoll(ctx.client, ctx.config, { seedOnly: false });
      await msg.reply("Wiki-Check fertig.");
    } catch (e) {
      await msg.reply(`Fehler: ${e.message}`);
    }
  },
};
