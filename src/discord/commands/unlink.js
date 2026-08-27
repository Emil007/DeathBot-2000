const db = require("../../db");

module.exports = {
  name: "unlink",
  admin: true,
  description: "Remove a player's picks for the active season",
  async run(ctx, args, msg) {
    const mention = msg.mentions.users.first();
    if (!mention) return msg.reply("Usage: `!unlink @User`");
    const player = db.unlinkPlayer(mention.id);
    if (!player) return msg.reply("Player not found.");
    await msg.reply(`Cleared active-season picks for **${player.display_name}**. Player row kept.`);
  },
};
