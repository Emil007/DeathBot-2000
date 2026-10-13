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
  // Network/HTTP failures must NOT be treated as "no EN variant": they are
  // transient, and posting the DE entry as DE-only would violate the EN-first
  // rule. Only a successfully loaded page WITHOUT an EN interwiki link means
  // "no EN". Let HTTP/network errors propagate so the poller can defer the DE
  // entry (retry next poll) instead of misrouting it to DE-only.
  const response = await client.get(germanUrl);
  const $ = cheerio.load(response.data);
  const href =
    $('li.interlanguage-link.interwiki-en a').attr("href") ||
    $('a[lang="en"][hreflang="en"]').attr("href") ||
    $('a[lang="en"]').attr("href") ||
    $(".interlanguage-link-en a").attr("href") ||
    null;
  return href || null;
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
    // Drop CSS/markup fragments leaked into list items
    if (/(color:inherit|\{[^}]{2,}\}|^\.[a-z-]+\s*\{|^#\w+\s*\{)/i.test(text)) return;

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

/**
 * Red link ("Seite nicht vorhanden"): no article behind it. Parsoid HTML keeps
 * the /wiki/ path (`/wiki/X?action=edit&redlink=1`), so wikiPathFromHref alone
 * would accept it as an article.
 */
function isRedLink($a) {
  return $a.hasClass("new") || /[?&]redlink=1\b/.test(String($a.attr("href") || ""));
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
    // Only the Name column (usually 2nd td) may supply the article. A red-linked
    // or unlinked name skips the row: any other link in the row belongs to the
    // Beruf column (SPD, Schauspieler) and would post a card for the wrong thing.
    const tds = $el.find("td");
    const nameCell = tds.eq(1).length ? tds.eq(1) : $el;
    nameCell.find("a").each((__, a) => {
      const $a = $(a);
      if (isRedLink($a)) return false;
      const path = wikiPathFromHref($a.attr("href"), lang);
      if (path) {
        wikiPath = path;
        nameText = $a.text().trim();
        return false;
      }
    });
    if (!wikiPath) return;
    // Skip links to other nekrolog index pages
    if (/^\/wiki\/Nekrolog/i.test(wikiPath)) return;

    // Refs/ranges must not merge into one number: "85[1]" → 85, "85–86" → 85.
    const ageMatch = tds.eq(3).text().replace(/\[\d+\]/g, "").match(/\d{1,3}/);
    const age = ageMatch ? ageMatch[0] : "";
    const beruf = tds.eq(2).text().replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
    const tag = tds.eq(0).text().trim();
    const text = [nameText, age && `${age}`, beruf, tag].filter(Boolean).join(", ");

    // Day-of-death: DE month tables put "8. Oktober" in the first column
    // (with or without a year for entries from a different year).
    const deathDate = parseDeDate(tag);

    const id = `${lang}:${wikiPath}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      wikiPath,
      text,
      url: `https://${lang}.wikipedia.org${wikiPath}`,
      lang,
      ...(beruf ? { beruf } : {}),
      ...(deathDate ? { ...deathDate } : {}),
    });
  });
  return entries;
}

const MONTHS_DE_IDX = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** Parse "8. Oktober" (optionally "8. Oktober 2026") into {day,month[,year]}. */
function parseDeDate(tag) {
  if (!tag) return null;
  const m = String(tag).match(/(\d{1,2})\s*\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})?/);
  if (!m) return null;
  const month = MONTHS_DE_IDX.indexOf(m[2]);
  if (month === -1) return null;
  const day = parseInt(m[1], 10);
  if (!(day >= 1 && day <= 31)) return null;
  const out = { day, month };
  if (m[3]) out.year = parseInt(m[3], 10);
  return out;
}

/**
 * Month index + year a nekrolog URL refers to (like EN's monthFlagsFromUrl):
 * "Nekrolog_<Monat>_<Jahr>" → {month, year}, "Nekrolog_<Jahr>" → {year}.
 */
function monthFlagsFromUrl(url) {
  let s = String(url);
  try {
    s = decodeURIComponent(s);
  } catch {}
  const m = s.match(/Nekrolog_([^_/?#]+)_(\d{4})\b/);
  if (m) {
    const idx = MONTHS.indexOf(m[1]);
    return idx !== -1 ? { month: idx, year: parseInt(m[2], 10) } : null;
  }
  const y = s.match(/Nekrolog_(\d{4})\b/);
  return y ? { year: parseInt(y[1], 10) } : null;
}

/**
 * Default year/month from the page URL — the Tag column only says "8. Oktober",
 * so a December death posted in January would otherwise get the current year.
 * An explicit year in the Tag column wins. A month page can also list a
 * late-reported death from the previous year ("28. Dezember" on
 * Nekrolog_Januar_2027 → 2026).
 */
function applyUrlDateFlags(entries, url) {
  const flags = monthFlagsFromUrl(url);
  if (!flags) return entries;
  for (const e of entries) {
    if (e.year == null) {
      e.year =
        flags.month != null && e.month != null && e.month > flags.month
          ? flags.year - 1
          : flags.year;
    }
    if (e.month == null && flags.month != null) e.month = flags.month;
  }
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
    return applyUrlDateFlags([...merged.values()], url);
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

module.exports = { scrapeDe, extractFromTables, monthFlagsFromUrl, applyUrlDateFlags };
