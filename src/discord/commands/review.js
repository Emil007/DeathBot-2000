const db = require("../../db");
const { sendNextReview } = require("../celeb-review");
const { resolveAdminTarget } = require("../admin-notify");

const cmd = {
  name: "review",
  admin: true,
  group: "season",
  description: "Setzt die Wiki-/Alter-Review-Warteschlange fort",
  usage: "/review [scope:pool]\n{prefix}review",
  examples: ["/review", "/review scope:pool", "{prefix}review"],
  details:
    "Zeigt standardmäßig die Anmeldungs-Queue (2027). scope:pool = laufender Pool. Nach /import erscheinen Karten mit Buttons; /review zeigt die nächste. Mit CHANNEL_ADMIN landen Karten dort.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const scope = args.find((a) => String(a).toLowerCase().startsWith("scope:"));
    const seasonId = scope && scope.split(":")[1] ? Number(scope.split(":")[1]) : undefined;
    const announced = db.getAnnouncedSeason();
    // Wenn kein scope übergeben und eine announced-Saison existiert: die Anmeldung-Queue zeigen
    const effSeasonId = seasonId ?? (announced && !args.some((a) => a === "pool" || String(a).startsWith("scope:pool")) ? announced.id : undefined);
    const n = db.countPendingReviews({ seasonId: effSeasonId });
    if (!n) {
      await msg.reply("Review-Warteschlange ist leer.");
      return;
    }
    const target = await resolveAdminTarget(ctx, {
      preferDmUser: null,
      fallbackChannel: msg.channel,
    });
    const label = effSeasonId && announced?.id === effSeasonId ? "2027-Anmeldung" : "laufender Pool";
    await msg.reply(
      `${n} offen (${label}). Nächste Karte` +
        (ctx.config.channelAdmin && target?.id === ctx.config.channelAdmin
          ? " im Admin-Kanal."
          : ":")
    );
    if (effSeasonId && announced?.id === effSeasonId) {
      const { queueCelebsForReview, sendNextReview } = require("../celeb-review");
      await sendNextReview(ctx, target || msg.channel, { season: announced, seasonId: effSeasonId });
    } else {
      await sendNextReview(ctx, target || msg.channel);
    }
  },
};

module.exports = cmd;
