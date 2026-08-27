const db = require("../../db");
const { sendNextReview } = require("../celeb-review");

const cmd = {
  name: "review",
  admin: true,
  group: "season",
  description: "Setzt die Wiki-/Alter-Review-Warteschlange fort",
  usage: "/review\n{prefix}review",
  examples: ["/review", "{prefix}review"],
  details: "Nach /import erscheinen Karten mit Buttons; /review zeigt die nächste.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const n = db.countPendingReviews();
    if (!n) {
      await msg.reply("Review-Warteschlange ist leer.");
      return;
    }
    await msg.reply(`${n} offen. Nächste Karte:`);
    await sendNextReview(ctx, msg.channel);
  },
};

module.exports = cmd;
