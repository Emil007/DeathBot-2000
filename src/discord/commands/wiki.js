const db = require("../../db");
const { lookupUrl } = require("../../wiki/page-lookup");

module.exports = {
  name: "wiki",
  admin: true,
  description: "!wiki <celeb> <url|none> — set wiki link or manual-only",
  async run(ctx, args, msg) {
    if (args.length < 2) {
      await msg.reply("Usage: `!wiki Name https://en.wikipedia.org/wiki/…` or `!wiki Name none`");
      return;
    }
    const last = args[args.length - 1];
    const name = args.slice(0, -1).join(" ");
    const found = db.findCelebByName(name);
    if (found.length !== 1) {
      await msg.reply(found.length ? "Ambiguous name." : "Not found.");
      return;
    }
    const celeb = found[0];

    if (/^none$/i.test(last)) {
      db.applyWikiConfirm(celeb.id, {
        age: celeb.age_at_pick ?? celeb.sheet_age_hint,
        manualOnly: true,
      });
      await msg.reply(`**${celeb.name}** set to manual-only (no auto wiki match).`);
      return;
    }

    const season = db.getActiveSeason();
    try {
      const proposal = await lookupUrl(
        ctx.config.userAgent,
        last,
        season.start_date,
        celeb.sheet_age_hint
      );
      const confirmed = db.applyWikiConfirm(celeb.id, {
        wikiUrl: proposal.wikiUrl,
        wikiNorm: proposal.wikiNorm,
        age: proposal.proposedAge ?? celeb.age_at_pick,
        manualOnly: false,
      });
      await msg.reply(
        `Wiki set for **${confirmed.name}**: ${confirmed.wiki_url}\nAge at season start: **${confirmed.age_at_pick ?? "?"}** (auto-match on).`
      );
    } catch (e) {
      await msg.reply(`Failed: ${e.message}`);
    }
  },
};
