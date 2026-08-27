const db = require("../../db");
const { lookupUrl, normalizeWikiUrl } = require("../../wiki/page-lookup");
const { processDeathpoolHit, announceSimulatedDeath } = require("../announce");
const { usageReply } = require("../usage");

const cmd = {
  name: "simulate",
  aliases: ["simkill", "fake-kill"],
  admin: true,
  group: "match",
  description: "Wiki-Link: Person als tot ankündigen (Test / manueller Hit)",
  usage: "/simulate url:<Wikipedia-URL>\n{prefix}simulate <url>",
  examples: [
    "/simulate url:https://en.wikipedia.org/wiki/Ozzy_Osbourne",
    "{prefix}simulate https://de.wikipedia.org/wiki/…",
  ],
  details:
    "Wenn die Person im Pool ist → Punkte + Deathpool-Ankündigung. Sonst nur Ankündigung ohne Punkte (Simulation).",
  options: [
    {
      name: "url",
      description: "EN- oder DE-Wikipedia /wiki/ URL",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const url = interaction.options.getString("url");
    return url ? [url] : [];
  },
  async run(ctx, args, msg) {
    const urlArg = args.find((a) => /wikipedia\.org\/wiki\//i.test(a)) || args[0];
    if (!urlArg || !normalizeWikiUrl(urlArg)) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }

    const season = db.getActiveSeason();
    let meta;
    try {
      meta = await lookupUrl(ctx.config.userAgent, urlArg, season.start_date, null);
    } catch (e) {
      await msg.reply(`Lookup fehlgeschlagen: ${e.message}`);
      return;
    }

    let celeb =
      (meta.qid && db.findCelebByWikidataId(meta.qid)) ||
      (meta.wikiNorm && db.findCelebByWikiNorm(meta.wikiNorm)) ||
      null;

    // Also try DE/EN alternate norms from URL itself
    if (!celeb) {
      const n = normalizeWikiUrl(urlArg);
      if (n) celeb = db.findCelebByWikiNorm(n.norm);
    }

    const entry = {
      id: `sim:${meta.wikiNorm || urlArg}`,
      text: `${meta.title || "Unknown"}, ${meta.proposedAge ?? "?"}`,
      url: meta.wikiUrl || urlArg,
      wikiPath: meta.wikiNorm ? `/wiki/${meta.wikiNorm.split(":")[1]}` : null,
      lang: meta.lang || "en",
    };

    if (celeb) {
      if (!celeb.is_alive) {
        await msg.reply(`**${celeb.name}** ist schon tot. Sende trotzdem Ankündigung…`);
        await announceSimulatedDeath(ctx.client, ctx.config, {
          name: celeb.name,
          age: celeb.age_at_pick,
          url: entry.url,
          inPool: true,
          alreadyDead: true,
        });
        return;
      }
      const live = db.isLive();
      await processDeathpoolHit(
        ctx.client,
        ctx.config,
        { celeb, entry, wikiAge: meta.proposedAge },
        { announce: true, confirmed: true, source: "simulate" }
      );
      await msg.reply(
        `Simulate → Pool-Hit **${celeb.name}**` +
          (live ? " (angekündigt + Punkte)." : " (angekündigt; Saison noch nicht live).")
      );
      return;
    }

    await announceSimulatedDeath(ctx.client, ctx.config, {
      name: meta.title || "Unbekannt",
      age: meta.proposedAge,
      url: entry.url,
      inPool: false,
    });
    await msg.reply(
      `Simulate → **${meta.title}** ist **nicht** im Pool. Nur Channel-Ankündigung, keine Punkte.`
    );
  },
};

module.exports = cmd;
