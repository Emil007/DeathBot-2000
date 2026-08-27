const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");

module.exports = {
  name: "go",
  aliases: ["start-run", "live"],
  admin: true,
  description: "Silent reconcile, then go live (no Channel A spam for history)",
  async run(ctx, args, msg) {
    const season = db.getActiveSeason();
    if (season.live) {
      await msg.reply("Already live.");
      return;
    }
    if (!season.start_date) {
      await msg.reply("No start date. Set with `!season YYYY-MM-DD` or `!new-year confirm …`.");
      return;
    }

    await msg.reply(
      `Running silent reconcile (full-year wiki) for start **${season.start_date}** — no channel announcements…`
    );

    const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
    const summary = formatReconcileSummary(hits, db.getActiveSeason());
    try {
      await msg.author.send(summary);
    } catch {
      await msg.reply(summary.slice(0, 1900));
    }

    await msg.reply("Seeding all-deaths cache (announce only from now on)…");
    await runWikiPoll(ctx.client, ctx.config, { mode: "seed" });
    db.setSeasonLive(true);

    await msg.reply(
      [
        "▶️ **Live**",
        `• Season start: **${season.start_date}**`,
        `• Catch-up deaths applied silently: **${hits.length}** (see DM summary)`,
        "• Deathpool announcements: on (winner pings)",
        "• All-deaths: only new entries from now",
        `• False positives: retract if off wiki lists within **${ctx.config.deathConfirmDays}** days (not auto-unkill while still listed)`,
      ].join("\n")
    );
  },
};
