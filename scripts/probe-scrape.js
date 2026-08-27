const { scrapeEn } = require("../src/wiki/scraper-en");
const { scrapeDe } = require("../src/wiki/scraper-de");
const axios = require("axios");
const cheerio = require("cheerio");

const ua =
  "DeathBot-2000/1.0 (test; +https://github.com/Emil007/DeathBot-2000)";

(async () => {
  const url = "https://en.wikipedia.org/wiki/Deaths_in_August_2026";
  const response = await axios.get(url, { headers: { "User-Agent": ua }, timeout: 30000 });
  const $ = cheerio.load(response.data);
  let total = 0;
  let kept = 0;
  let noHref = 0;
  let colon = 0;
  let parentFiltered = 0;
  $(".mw-parser-output ul li").each((_, el) => {
    total++;
    const $el = $(el);
    if ($el.parents("#toc, .mw-headline, .navbox").length > 0) {
      parentFiltered++;
      return;
    }
    const href = $el.find("a").first().attr("href");
    if (!href || !href.startsWith("/wiki/")) {
      noHref++;
      return;
    }
    if (href.includes(":")) {
      colon++;
      return;
    }
    kept++;
  });
  console.log({ total, kept, noHref, colon, parentFiltered });

  const en = await scrapeEn(ua, { scope: "full" });
  const de = await scrapeDe(ua, { scope: "full" });
  console.log("scrapeEn full", en.length, en.slice(0, 2));
  console.log("scrapeDe full", de.entries.length, de.entries.slice(0, 2));

  // DE table rows?
  const deUrl = "https://de.wikipedia.org/wiki/Nekrolog_August_2026";
  const dr = await axios.get(deUrl, { headers: { "User-Agent": ua }, timeout: 30000 });
  const $d = cheerio.load(dr.data);
  console.log("DE table rows", $d(".mw-parser-output table.wikitable tr").length);
  console.log("DE sample row", $d(".mw-parser-output table.wikitable tr").eq(1).text().slice(0, 120));
})();
