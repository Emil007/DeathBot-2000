const db = require("../../db");

module.exports = {
  name: "set-points",
  admin: true,
  description: "Punkte setzen: !set-points @User 100",
  async run(ctx, args, msg) {
    const points = parseInt(args[args.length - 1], 10);
    if (Number.isNaN(points)) {
      await msg.reply("Usage: `!set-points @User <punkte>`");
      return;
    }
    const mention = msg.mentions.users.first();
    const player = mention
      ? db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(mention.id)
      : null;
    if (!player) {
      await msg.reply("Spieler nicht gefunden (@User nötig).");
      return;
    }
    db.setPoints(player.id, points);
    await msg.reply(
      `Punkte für **${player.display_name}** auf **${db.playerTotal(player.id)}** gesetzt.`
    );
  },
};
