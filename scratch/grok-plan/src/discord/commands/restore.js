const { listRestoreCandidates, restorePackage } = require("../../backup");
const { usageReply } = require("../usage");

const cmd = {
  name: "restore",
  admin: true,
  group: "season",
  description: "Backup-Package anzeigen oder wiederherstellen",
  usage:
    "/restore list|info|confirm\n{prefix}restore [confirm] <dateiname.zip>",
  examples: [
    "/restore list",
    "/restore info file:backup.zip",
    "{prefix}restore confirm backup.zip",
  ],
  details: "confirm erstellt vorher automatisch ein Safety-Backup.",
  subcommands: [
    {
      name: "list",
      description: "Dateien in data/restore/ auflisten",
    },
    {
      name: "info",
      description: "Infos zu einem Package (noch nicht einspielen)",
      options: [
        {
          name: "file",
          description: "Dateiname.zip",
          type: "STRING",
          required: true,
        },
      ],
    },
    {
      name: "confirm",
      description: "Package wiederherstellen",
      options: [
        {
          name: "file",
          description: "Dateiname.zip",
          type: "STRING",
          required: true,
        },
      ],
    },
  ],
  parseSlash(interaction) {
    const sub = interaction.options.getSubcommand(false);
    if (!sub || sub === "list") return [];
    const file = interaction.options.getString("file");
    if (sub === "confirm") return ["confirm", file].filter(Boolean);
    return file ? [file] : [];
  },
  async run(ctx, args, msg) {
    if (!args.length) {
      const list = listRestoreCandidates(ctx.config);
      const names = list.map((f) => `• \`${f.name}\``).join("\n") || "_nichts in data/restore/_";
      await msg.reply(
        [
          "So geht’s:",
          "`/restore info file:…` bzw. `{prefix}restore <dateiname.zip>` — Infos".replace(
            "{prefix}",
            ctx.config.prefix
          ),
          "`/restore confirm file:…` — stellt wieder her",
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
        await msg.reply(usageReply(cmd, ctx.config));
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
      `Package: \`${file}\`\nZum Einspielen: \`/restore confirm file:${file}\` bzw. \`${ctx.config.prefix}restore confirm ${file}\`\n(Erstellt vorher automatisch ein Safety-Backup.)`
    );
  },
};

module.exports = cmd;
