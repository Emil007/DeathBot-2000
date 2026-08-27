const db = require("../../db");

async function sendChunks(msg, chunks) {
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) await msg.reply({ content: chunks[i], allowedMentions: { parse: [] } });
    else await msg.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
  }
}

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
      await msg.reply("Noch keine Celebs. Admin: `/import`.");
      return;
    }

    const dead = rows.filter((c) => !c.is_alive).length;
    const alive = rows.length - dead;
    const lines = rows.map((c) => {
      const flag = c.is_alive ? "🟢" : "💀";
      const age = c.age_at_pick != null ? ` · ${c.age_at_pick}` : "";
      const picks = c.pick_count ? ` · ${c.pick_count}×` : " · 0×";
      const wiki = c.wiki_confirmed ? (c.manual_only ? " · manual" : "") : " · ⏳";
      return `${flag} **${c.name}**${age}${picks}${wiki}`;
    });

    const header = `**Alle Celebs** — ${rows.length} (${alive} lebend · ${dead} tot)\n`;
    const chunks = [];
    let body = header;
    for (const line of lines) {
      if ((body + line + "\n").length > 1800) {
        chunks.push(body);
        body = "";
      }
      body += line + "\n";
    }
    if (body) chunks.push(body);
    await sendChunks(msg, chunks);
  },
};

module.exports = cmd;
