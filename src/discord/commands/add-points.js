const db = require("../../db");
const { usageReply } = require("../usage");

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

const cmd = {
  name: "add-points",
  admin: true,
  group: "points",
  description: "Punkte zu einem Spieler addieren (auch negativ)",
  usage: "/add-points user:@Spieler points:<n>\n{prefix}add-points @User <punkte>",
  examples: [
    "/add-points user:@Spieler points:10",
    "{prefix}add-points @User 10",
  ],
  options: [
    {
      name: "points",
      description: "Punkte (positiv oder negativ)",
      type: "INTEGER",
      required: true,
    },
    {
      name: "user",
      description: "Spieler",
      type: "USER",
      required: false,
    },
    {
      name: "user_id",
      description: "Discord-Snowflake (Fallback in DMs)",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const points = interaction.options.getInteger("points");
    const user = interaction.options.getUser("user");
    const id = interaction.options.getString("user_id");
    if (user) return [String(points)];
    if (id) return [id, String(points)];
    return points != null ? [String(points)] : [];
  },
  async run(ctx, args, msg) {
    const points = parseInt(args[args.length - 1], 10);
    if (Number.isNaN(points)) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    let mention = msg.mentions.users.first();
    if (!mention && args[0] && /^\d{16,20}$/.test(args[0])) {
      mention = await ctx.client.users.fetch(args[0]).catch(() => null);
    }
    const player = mention
      ? db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(mention.id)
      : resolvePlayer(msg, args[0]);
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

module.exports = cmd;
