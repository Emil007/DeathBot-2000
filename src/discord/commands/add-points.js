const db = require("../../db");
const { usageReply } = require("../usage");
const { replyText, sanitizeDisplayName, resolveSnowflakePoints, NEED_MENTION } = require("./liste");

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
    db.addPoints(player.id, resolved.points);
    const name = sanitizeDisplayName(player.display_name);
    await replyText(msg, `Punkte für **${name}**: jetzt **${db.playerTotal(player.id)}**`);
  },
};

module.exports = cmd;
