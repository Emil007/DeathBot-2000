const db = require("../../db");
const { sendNextReview } = require("../celeb-review");
const { resolveAdminTarget } = require("../admin-notify");

const cmd = {
  name: "review",
  admin: true,
  group: "season",
  description: "Setzt die Wiki-/Alter-Review-Warteschlange fort",
  usage: "/review\n{prefix}review",
  examples: ["/review", "{prefix}review"],
  details:
    "Nach /import erscheinen Karten mit Buttons; /review zeigt die nächste. Mit CHANNEL_ADMIN landen Karten dort.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const n = db.countPendingReviews();
    if (!n) {
      await msg.reply("Review-Warteschlange ist leer.");
      return;
    }
    const target = await resolveAdminTarget(ctx, {
      preferDmUser: null,
      fallbackChannel: msg.channel,
    });
    await msg.reply(
      `${n} offen. Nächste Karte` +
        (ctx.config.channelAdmin && target?.id === ctx.config.channelAdmin
          ? " im Admin-Kanal."
          : ":")
    );
    await sendNextReview(ctx, target || msg.channel);
  },
};

module.exports = cmd;
