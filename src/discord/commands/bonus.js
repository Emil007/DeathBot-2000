const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "bonus",
  admin: true,
  group: "points",
  description: "Boni listen, definieren, vergeben oder entziehen",
  usage:
    "/bonus list|define|award|revoke …\n{prefix}bonus list|define|award|revoke …",
  examples: [
    "/bonus list",
    "/bonus define id:early name:Early Bird points:10",
    "{prefix}bonus award early-bird @User",
  ],
  subcommands: [
    {
      name: "list",
      description: "Alle definierten Boni auflisten",
    },
    {
      name: "define",
      description: "Bonus definieren oder aktualisieren",
      options: [
        {
          name: "id",
          description: "Kurze ID (z.B. early-bird)",
          type: "STRING",
          required: true,
        },
        {
          name: "name",
          description: "Anzeigename",
          type: "STRING",
          required: true,
        },
        {
          name: "points",
          description: "Punktwert",
          type: "INTEGER",
          required: true,
        },
      ],
    },
    {
      name: "award",
      description: "Bonus an Spieler vergeben",
      options: [
        {
          name: "bonus_id",
          description: "Bonus-ID",
          type: "STRING",
          required: true,
        },
        {
          name: "user",
          description: "Spieler",
          type: "USER",
          required: true,
        },
      ],
    },
    {
      name: "revoke",
      description: "Bonus von Spieler entfernen",
      options: [
        {
          name: "bonus_id",
          description: "Bonus-ID",
          type: "STRING",
          required: true,
        },
        {
          name: "user",
          description: "Spieler",
          type: "USER",
          required: true,
        },
      ],
    },
  ],
  parseSlash(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "list") return ["list"];
    if (sub === "define") {
      const id = interaction.options.getString("id");
      const name = interaction.options.getString("name");
      const points = interaction.options.getInteger("points");
      return ["define", id, ...String(name || "").split(/\s+/).filter(Boolean), "|", String(points)];
    }
    if (sub === "award" || sub === "revoke") {
      const bonusId = interaction.options.getString("bonus_id");
      return [sub, bonusId].filter(Boolean);
    }
    return [sub];
  },
  async run(ctx, args, msg) {
    const sub = (args[0] || "list").toLowerCase();

    if (sub === "list") {
      const rows = db.listBonuses();
      if (!rows.length) {
        return msg.reply(
          `Keine Boni definiert. \`/bonus define\` oder \`${ctx.config.prefix}bonus define id Name | points\``
        );
      }
      await msg.reply(
        rows.map((b) => `• \`${b.id}\` **${b.name}** (${b.points}) ${b.description || ""}`).join("\n")
      );
      return;
    }

    if (sub === "define") {
      const rest = args.slice(1).join(" ");
      const [left, pointsStr] = rest.split("|").map((s) => s.trim());
      const points = parseInt(pointsStr, 10);
      const parts = left.split(/\s+/);
      const id = parts.shift();
      const name = parts.join(" ");
      if (!id || !name || Number.isNaN(points)) {
        return msg.reply(usageReply(cmd, ctx.config));
      }
      db.upsertBonus({ id, name, description: null, points });
      await msg.reply(`Bonus \`${id}\` = **${name}** (${points} pts)`);
      return;
    }

    if (sub === "award" || sub === "revoke") {
      const mention = msg.mentions.users.first();
      const bonusId = args[1];
      if (!mention || !bonusId) {
        return msg.reply(usageReply(cmd, ctx.config));
      }
      const player = db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(mention.id);
      if (!player) return msg.reply("Spieler nicht gefunden (zuerst importieren).");
      if (sub === "award") {
        const b = db.awardBonus(player.id, bonusId);
        await msg.reply(
          `**${b.name}** (${b.points}) an **${player.display_name}** vergeben. Total jetzt **${db.playerTotal(player.id)}**.`
        );
      } else {
        const b = db.revokeBonus(player.id, bonusId);
        if (!b) return msg.reply("Spieler hat diesen Bonus nicht.");
        await msg.reply(
          `Einen **${b.name}** von **${player.display_name}** entfernt. Total jetzt **${db.playerTotal(player.id)}**.`
        );
      }
      return;
    }

    await msg.reply(usageReply(cmd, ctx.config));
  },
};

module.exports = cmd;
