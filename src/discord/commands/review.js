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
  options: [
    {
      name: "scope",
      description: "next (2027-Anmeldung) oder pool (laufender Pool)",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const s = interaction.options.getString("scope");
    return s ? [`scope:${s}`] : [];
  },
  async run(ctx, args, msg) {
    // F18: pool NICHT durch Number schicken — NaN fragt nach season_id NaN ab
    // und findet nie etwas. explizit pool => laufender Pool (seasonId undefined),
    // sonst die 2027-Anmeldungs-Queue.
    const wantPool = args.some(
      (a) => a === "pool" || String(a).toLowerCase().startsWith("scope:pool")
    );
    const announced = db.getAnnouncedSeason();
    const effSeasonId = wantPool ? undefined : announced?.id ?? undefined;
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
      const { sendNextReview } = require("../celeb-review");
      await sendNextReview(ctx, target || msg.channel, { season: announced, seasonId: effSeasonId });
    } else {
      await sendNextReview(ctx, target || msg.channel);
    }
  },
};

module.exports = cmd;
