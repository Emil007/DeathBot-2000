const db = require("../../db");
const { usageReply } = require("../usage");

const cmd = {
  name: "invalidate",
  admin: true,
  group: "match",
  description:
    "Pick ungültig: Todes-Punkte rückbuchen (falls tot) + Auto-Match aus. Optional aus allen Listen entfernen.",
  usage:
    "/invalidate name:<Name> [remove_picks:true]\n{prefix}invalidate <Name> [remove_picks]",
  examples: [
    "/invalidate name:Tatjana Patitz",
    "/invalidate name:Kim Jong Un",
    "/invalidate name:Cheat Pick remove_picks:true",
    "{prefix}invalidate Tatjana Patitz",
    "{prefix}invalidate Cheat Pick remove_picks",
  ],
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
    {
      name: "remove_picks",
      description: "Auch aus allen Spieler-Listen dieser Saison entfernen (Cheat etc.)",
      type: "BOOLEAN",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    const remove = interaction.options.getBoolean("remove_picks");
    const parts = name ? name.split(/\s+/) : [];
    if (remove) parts.push("remove_picks");
    return parts;
  },
  async run(ctx, args, msg) {
    const raw = args.join(" ").trim();
    if (!raw) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }

    const removePicks = /\bremove[_-]?picks\b/i.test(raw);
    const q = raw
      .replace(/\bremove[_-]?picks\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!q) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }

    const found = db.findCelebByName(q);
    if (!found.length) {
      await msg.reply("Nicht gefunden.");
      return;
    }
    if (found.length > 1) {
      await msg.reply("Mehrdeutig:\n" + found.map((c) => `• ${c.name} (id ${c.id})`).join("\n"));
      return;
    }

    const result = db.invalidateCeleb(found[0].id, { removePicks });
    const bits = [
      `**${result.celeb.name}** invalidiert.`,
      "Auto-Match: aus.",
    ];
    if (result.retracted) {
      bits.push(`Todes-Punkte rückgebucht: **${result.awardsUndone}**.`);
    } else {
      bits.push("War nicht als tot markiert.");
    }
    if (removePicks) {
      bits.push(`Picks entfernt: **${result.picksRemoved}**.`);
    } else {
      bits.push("Listen unverändert (für Entfernen: `remove_picks:true`).");
    }
    bits.push("Wieder aktiv: `/include` (+ ggf. neu picken).");
    await msg.reply(bits.join(" "));
  },
};

module.exports = cmd;
