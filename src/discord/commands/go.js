const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");
const { resolveAdminTarget } = require("../admin-notify");
const { logError } = require("../log");

function mentionOpts() {
  try {
    return require("../safe-text").mentionOpts();
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes("safe-text")) throw e;
    return { allowedMentions: { parse: [] } };
  }
}

const cmd = {
  name: "go",
  aliases: ["start-run", "live"],
  admin: true,
  group: "season",
  description: "Stiller Abgleich, dann Saison live schalten",
  usage: "/go [force:true]\n{prefix}go [force]",
  examples: ["/go", "/go force:true", "{prefix}go"],
  details:
    "Blockiert wenn Wiki-Review noch offen. force=true überschreibt mit Warnung. Danach stiller Abgleich, sofort live, dann Seed.",
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
      await msg.reply("Kein Startdatum. Setzen mit `/season start_date:YYYY-MM-DD`.");
      return;
    }

    const force = args.some((a) => String(a).toLowerCase() === "force");
    // Nur die aktive Saison (+ legacy NULL) blockieren; eine 2027er-Queue darf 2026 nicht aufhalten.
    const pendingReviews = db.countPendingReviews({ blockingLive: true });
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

    let hits = [];
    try {
      const polled = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
      hits = polled?.hits || [];
    } catch (e) {
      await logError(ctx.client, ctx.config, e, { where: "go reconcile", userId: ctx.config.adminId });
      await msg.reply(`Abgleich fehlgeschlagen: ${e.message}`);
      return;
    }

    db.setSeasonLive(true);

    const followUp = async (fn) => {
      try {
        await fn();
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "go follow-up", userId: ctx.config.adminId });
      }
    };

    await followUp(async () => {
      const summary = formatReconcileSummary(hits, db.getActiveSeason());
      const adminTarget = await resolveAdminTarget(ctx, {
        preferDmUser: msg.author,
        fallbackChannel: msg.channel,
      });
      const content = summary.slice(0, 1900);
      try {
        if (adminTarget?.send) await adminTarget.send({ content, ...mentionOpts() });
        else await msg.reply({ content, ...mentionOpts() });
      } catch {
        await msg.reply({ content, ...mentionOpts() });
      }
    });

    await followUp(() => msg.reply("All-Deaths-Cache wird geseedet (Ankündigungen erst ab jetzt)…"));
    await followUp(() => runWikiPoll(ctx.client, ctx.config, { mode: "seed" }));
    await followUp(() =>
      msg.reply(
        [
          "▶️ **Live.** Ab jetzt gibt es Pings, wenn jemand richtig liegt.",
          `• Saisonstart: **${season.start_date}**`,
          `• Nachgetragene Todesfälle (still): **${hits.length}** (siehe Admin-Kanal/DM)`,
          "• Deathpool-Ankündigungen: an (Gewinner-Pings)",
          "• All-Deaths: nur neue Einträge ab jetzt",
          `Fehlalarm: Rücknahme, wenn der Eintrag innerhalb von **${ctx.config.deathConfirmDays}** Tagen von den Wiki-Listen verschwindet`,
        ].join("\n")
      )
    );
  },
};

module.exports = cmd;
