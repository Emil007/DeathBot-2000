const axios = require("axios");
const cheerio = require("cheerio");

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function createClient(userAgent) {
  return axios.create({
    timeout: 30000,
    headers: { "User-Agent": userAgent },
  });
}

async function resolveEnglish(client, germanUrl) {
  try {
    const response = await client.get(germanUrl);
    const $ = cheerio.load(response.data);
    return $(".interlanguage-link-en a").attr("href") || null;
  } catch {
    return null;
  }
}

async function scrapeUrl(client, url) {
  try {
    const response = await client.get(url);
    const $ = cheerio.load(response.data);
    const entries = [];
    $(".mw-parser-output ul li").each((_, el) => {
      const $el = $(el);
      if ($el.parents("#toc").length > 0) return;
      const href = $el.find("a").first().attr("href");
      if (href && href.startsWith("/wiki/") && !href.includes(":")) {
        const text = $el
          .text()
          .replace(/\[\d+\]/g, "")
          .trim()
          .replace(/^\d+\.\s+\w+\.?\s+/, "");
        entries.push({
          id: `de:${href}`,
          wikiPath: href,
          text,
          url: `https://de.wikipedia.org${href}`,
          lang: "de",
        });
      }
    });
    return entries;
  } catch (e) {
    console.error("[wiki-de]", url, e.message);
    return [];
  }
}

async function scrapeDe(userAgent) {
  const client = createClient(userAgent);
  const year = new Date().getFullYear();
  const monthIndex = new Date().getMonth();
  const urls = [`https://de.wikipedia.org/wiki/Nekrolog_${year}`];
  for (let i = 0; i <= monthIndex; i++) {
    urls.push(`https://de.wikipedia.org/wiki/Nekrolog_${MONTHS[i]}_${year}`);
  }
  const results = await Promise.all(urls.map((u) => scrapeUrl(client, u)));
  const seen = new Set();
  const unique = [];
  for (const e of results.flat()) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      unique.push(e);
    }
  }
  return {
    entries: unique,
    resolveEnglish: (germanUrl) => resolveEnglish(client, germanUrl),
  };
}

module.exports = { scrapeDe };
