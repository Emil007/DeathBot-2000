const { createPackage } = require("../../backup");
const db = require("../../db");

module.exports = {
  name: "new-year",
  admin: true,
  description: "Sichert die Saison als Package und startet neu",
  async run(ctx, args, msg) {
    if (args[0] !== "confirm") {
      await msg.reply(
        "Das archiviert die aktuelle Saison und setzt Punkte/Picks zurück.\nZur Bestätigung: `!new-year confirm`"
      );
      return;
    }

    const pkg = createPackage(ctx.config, { reason: "new-year" });
    const year = new Date().getFullYear();
    const { oldSeason, newSeasonId } = db.clearSeasonForNewYear(year);

    db.getDb().exec(`
      DELETE FROM picks;
      DELETE FROM celeb_aka;
      DELETE FROM celeb_blacklist;
      DELETE FROM celebs;
      DELETE FROM player_bonuses;
    `);

    await msg.reply(
      [
        "🆕 **Neues Jahr gestartet**",
        `• Backup-Package: \`${pkg.name}\` (unter \`data/backups/\`)`,
        `• Alte Saison: ${oldSeason.year} (id ${oldSeason.id})`,
        `• Neue Saison id: ${newSeasonId} (${year})`,
        "• Punkte genullt, Celebs/Picks geleert",
        "Als Nächstes: `!import @User` für jede Liste.",
      ].join("\n")
    );
  },
};
