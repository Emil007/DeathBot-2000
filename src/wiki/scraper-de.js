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
    const href =
      $('li.interlanguage-link.interwiki-en a').attr("href") ||
      $('a[lang="en"][hreflang="en"]').attr("href") ||
      $('a[lang="en"]').attr("href") ||
      $(".interlanguage-link-en a").attr("href") ||
      null;
    return href || null;
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

function monthUrls(year, monthIndex) {
  return [`https://de.wikipedia.org/wiki/Nekrolog_${MONTHS[monthIndex]}_${year}`];
}

/**
 * @param {string} userAgent
 * @param {{ scope?: 'recent'|'full' }} [opts]
 */
async function scrapeDe(userAgent, opts = {}) {
  const scope = opts.scope || "full";
  const client = createClient(userAgent);
  const year = new Date().getFullYear();
  const monthIndex = new Date().getMonth();
  const urls = [];

  if (scope === "recent") {
    urls.push(...monthUrls(year, monthIndex));
    if (monthIndex === 0) {
      urls.push(...monthUrls(year - 1, 11));
    } else {
      urls.push(...monthUrls(year, monthIndex - 1));
    }
  } else {
    urls.push(`https://de.wikipedia.org/wiki/Nekrolog_${year}`);
    for (let i = 0; i <= monthIndex; i++) urls.push(...monthUrls(year, i));
  }

  const results = [];
  for (const u of urls) {
    results.push(await scrapeUrl(client, u));
  }
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
