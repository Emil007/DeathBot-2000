const db = require("../../db");

module.exports = {
  name: "scores",
  aliases: ["score", "scoreboard"],
  description: "Aktuelle Rangliste",
  async run(ctx, args, msg) {
    const rows = db.listScores();
    if (!rows.length) {
      await msg.reply("Noch keine Spieler mit Picks.");
      return;
    }
    const lines = rows.map(
      (p, i) =>
        `**${i + 1}.** <@${p.discord_user_id}> — **${p.total}** Punkte (${p.pickCount} Picks)`
    );
    await msg.channel.send({
      content: `📊 **Deathpool Scores**\n${lines.join("\n")}`.slice(0, 1900),
      allowedMentions: { parse: [] },
    });
  },
};
