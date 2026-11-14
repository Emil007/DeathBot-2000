const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");

const cmd = {
  name: "ungo",
  aliases: ["pause", "setup"],
  admin: true,
  group: "season",
  description: "Live zurücknehmen und Wiki-Cache still neu seeden",
  usage: "/ungo confirm:true\n{prefix}ungo confirm",
  examples: ["/ungo confirm:true", "{prefix}ungo confirm"],
  details:
    "Setzt live=nein (wie vor /go). Seedet All-Deaths/Wiki-Seen neu — keine Channel-Ankündigungen. Bereits vergebene Todes-Punkte bleiben (dafür /resurrect). Danach wieder /go wenn bereit.",
  options: [
    {
      name: "confirm",
      description: "Muss true sein",
      type: "BOOLEAN",
      required: true,
    },
  ],
  parseSlash(interaction) {
    return interaction.options.getBoolean("confirm") ? ["confirm"] : [];
  },
  async run(ctx, args, msg) {
    if (args[0] !== "confirm") {
      await msg.reply(
        [
          "Nimmt **Live** zurück und seedet den Wiki-Cache **ohne** Ankündigungen.",
          "`/ungo confirm:true` bzw. `{prefix}ungo confirm`".replace(
            "{prefix}",
            ctx.config.prefix
          ),
          "",
          "• live → nein (Setup)",
          "• Deathpool/All-Deaths bleiben still",
          "• Bereits tot markierte Celebs / Punkte bleiben",
          "• Danach: `/go` wenn du wieder live willst",
        ].join("\n")
      );
      return;
    }

    const wasLive = db.isLive();
    if (wasLive) {
      db.setSeasonLive(false);
      await msg.reply("Live aus — zurück im Setup-Modus.");
    } else {
      await msg.reply("War schon nicht live. Seede Wiki-Cache neu…");
    }

    await msg.reply("Stilles Seeding (alles als gesehen markieren, keine Pings)…");
    await runWikiPoll(ctx.client, ctx.config, { mode: "seed" });
    const season = db.getActiveSeason();
    await msg.reply(
      [
        "✅ Cache neu geseedet.",
        `• live=**${season.live ? "ja" : "nein"}**`,
        `• Start: **${season.start_date || "?"}**`,
        "Poller läuft weiter im Seed-Modus bis `/go`.",
      ].join("\n")
    );
  },
};

module.exports = cmd;
