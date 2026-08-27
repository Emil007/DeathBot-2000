const db = require("../../db");

module.exports = {
  name: "bonus",
  admin: true,
  description: "Bonuses: list | define | award | revoke",
  async run(ctx, args, msg) {
    const sub = (args[0] || "list").toLowerCase();

    if (sub === "list") {
      const rows = db.listBonuses();
      if (!rows.length) return msg.reply("No bonuses defined. `!bonus define id Name | points`");
      await msg.reply(
        rows.map((b) => `• \`${b.id}\` **${b.name}** (${b.points}) ${b.description || ""}`).join("\n")
      );
      return;
    }

    if (sub === "define") {
      // !bonus define early-bird Early Bird | 10
      const rest = args.slice(1).join(" ");
      const [left, pointsStr] = rest.split("|").map((s) => s.trim());
      const points = parseInt(pointsStr, 10);
      const parts = left.split(/\s+/);
      const id = parts.shift();
      const name = parts.join(" ");
      if (!id || !name || Number.isNaN(points)) {
        return msg.reply("Usage: `!bonus define <id> <Name…> | <points>`");
      }
      db.upsertBonus({ id, name, description: null, points });
      await msg.reply(`Bonus \`${id}\` = **${name}** (${points} pts)`);
      return;
    }

    if (sub === "award" || sub === "revoke") {
      const mention = msg.mentions.users.first();
      const bonusId = args[1];
      if (!mention || !bonusId) {
        return msg.reply(`Usage: \`!bonus ${sub} <bonusId> @User\``);
      }
      const player = db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(mention.id);
      if (!player) return msg.reply("Player not found (import them first).");
      if (sub === "award") {
        const b = db.awardBonus(player.id, bonusId);
        await msg.reply(
          `Awarded **${b.name}** (${b.points}) to **${player.display_name}**. Total now **${db.playerTotal(player.id)}**.`
        );
      } else {
        const b = db.revokeBonus(player.id, bonusId);
        if (!b) return msg.reply("Player does not have that bonus.");
        await msg.reply(
          `Revoked one **${b.name}** from **${player.display_name}**. Total now **${db.playerTotal(player.id)}**.`
        );
      }
      return;
    }

    await msg.reply("Usage: `!bonus list|define|award|revoke`");
  },
};
