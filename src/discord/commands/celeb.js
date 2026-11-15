const { usageReply } = require("../usage");
const db = require("../../db");
const { sendChunks, chunkLines, sanitizeDisplayName, hideLinkPreview } = require("./liste");

function oneLine(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const cmd = {
  name: "celeb",
  admin: false,
  group: "everyone",
  description: "Sucht einen Celeb in der Datenbank (Status, Wiki, Picks)",
  usage: "/celeb name:<Name>\n{prefix}celeb <Name>",
  examples: ["/celeb name:Ozzy Osbourne", "{prefix}celeb Ozzy"],
  options: [
    {
      name: "name",
      description: "Name oder Teil des Namens",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    return name ? name.split(/\s+/) : [];
  },
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) {
      await sendChunks(msg, [usageReply(cmd, ctx.config)]);
      return;
    }
    const found = db.findCelebByName(q);
    if (!found.length) {
      await sendChunks(msg, ["Nichts gefunden."]);
      return;
    }
    const season = db.getActiveSeason();
    const blocks = found.map((c) => {
      const winners = season ? db.getWinnersForCeleb(c.id, season.id) : [];
      const url = hideLinkPreview(c.wiki_url);
      const akas = db.getAkas(c.id).map((a) => sanitizeDisplayName(a)).filter(Boolean);
      const blocked = db.getBlacklist(c.id).map((a) => sanitizeDisplayName(a)).filter(Boolean);
      const note = c.description ? oneLine(c.description) : "";
      return [
        `${c.is_alive ? "🟢" : "💀"} **${sanitizeDisplayName(c.name)}** (id ${c.id})` +
          (c.exclude_from_auto ? " · excluded" : ""),
        c.age_at_pick != null ? `Age (season start): ${c.age_at_pick}` : null,
        note ? `Note: ${note}` : null,
        c.died_at ? `Died: ${oneLine(c.died_at)}` : null,
        url,
        akas.length ? `AKA: ${akas.join(", ")}` : null,
        blocked.length ? `Blacklist: ${blocked.join(", ")}` : null,
        winners.length
          ? `Picked by: ${winners.map((w) => sanitizeDisplayName(w.display_name)).join(", ")}`
          : "Picked by nobody",
      ]
        .filter(Boolean)
        .join("\n");
    });
    const lines = [];
    for (let i = 0; i < blocks.length; i++) {
      if (i) lines.push("");
      lines.push(blocks[i]);
    }
    await sendChunks(msg, chunkLines("", lines));
  },
};

module.exports = cmd;
