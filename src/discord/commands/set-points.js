const db = require("../../db");
const { usageReply } = require("../usage");
const { replyText, sanitizeDisplayName, resolveSnowflakePoints, NEED_MENTION } = require("./liste");

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
    const resolved = resolveSnowflakePoints(msg, args);
    if (resolved.error === "usage") {
      await replyText(msg, usageReply(cmd, ctx.config));
      return;
    }
    if (resolved.error) {
      await replyText(msg, NEED_MENTION);
      return;
    }
    const player = db.findPlayerByQuery(resolved.snowflake);
    if (!player) {
      await replyText(msg, "Spieler nicht gefunden.");
      return;
    }
    db.setPoints(player.id, resolved.points);
    const name = sanitizeDisplayName(player.display_name);
    await replyText(msg, `Punkte für **${name}** auf **${db.playerTotal(player.id)}** gesetzt.`);
  },
};

module.exports = cmd;
