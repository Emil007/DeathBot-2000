const db = require("../../db");

function resolvePlayer(msg, token) {
  const mention = msg.mentions.users.first();
  if (mention) return db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(mention.id);
  if (!token) return null;
  return (
    db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(token) ||
    db
      .getDb()
      .prepare("SELECT * FROM players WHERE display_name LIKE ? COLLATE NOCASE")
      .get(token)
  );
}

module.exports = {
  name: "add-points",
  admin: true,
  description: "Punkte addieren: !add-points @User 10",
  async run(ctx, args, msg) {
    const points = parseInt(args[args.length - 1], 10);
    if (Number.isNaN(points)) {
      await msg.reply("Usage: `!add-points @User <punkte>`");
      return;
    }
    const player = resolvePlayer(msg, args[0]);
    if (!player) {
      await msg.reply("Spieler nicht gefunden.");
      return;
    }
    db.addPoints(player.id, points);
    await msg.reply(
      `Punkte für **${player.display_name}**: jetzt **${db.playerTotal(player.id)}**`
    );
  },
};
