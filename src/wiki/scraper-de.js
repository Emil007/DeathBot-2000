const axios = require("axios");
const cheerio = require("cheerio");
const { wikiPathFromHref } = require("./scraper-en");

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

function extractFromLists($, lang) {
  const entries = [];
  const seen = new Set();
  $(".mw-parser-output ul li").each((_, el) => {
    const $el = $(el);
    if ($el.parents("#toc, .navbox, .reflist, .references").length > 0) return;

    let wikiPath = null;
    $el.find("a").each((__, a) => {
      if (wikiPath) return;
      wikiPath = wikiPathFromHref($(a).attr("href"), lang);
    });
    if (!wikiPath) return;
    if (/^\/wiki\/Nekrolog/i.test(wikiPath)) return;

    const text = $el
      .text()
      .replace(/\[\d+\]/g, "")
      .trim()
      .replace(/^\d+\.\s+\w+\.?\s+/, "");
    if (text.length < 5) return;
    if (/^Nekrolog\b/i.test(text)) return;

    const id = `${lang}:${wikiPath}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      wikiPath,
      text,
      url: `https://${lang}.wikipedia.org${wikiPath}`,
      lang,
    });
  });
  return entries;
}

/** Modern DE nekrolog months use wikitable rows: Tag | Name | Beruf | Alter | Beleg */
function extractFromTables($, lang) {
  const entries = [];
  const seen = new Set();
  $(".mw-parser-output table.wikitable tr").each((_, el) => {
    const $el = $(el);
    if ($el.find("th").length) return; // header

    let wikiPath = null;
    let nameText = "";
    // Prefer link in the Name column (usually 2nd td)
    const tds = $el.find("td");
    const nameCell = tds.eq(1).length ? tds.eq(1) : $el;
    nameCell.find("a").each((__, a) => {
      if (wikiPath) return;
      const href = $(a).attr("href");
      const path = wikiPathFromHref(href, lang);
      if (path) {
        wikiPath = path;
        nameText = $(a).text().trim();
      }
    });
    if (!wikiPath) {
      $el.find("a").each((__, a) => {
        if (wikiPath) return;
        const path = wikiPathFromHref($(a).attr("href"), lang);
        if (path) {
          wikiPath = path;
          nameText = $(a).text().trim();
        }
      });
    }
    if (!wikiPath) return;
    // Skip links to other nekrolog index pages
    if (/^\/wiki\/Nekrolog/i.test(wikiPath)) return;

    const age = tds.eq(3).text().replace(/[^\d]/g, "") || "";
    const beruf = tds.eq(2).text().trim();
    const tag = tds.eq(0).text().trim();
    const text = [nameText, age && `${age}`, beruf, tag].filter(Boolean).join(", ");

    const id = `${lang}:${wikiPath}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      wikiPath,
      text,
      url: `https://${lang}.wikipedia.org${wikiPath}`,
      lang,
    });
  });
  return entries;
}

async function scrapeUrl(client, url) {
  try {
    const response = await client.get(url);
    const $ = cheerio.load(response.data);
    const fromTables = extractFromTables($, "de");
    const fromLists = extractFromLists($, "de");
    // Prefer whichever found more (tables dominate modern monthly pages)
    const merged = new Map();
    for (const e of [...fromLists, ...fromTables]) merged.set(e.id, e);
    return [...merged.values()];
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

  urls.push(`https://de.wikipedia.org/wiki/Nekrolog_${year}`);

  if (scope === "recent") {
    urls.push(...monthUrls(year, monthIndex));
    if (monthIndex === 0) {
      urls.push(`https://de.wikipedia.org/wiki/Nekrolog_${year - 1}`);
      urls.push(...monthUrls(year - 1, 11));
    } else {
      urls.push(...monthUrls(year, monthIndex - 1));
    }
  } else {
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
  console.log(`[wiki-de] scraped ${unique.length} entries from ${urls.length} urls (scope=${scope})`);
  return {
    entries: unique,
    resolveEnglish: (germanUrl) => resolveEnglish(client, germanUrl),
  };
}

module.exports = { scrapeDe };
