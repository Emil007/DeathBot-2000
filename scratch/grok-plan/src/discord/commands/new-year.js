const { createPackage } = require("../../backup");
const db = require("../../db");

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

const cmd = {
  name: "new-year",
  admin: true,
  group: "season",
  description: "Archiviert die Saison und startet einen neuen Pool (Setup)",
  usage: "/new-year confirm:true [start_date:YYYY-MM-DD]\n{prefix}new-year confirm [YYYY-MM-DD]",
  examples: [
    "/new-year confirm:true",
    "/new-year confirm:true start_date:2026-01-01",
    "{prefix}new-year confirm 2026-01-01",
  ],
  details:
    "Löscht Celebs/Picks der aktiven Saison nach Backup. Danach: /import → /review → /go.",
  options: [
    {
      name: "confirm",
      description: "Muss true sein, um wirklich zu starten",
      type: "BOOLEAN",
      required: true,
    },
    {
      name: "start_date",
      description: "Saisonstart YYYY-MM-DD (Standard: 1. Jan dieses Jahres)",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const confirm = interaction.options.getBoolean("confirm");
    if (!confirm) return [];
    const start = interaction.options.getString("start_date");
    return ["confirm", start].filter(Boolean);
  },
  async run(ctx, args, msg) {
    if (args[0] !== "confirm") {
      await msg.reply(
        [
          "Archiviert die Saison und startet einen neuen Pool im **Setup-Modus** (noch nicht live).",
          "",
          "`/new-year confirm:true` bzw. `{prefix}new-year confirm` — Start = 1. Januar dieses Jahres".replace(
            "{prefix}",
            ctx.config.prefix
          ),
          "`/new-year confirm:true start_date:2026-01-01` — explizites Startdatum",
          "",
          "Danach: `/import` → `/check` → `/go` (Prefix geht auch)",
        ].join("\n")
      );
      return;
    }

    const dateArg = args[1];
    const year = dateArg ? parseInt(dateArg.slice(0, 4), 10) : new Date().getFullYear();
    const startDate = dateArg ? parseDate(dateArg) : `${year}-01-01`;
    if (dateArg && !startDate) {
      await msg.reply("Datum muss `YYYY-MM-DD` sein.");
      return;
    }

    const pkg = createPackage(ctx.config, { reason: "new-year" });
    const { oldSeason, newSeasonId } = db.clearSeasonForNewYear(year, startDate);

    db.getDb().exec(`
      DELETE FROM death_awards;
      DELETE FROM picks;
      DELETE FROM celeb_aka;
      DELETE FROM celeb_blacklist;
      DELETE FROM celebs;
      DELETE FROM player_bonuses;
    `);

    await msg.reply(
      [
        "🆕 **Neuer Pool (Setup)**",
        `• Backup: \`${pkg.name}\``,
        `• Alte Saison: ${oldSeason.year}`,
        `• Neue Saison id ${newSeasonId}, Start **${startDate}**, live=**nein**`,
        "",
        "1. `/import` bzw. `{prefix}import @User` (Name + Alter zum Startdatum; Punkte-Spalte wird ignoriert)".replace(
          "{prefix}",
          ctx.config.prefix
        ),
        "2. `/check` — stiller Wiki-Abgleich, Zusammenfassung per DM",
        "3. `/go` — Live ab jetzt (All-Deaths nur ab diesem Moment)",
      ].join("\n")
    );
  },
};

module.exports = cmd;
