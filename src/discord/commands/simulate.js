const db = require("../../db");
const { lookupUrl, normalizeWikiUrl } = require("../../wiki/page-lookup");
const { announceSimulatedDeath } = require("../announce");
const { usageReply } = require("../usage");

const cmd = {
  name: "simulate",
  aliases: ["simkill", "fake-kill"],
  admin: true,
  group: "match",
  description: "Test: Wiki-Link nur ankündigen (kein DB-Schreibzugriff)",
  usage: "/simulate url:<Wikipedia-URL>\n{prefix}simulate <url>",
  examples: [
    "/simulate url:https://en.wikipedia.org/wiki/Ozzy_Osbourne",
    "{prefix}simulate https://de.wikipedia.org/wiki/…",
  ],
  details:
    "Nur Channel-Ankündigung zum Testen von Scraping/Phrases/Embed. Schreibt nichts in die DB und vergibt keine Punkte.",
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

    // Optional hint if this URL matches a pool celeb — still no DB write
    const inPool = Boolean(
      (meta.qid && db.findCelebByWikidataId(meta.qid)) ||
        (meta.wikiNorm && db.findCelebByWikiNorm(meta.wikiNorm))
    );

    await announceSimulatedDeath(ctx.client, ctx.config, {
      name: meta.title || "Unbekannt",
      age: meta.proposedAge,
      url: meta.wikiUrl || urlArg,
      inPool,
      alreadyDead: false,
    });
    await msg.reply(
      `Simulation gesendet: **${meta.title}**` +
        (inPool ? " _(wäre im Pool — DB unverändert)_" : " _(nicht im Pool)_") +
        " · keine Punkte, kein DB-Write."
    );
  },
};

module.exports = cmd;
