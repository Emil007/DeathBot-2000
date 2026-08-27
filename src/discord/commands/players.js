const db = require("../../db");

const cmd = {
  name: "players",
  admin: false,
  group: "everyone",
  description: "Listet alle Spieler mit Punktestand",
  usage: "/players\n{prefix}players",
  examples: ["/players", "{prefix}players"],
  details: "Für `/liste user:@…` oder `/liste name:…`.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const rows = db.getDb().prepare("SELECT * FROM players ORDER BY display_name COLLATE NOCASE").all();
    if (!rows.length) {
      await msg.reply("Keine Spieler.");
      return;
    }
    const lines = rows.map(
      (p) => `• **${p.display_name}** <@${p.discord_user_id}> — ${db.playerTotal(p.id)} Punkte`
    );
    await msg.reply({
      content: lines.join("\n").slice(0, 1900),
      allowedMentions: { parse: [] },
    });
  },
};

module.exports = cmd;
