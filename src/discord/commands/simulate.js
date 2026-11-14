const db = require("../../db");
const pageLookup = require("../../wiki/page-lookup");
const { normalizeWikiUrl } = pageLookup;
const { announceSimulatedDeath } = require("../announce");
const { usageReply } = require("../usage");
const { mentionOpts, sanitizeDisplayName } = loadSafeText();

function loadSafeText() {
  try {
    const t = require("../safe-text");
    if (typeof t.mentionOpts === "function" && typeof t.sanitizeDisplayName === "function") return t;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return {
    mentionOpts: () => ({ allowedMentions: { parse: [] } }),
    sanitizeDisplayName(raw) {
      let s = raw == null ? "" : String(raw);
      s = s.replace(/\p{Cc}/gu, "").replace(/[\u2028\u2029]/g, "");
      s = s.replace(/[*_~|`<>@()[\]]/g, "");
      s = s.replace(/\s+/gu, " ").trim();
      const chars = Array.from(s);
      if (chars.length > 80) s = chars.slice(0, 80).join("").trim();
      return s || "\u201EUnbenannt\u201C";
    },
  };
}

async function say(msg, content) {
  await msg.reply({ content, ...mentionOpts() });
}

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
      await say(msg, usageReply(cmd, ctx.config));
      return;
    }

    const season = db.getActiveSeason();
    let meta;
    try {
      meta = await pageLookup.lookupUrl(ctx.config.userAgent, urlArg, season.start_date, null);
    } catch (e) {
      await say(msg, `Lookup fehlgeschlagen: ${e.message}`);
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

    const name = sanitizeDisplayName(celeb?.name || meta.title || "Unbekannt");
    await announceSimulatedDeath(ctx.client, ctx.config, {
      name,
      age,
      url: meta.wikiUrl || urlArg,
      urlDe: meta.wikiUrlDe || null,
      inPool: Boolean(celeb),
      alreadyDead: celeb ? !celeb.is_alive : false,
      winners,
    });
    await say(
      msg,
      `Simulation gesendet: **${name}**` +
        (celeb ? " _(wäre im Pool — DB unverändert, keine Pings)_" : " _(nicht im Pool)_") +
        " · kein DB-Write."
    );
  },
};

module.exports = cmd;
