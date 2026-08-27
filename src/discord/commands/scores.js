const db = require("../../db");

const cmd = {
  name: "scores",
  aliases: ["score", "scoreboard"],
  admin: false,
  group: "everyone",
  description: "Aktuelle Deathpool-Rangliste mit Punkten",
  usage: "/scores\n{prefix}scores",
  examples: ["/scores", "{prefix}scores"],
  parseSlash() {
    return [];
  },
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
    await msg.reply({
      content: `📊 **Deathpool Scores**\n${lines.join("\n")}`.slice(0, 1900),
      allowedMentions: { parse: [] },
    });
  },
};

module.exports = cmd;
