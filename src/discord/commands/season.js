const db = require("../../db");

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

module.exports = {
  name: "season",
  admin: true,
  description: "Saison-Status / Startdatum setzen: !season 2026-01-01",
  async run(ctx, args, msg) {
    if (!args.length) {
      const s = db.getActiveSeason();
      await msg.reply(
        [
          `**Saison** id ${s.id} / Jahr ${s.year}`,
          `Start: **${s.start_date || "—"}**`,
          `Live: **${s.live ? "ja" : "nein (Setup)"}**`,
          "",
          "Startdatum setzen: `!season 2026-01-01`",
        ].join("\n")
      );
      return;
    }
    const d = parseDate(args[0]);
    if (!d) {
      await msg.reply("Usage: `!season YYYY-MM-DD`");
      return;
    }
    const s = db.setSeasonStartDate(d);
    await msg.reply(`Startdatum gesetzt: **${s.start_date}** (Alter in Listen = Stand dieses Tags). Live=${s.live ? "ja" : "nein"}`);
  },
};
