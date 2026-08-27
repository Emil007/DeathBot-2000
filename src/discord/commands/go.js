const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");
const { resolveAdminTarget } = require("../admin-notify");

const cmd = {
  name: "go",
  aliases: ["start-run", "live"],
  admin: true,
  group: "season",
  description: "Stiller Abgleich, dann Saison live schalten",
  usage: "/go [force:true]\n{prefix}go [force]",
  examples: ["/go", "/go force:true", "{prefix}go"],
  details:
    "Blockiert wenn Wiki-Review noch offen. force=true überschreibt mit Warnung. Danach silent reconcile → seed → live.",
  options: [
    {
      name: "force",
      description: "Trotz offener Reviews live gehen (nicht empfohlen)",
      type: "BOOLEAN",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const force = interaction.options.getBoolean("force");
    return force ? ["force"] : [];
  },
  async run(ctx, args, msg) {
    const season = db.getActiveSeason();
    if (season.live) {
      await msg.reply("Bereits live.");
      return;
    }
    if (!season.start_date) {
      await msg.reply(
        "Kein Startdatum. Setze mit `/season` bzw. `/new-year confirm:true …`."
      );
      return;
    }

    const force = args.some((a) => String(a).toLowerCase() === "force");
    const pendingReviews = db.countPendingReviews();
    const unconfirmed = db.countUnconfirmedSeasonCelebs();
    if ((pendingReviews > 0 || unconfirmed > 0) && !force) {
      await msg.reply(
        [
          `⛔ **/go** blockiert — Wiki-/Alter-Review unvollständig.`,
          `• Offene Review-Karten: **${pendingReviews}**`,
          `• Unbestätigte Celebs mit Picks: **${unconfirmed}**`,
          `Zuerst \`/review\` (oder \`/wiki\` / \`/age\`).`,
          `Nur mit Absicht: \`/go force:true\` bzw. \`${ctx.config.prefix}go force\` (Punkte für Ungeprüfte fehlen dann still).`,
        ].join("\n")
      );
      return;
    }
    if (force && (pendingReviews > 0 || unconfirmed > 0)) {
      await msg.reply(
        `⚠️ Force-Live trotz **${pendingReviews}** Reviews / **${unconfirmed}** unbestätigt — Auto-Match überspringt die.`
      );
    }

    await msg.reply(
      `Stiller Abgleich (ganzes Wiki-Jahr) für Start **${season.start_date}** — keine Channel-Ankündigungen…`
    );

    const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
    const summary = formatReconcileSummary(hits, db.getActiveSeason());
    const adminTarget = await resolveAdminTarget(ctx, {
      preferDmUser: msg.author,
      fallbackChannel: msg.channel,
    });
    try {
      if (adminTarget?.send) await adminTarget.send(summary);
      else await msg.reply(summary.slice(0, 1900));
    } catch {
      await msg.reply(summary.slice(0, 1900));
    }

    await msg.reply("All-Deaths-Cache wird geseedet (Ankündigungen erst ab jetzt)…");
    await runWikiPoll(ctx.client, ctx.config, { mode: "seed" });
    db.setSeasonLive(true);

    await msg.reply(
      [
        "▶️ **Live**",
        `• Saisonstart: **${season.start_date}**`,
        `• Nachgetragene Todesfälle (still): **${hits.length}** (siehe Admin-Kanal/DM)`,
        "• Deathpool-Ankündigungen: an (Gewinner-Pings)",
        "• All-Deaths: nur neue Einträge ab jetzt",
        `• False Positives: Retract wenn innerhalb **${ctx.config.deathConfirmDays}** Tagen von Wiki-Listen weg`,
      ].join("\n")
    );
  },
};

module.exports = cmd;
