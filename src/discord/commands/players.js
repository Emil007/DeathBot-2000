const db = require("../../db");

module.exports = {
  name: "players",
  admin: true,
  description: "Listet alle Spieler",
  async run(ctx, args, msg) {
    const rows = db.getDb().prepare("SELECT * FROM players ORDER BY display_name COLLATE NOCASE").all();
    if (!rows.length) {
      await msg.reply("Keine Spieler.");
      return;
    }
    const lines = rows.map(
      (p) => `• **${p.display_name}** <@${p.discord_user_id}> — ${db.playerTotal(p.id)} Punkte`
    );
    await msg.channel.send({
      content: lines.join("\n").slice(0, 1900),
      allowedMentions: { parse: [] },
    });
  },
};
