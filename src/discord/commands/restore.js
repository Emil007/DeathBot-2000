const { listRestoreCandidates, restorePackage } = require("../../backup");

module.exports = {
  name: "restore",
  admin: true,
  description: "Stellt ein Backup-Package wieder her",
  async run(ctx, args, msg) {
    if (!args.length) {
      const list = listRestoreCandidates(ctx.config);
      const names = list.map((f) => `• \`${f.name}\``).join("\n") || "_nichts in data/restore/_";
      await msg.reply(
        [
          "Usage:",
          "`!restore <dateiname.zip>` — zeigt Infos",
          "`!restore confirm <dateiname.zip>` — stellt wieder her",
          "",
          "Lege ZIPs in `data/restore/` (oder nutze Dateien aus `data/backups/`).",
          "",
          "**restore/** Inhalt:",
          names,
        ].join("\n")
      );
      return;
    }

    if (args[0] === "confirm") {
      const file = args.slice(1).join(" ");
      if (!file) {
        await msg.reply("Usage: `!restore confirm dateiname.zip`");
        return;
      }
      try {
        const result = restorePackage(ctx.config, file);
        await msg.reply(
          `✅ Wiederhergestellt aus \`${result.restored}\`\nSicherheits-Backup vorher: \`${result.safety}\``
        );
      } catch (e) {
        await msg.reply(`Restore fehlgeschlagen: ${e.message}`);
      }
      return;
    }

    const file = args.join(" ");
    await msg.reply(
      `Package: \`${file}\`\nZum Einspielen: \`!restore confirm ${file}\`\n(Erstellt vorher automatisch ein Safety-Backup.)`
    );
  },
};
