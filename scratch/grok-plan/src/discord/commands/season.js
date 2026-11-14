const db = require("../../db");
const { usageReply } = require("../usage");

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

const cmd = {
  name: "season",
  admin: true,
  group: "season",
  description: "Saison-Status anzeigen oder Startdatum setzen",
  usage: "/season [start_date:YYYY-MM-DD]\n{prefix}season [YYYY-MM-DD]",
  examples: ["/season", "/season start_date:2026-01-01", "{prefix}season 2026-01-01"],
  options: [
    {
      name: "start_date",
      description: "Neues Startdatum YYYY-MM-DD (ohne Option: nur Status)",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const d = interaction.options.getString("start_date");
    return d ? [d] : [];
  },
  async run(ctx, args, msg) {
    if (!args.length) {
      const s = db.getActiveSeason();
      await msg.reply(
        [
          `**Saison** id ${s.id} / Jahr ${s.year}`,
          `Start: **${s.start_date || "—"}**`,
          `Live: **${s.live ? "ja" : "nein (Setup)"}**`,
          "",
          "Startdatum setzen: `/season start_date:2026-01-01` oder `{prefix}season 2026-01-01`".replace(
            "{prefix}",
            ctx.config.prefix
          ),
        ].join("\n")
      );
      return;
    }
    const d = parseDate(args[0]);
    if (!d) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const s = db.setSeasonStartDate(d);
    await msg.reply(
      `Startdatum gesetzt: **${s.start_date}** (Alter in Listen = Stand dieses Tags). Live=${s.live ? "ja" : "nein"}`
    );
  },
};

module.exports = cmd;
