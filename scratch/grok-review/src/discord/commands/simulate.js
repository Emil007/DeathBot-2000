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

    const celeb =
      (meta.qid && db.findCelebByWikidataId(meta.qid)) ||
      (meta.wikiNorm && db.findCelebByWikiNorm(meta.wikiNorm)) ||
      null;

    const age = celeb?.age_at_pick ?? meta.proposedAge ?? null;
    const winners = celeb
      ? db.getWinnersForCeleb(celeb.id, season.id).map((p) => ({
          displayName: p.display_name,
          // Plain names only — simulation must not ping
        }))
      : [];

    await announceSimulatedDeath(ctx.client, ctx.config, {
      name: celeb?.name || meta.title || "Unbekannt",
      age,
      url: meta.wikiUrl || urlArg,
      urlDe: meta.wikiUrlDe || null,
      inPool: Boolean(celeb),
      alreadyDead: celeb ? !celeb.is_alive : false,
      winners,
    });
    await msg.reply(
      `Simulation gesendet: **${celeb?.name || meta.title}**` +
        (celeb ? " _(wäre im Pool — DB unverändert, keine Pings)_" : " _(nicht im Pool)_") +
        " · kein DB-Write."
    );
  },
};

module.exports = cmd;
