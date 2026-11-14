const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "set-points",
  admin: true,
  group: "points",
  description: "Punkte eines Spielers absolut setzen",
  usage: "/set-points user:@Spieler points:<n>\n{prefix}set-points @User <punkte>",
  examples: [
    "/set-points user:@Spieler points:100",
    "{prefix}set-points @User 100",
  ],
  options: [
    {
      name: "points",
      description: "Neuer Punktestand",
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
      : null;
    if (!player) {
      await msg.reply("Spieler nicht gefunden (@User bzw. user_id nötig).");
      return;
    }
    db.setPoints(player.id, points);
    await msg.reply(
      `Punkte für **${player.display_name}** auf **${db.playerTotal(player.id)}** gesetzt.`
    );
  },
};

module.exports = cmd;
