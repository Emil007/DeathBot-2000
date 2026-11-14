const db = require("../../db");
const { sendChunks, chunkLines, sanitizeDisplayName, acceptedWikiUrl } = require("./liste");

const cmd = {
  name: "celebs",
  aliases: ["celebliste", "allcelebs", "celeb-list"],
  admin: false,
  group: "everyone",
  description: "Alle Celebs der Saison (tot/lebendig, wie oft gepickt)",
  usage: "/celebs\n{prefix}celebs",
  examples: ["/celebs", "{prefix}celebliste"],
  details: "Übersicht über die gesamte Celeb-DB. Einzelnachfrage: `/celeb name:…`.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const rows = db.listAllCelebs();
    if (!rows.length) {
      await sendChunks(msg, ["Noch keine Celebs. Admin: `/import`."]);
      return;
    }

    const dead = rows.filter((c) => !c.is_alive).length;
    const alive = rows.length - dead;
    const lines = rows.map((c) => {
      const flag = c.is_alive ? "🟢" : "💀";
      const age = c.age_at_pick != null ? ` · ${c.age_at_pick}` : "";
      const picks = c.pick_count ? ` · ${c.pick_count}×` : " · 0×";
      const wiki = c.wiki_confirmed ? (c.manual_only ? " · manual" : "") : " · ⏳";
      const url = acceptedWikiUrl(c.wiki_url);
      return `${flag} **${sanitizeDisplayName(c.name)}**${age}${picks}${wiki}${url ? ` ${url}` : ""}`;
    });

    const header = `**Alle Celebs** — ${rows.length} (${alive} lebend · ${dead} tot)\n`;
    await sendChunks(msg, chunkLines(header, lines));
  },
};

module.exports = cmd;
