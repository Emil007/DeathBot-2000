const axios = require("axios");
const cheerio = require("cheerio");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function createClient(userAgent) {
  return axios.create({
    timeout: 30000,
    headers: { "User-Agent": userAgent },
  });
}

/**
 * Normalize EN/DE wikipedia hrefs (relative or absolute, strip redlink query).
 * @returns {string|null} `/wiki/Title` or null
 */
function wikiPathFromHref(href, lang = "en") {
  if (!href) return null;
  let raw = String(href).trim();
  if (raw.startsWith("//")) raw = "https:" + raw;

  let path = null;
  if (raw.startsWith("/wiki/")) {
    path = raw.split("#")[0].split("?")[0];
  } else {
    try {
      const u = new URL(raw);
      if (!u.hostname.endsWith(".wikipedia.org")) return null;
      if (lang && !u.hostname.startsWith(`${lang}.`)) {
        // allow any language host when lang not enforced
      }
      if (!u.pathname.startsWith("/wiki/")) return null;
      path = u.pathname.split("#")[0];
    } catch {
      return null;
    }
  }
  if (!path || !path.startsWith("/wiki/")) return null;
  const title = path.slice("/wiki/".length);
  // Skip namespaces: Category:, File:, Template:, Special:, etc.
  if (title.includes(":")) return null;
  return path;
}

function firstPersonLink($el, lang) {
  const anchors = $el.find("a").toArray();
  for (const a of anchors) {
    const href = $el.find(a).attr("href") || a.attribs?.href;
    const path = wikiPathFromHref(href, lang);
    if (path) return path;
  }
  // cheerio element form
  for (const a of anchors) {
    const href = cheerio.load(a)("a").attr("href") || (a.attribs && a.attribs.href);
    const path = wikiPathFromHref(href, lang);
    if (path) return path;
  }
  return null;
}

function extractEntriesFromHtml(html, lang) {
  const $ = cheerio.load(html);
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

    const text = $el.text().replace(/\[\d+\]/g, "").trim();
    if (text.length < 5) return;
    // Skip legend / instruction lines
    if (/^Name, age, country/i.test(text)) return;

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

async function scrapeUrl(client, url, lang = "en") {
  try {
    const response = await client.get(url);
    return extractEntriesFromHtml(response.data, lang);
  } catch (e) {
    console.error("[wiki-en]", url, e.message);
    return [];
  }
}

function monthUrls(year, monthIndex) {
  return [`https://en.wikipedia.org/wiki/Deaths_in_${MONTHS[monthIndex]}_${year}`];
}

/**
 * @param {string} userAgent
 * @param {{ scope?: 'recent'|'full' }} [opts]
 * recent = current + previous month; full = year page + all months YTD
 */
async function scrapeEn(userAgent, opts = {}) {
  const scope = opts.scope || "full";
  const client = createClient(userAgent);
  const year = new Date().getFullYear();
  const monthIndex = new Date().getMonth();
  const urls = [];

  // Year page is canonical in recent years (months often redirect here)
  urls.push(`https://en.wikipedia.org/wiki/Deaths_in_${year}`);

  if (scope === "recent") {
    urls.push(...monthUrls(year, monthIndex));
    if (monthIndex === 0) {
      urls.push(`https://en.wikipedia.org/wiki/Deaths_in_${year - 1}`);
      urls.push(...monthUrls(year - 1, 11));
    } else {
      urls.push(...monthUrls(year, monthIndex - 1));
    }
  } else {
    for (let i = 0; i <= monthIndex; i++) urls.push(...monthUrls(year, i));
  }

  const results = [];
  for (const u of urls) {
    results.push(await scrapeUrl(client, u, "en"));
  }
  const seen = new Set();
  const unique = [];
  for (const e of results.flat()) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      unique.push(e);
    }
  }
  console.log(`[wiki-en] scraped ${unique.length} entries from ${urls.length} urls (scope=${scope})`);
  return unique;
}

module.exports = { scrapeEn, wikiPathFromHref, extractEntriesFromHtml };
