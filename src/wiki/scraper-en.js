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

/**
 * True when a wiki path points to a LIST / navigational article (deaths index,
 * day-of-year lists, births lists) instead of a biography. Entries that link to
 * these must never be announced as deaths.
 */
function isListPagePath(path) {
  if (!path) return false;
  return /^\/wiki\/(Deaths_in_|Nekrolog|List_of_days|List_of_deaths|Lists_of_deaths|List_of_births|Lists_of_births|Category:|Template:|Help:|Wikipedia:|Portal:)/i.test(
    path
  );
}

/** True when entry text is clearly a section/navigation line, not a person. */
function isNavText(text) {
  if (!text) return false;
  return /^(Deaths in |Nekrolog|List of |Lists of |The following is a list|Wikimedia list|Previous |External links|References|See also|Navigation)/i.test(
    String(text).trim()
  );
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
    // Drop entries pointing to Wikipedia list/nav pages (the EN wiki now keeps
    // finished months on their own pages and lists them in "Previous months"
    // div-col / footer navboxes — those must not be treated as deaths).
    if (!wikiPath || isListPagePath(wikiPath)) return;

    const text = $el.text().replace(/\[\d+\]/g, "").trim();
    if (text.length < 5) return;
    // Skip legend / instruction lines
    if (/^Name, age, country/i.test(text)) return;
    // Skip navigation / list-article text (robust against future nav formats)
    if (isNavText(text)) return;

    const id = `${lang}:${wikiPath}`;
    if (seen.has(id)) return;
    seen.add(id);

    // Day of death: the month page groups entries under a numeric day heading
    // (H3). Read the closest preceding day heading so the all-deaths card can
    // show the date instead of an empty/uneven entry.
    const $ul = $el.closest("ul");
    let day = null;
    const $prev = $ul.prev();
    if ($prev.is("h3")) {
      day = parseDayId($prev.attr("id"));
    } else {
      const $h3 = $prev.find("h3").first();
      day = parseDayId($h3.attr("id"));
    }
    if (day == null) {
      // fallback: any preceding heading in this month section
      const $h = $ul.prevAll("div.mw-heading3 h3, h3").first();
      day = parseDayId($h.attr("id"));
    }

    entries.push({
      id,
      wikiPath,
      text,
      url: `https://${lang}.wikipedia.org${wikiPath}`,
      lang,
      ...(day != null ? { day } : {}),
    });
  });

  return entries;
}

function parseDayId(id) {
  if (!id) return null;
  const m = String(id).match(/^(\d{1,2})$/);
  return m ? parseInt(m[1], 10) : null;
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

function monthUrl(year, monthIndex) {
  return `https://en.wikipedia.org/wiki/Deaths_in_${MONTHS[monthIndex]}_${year}`;
}

/** Month index + year a deaths URL refers to (0-11), or null. */
function monthFlagsFromUrl(url, year, monthIndex) {
  const m = String(url).match(/Deaths_in_([A-Za-z]+)_(\d{4})/);
  if (m) {
    const idx = MONTHS.indexOf(m[1]);
    if (idx !== -1) return { month: idx, year: parseInt(m[2], 10) };
    return null;
  }
  // "Deaths_in_<Year>" == the current, incomplete month
  return { month: monthIndex, year };
}

/**
 * @param {string} userAgent
 * @param {{ scope?: 'recent'|'full' }} [opts]
 * recent = current + previous month; full = current month + all months YTD
 *
 * Since Oct 2026 the EN wiki splits FINISHED months onto their own
 * "Deaths_in_<Month>_<Year>" pages (like the German wiki), while the current
 * (unfinished) month stays on "Deaths_in_<Year>" together with a
 * "Previous months" div-col navigation section. The current month is always
 * read from the year page; older months come from their standalone pages.
 * "Deaths_in_October_2026" itself redirects to the year page, so it must not
 * be fetched separately (the year page already provides it).
 */
async function scrapeEn(userAgent, opts = {}) {
  const scope = opts.scope || "full";
  const client = createClient(userAgent);
  const year = new Date().getFullYear();
  const monthIndex = new Date().getMonth();
  const urls = [];

  // Current (incomplete) month lives on the year page.
  urls.push(`https://en.wikipedia.org/wiki/Deaths_in_${year}`);

  const prevYear = monthIndex === 0 ? year - 1 : year;
  const prevMonth = monthIndex === 0 ? 11 : monthIndex - 1;

  if (scope === "recent") {
    urls.push(monthUrl(prevYear, prevMonth));
  } else {
    // finished months: Jan..previous month standalone pages
    for (let i = 0; i < monthIndex; i++) urls.push(monthUrl(year, i));
  }

  const results = [];
  for (const u of urls) {
    const flag = monthFlagsFromUrl(u, year, monthIndex);
    const scraped = await scrapeUrl(client, u, "en");
    if (flag) {
      for (const e of scraped) {
        e.month = flag.month;
        e.year = flag.year;
      }
    }
    results.push(scraped);
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
