const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "unlink",
  admin: true,
  group: "season",
  description: "Löscht die Picks eines Spielers für die aktive Saison",
  usage: "/unlink user:@Spieler\n{prefix}unlink @User",
  examples: ["/unlink user:@Spieler", "{prefix}unlink @User"],
  details: "Spieler-Zeile bleibt; nur aktive Saison-Picks werden geleert.",
  options: [
    {
      name: "user",
      description: "Discord-User",
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
    const user = interaction.options.getUser("user");
    if (user) return [];
    const id = interaction.options.getString("user_id");
    return id ? [id] : [];
  },
  async run(ctx, args, msg) {
    let mention = msg.mentions.users.first();
    if (!mention && args[0] && /^\d{16,20}$/.test(args[0])) {
      mention = await ctx.client.users.fetch(args[0]).catch(() => null);
    }
    if (!mention) return msg.reply(usageReply(cmd, ctx.config));
    const player = db.unlinkPlayer(mention.id);
    if (!player) return msg.reply("Spieler nicht gefunden.");
    await msg.reply(
      `Aktive-Saison-Picks für **${player.display_name}** geleert. Spieler-Zeile bleibt.`
    );
  },
};

module.exports = cmd;
