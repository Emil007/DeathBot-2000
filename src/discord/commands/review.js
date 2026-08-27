const db = require("../../db");
const { sendNextReview } = require("../celeb-review");

module.exports = {
  name: "review",
  admin: true,
  description: "Resume wiki/age review queue",
  async run(ctx, args, msg) {
    const n = db.countPendingReviews();
    if (!n) {
      await msg.reply("Review queue is empty.");
      return;
    }
    await msg.reply(`${n} pending. Next card:`);
    await sendNextReview(ctx, msg.channel);
  },
};
