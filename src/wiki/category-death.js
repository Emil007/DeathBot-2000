const axios = require("axios");

/** Same idea as the proven deathlist_checker.py */
const DEATH_REGEX = /(Category:\d{4}_deaths|Kategorie:Gestorben_\d{4})/i;

function createClient(userAgent) {
  return axios.create({
    timeout: 20000,
    headers: { "User-Agent": userAgent },
    validateStatus: (s) => s >= 200 && s < 500,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDeathYear(category) {
  if (!category) return null;
  const s = String(category);
  let m = s.match(/Category:(\d{4})_deaths/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d{4})\s+deaths/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/Kategorie:Gestorben[_\s](\d{4})/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/Gestorben\s+(\d{4})/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function parseWikiUrl(url) {
  try {
    const u = new URL(url);
    const lang = u.hostname.split(".")[0];
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
    return { lang, title };
  } catch {
    return null;
  }
}

/**
 * True if the Wikipedia page HTML (or API categories) marks the person as deceased.
 */
async function pageHasDeathCategory(client, url) {
  if (!url || !/wikipedia\.org\/wiki\//i.test(url)) return { dead: false };
  try {
    const r = await client.get(url);
    if (r.status !== 200 || typeof r.data !== "string") {
      return { dead: false, status: r.status };
    }
    const m = DEATH_REGEX.exec(r.data);
    if (!m) return { dead: false, status: 200 };
    return { dead: true, category: m[1], status: 200 };
  } catch (e) {
    return { dead: false, error: e.message };
  }
}

/**
 * Prefer MediaWiki API categories (lighter than full HTML); fall back to HTML regex.
 */
async function checkUrlDead(userAgent, url) {
  if (!url) return { dead: false };
  const parsed = parseWikiUrl(url);
  if (!parsed) return pageHasDeathCategory(createClient(userAgent), url);

  const { lang, title } = parsed;
  const client = createClient(userAgent);
  try {
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const { data, status } = await client.get(api, {
      params: {
        action: "query",
        titles: title,
        prop: "categories",
        cllimit: 100,
        format: "json",
        origin: "*",
        redirects: 1,
      },
    });
    if (status !== 200) {
      return pageHasDeathCategory(client, url);
    }
    const page = Object.values(data?.query?.pages || {})[0];
    if (!page || page.missing != null) {
      return pageHasDeathCategory(client, url);
    }
    const cats = (page.categories || []).map((c) => c.title || "");
    for (const c of cats) {
      if (/^\d{4} deaths$/i.test(c.replace(/^Category:/i, "").trim())) {
        return { dead: true, category: c, via: "api", lang, title };
      }
      if (/^Gestorben \d{4}$/i.test(c.replace(/^Kategorie:/i, "").trim())) {
        return { dead: true, category: c, via: "api", lang, title };
      }
    }
    const html = await pageHasDeathCategory(client, url);
    return { ...html, lang, title };
  } catch {
    return pageHasDeathCategory(client, url);
  }
}

/**
 * Content of the last revision at or before seasonStart (ISO date YYYY-MM-DD).
 */
async function revisionContentBefore(client, lang, title, seasonStartDate) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const rvstart = `${seasonStartDate}T00:00:00Z`;
  const { data, status } = await client.get(api, {
    params: {
      action: "query",
      titles: title,
      prop: "revisions",
      rvlimit: 1,
      rvstart,
      rvdir: "older",
      rvprop: "content|timestamp|ids",
      rvslots: "main",
      format: "json",
      formatversion: 2,
      redirects: 1,
      origin: "*",
    },
  });
  if (status !== 200) return null;
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;
  const rev = page.revisions?.[0];
  if (!rev) return null;
  const content = rev.slots?.main?.content ?? rev.content ?? null;
  return content == null
    ? null
    : { content: String(content), timestamp: rev.timestamp, revid: rev.revid };
}

/**
 * Is this death category valid for the active season?
 * - Category year before season year → invalid (e.g. 2023 deaths, season 2026)
 * - Else: if the death category was already on the page before season start → invalid
 */
async function isDeathValidForSeason(userAgent, url, category, seasonStartDate) {
  if (!seasonStartDate || !/^\d{4}-\d{2}-\d{2}$/.test(seasonStartDate)) {
    return { valid: true, reason: "no season start" };
  }

  const deathYear = parseDeathYear(category);
  const seasonYear = parseInt(seasonStartDate.slice(0, 4), 10);

  if (deathYear != null && deathYear < seasonYear) {
    return {
      valid: false,
      reason: `category year ${deathYear} < season ${seasonYear}`,
      deathYear,
    };
  }

  const parsed = parseWikiUrl(url);
  if (!parsed) return { valid: true, reason: "unparsed url" };

  const client = createClient(userAgent);
  try {
    const before = await revisionContentBefore(
      client,
      parsed.lang,
      parsed.title,
      seasonStartDate
    );
    if (!before?.content) {
      // No revision before season start → page/category likely added after → allow
      return { valid: true, reason: "no pre-season revision" };
    }
    if (DEATH_REGEX.test(before.content)) {
      return {
        valid: false,
        reason: `death category already in revision ${before.timestamp} (before ${seasonStartDate})`,
        deathYear,
      };
    }
    return { valid: true, reason: "category added after season start", deathYear };
  } catch (e) {
    console.warn("[category-death] history check failed", e.message);
    // Fail open only if year gate passed; year gate already caught Patitz-style cases
    return { valid: true, reason: `history error: ${e.message}` };
  }
}

/**
 * Check all auto-match celebs via their confirmed wiki URL(s).
 * Skips (and excludes from auto) deaths that pre-date the season start.
 */
async function findPoolDeathsByCategory(userAgent, { delayMs = 350, seasonStartDate = null } = {}) {
  const db = require("../db");
  const season = db.getActiveSeason();
  const start = seasonStartDate || season.start_date;
  const celebs = db.getAliveCelebsForAuto();
  const hits = [];

  for (const celeb of celebs) {
    const urls = [celeb.wiki_url, celeb.wiki_url_de].filter(Boolean);
    if (!urls.length) continue;

    let found = null;
    for (const url of urls) {
      const result = await checkUrlDead(userAgent, url);
      if (result.dead) {
        found = { url, category: result.category, lang: result.lang, title: result.title };
        break;
      }
      if (delayMs) await sleep(delayMs);
    }
    if (!found) {
      if (delayMs) await sleep(delayMs);
      continue;
    }

    const validity = await isDeathValidForSeason(
      userAgent,
      found.url,
      found.category,
      start
    );
    if (!validity.valid) {
      console.log(
        new Date().toISOString(),
        "[category-death] pre-season/invalid → exclude auto",
        celeb.name,
        found.category || "",
        validity.reason
      );
      // Stop re-hitting every poll (already dead before this season)
      db.setExcludeFromAuto(celeb.id, true);
      if (delayMs) await sleep(delayMs);
      continue;
    }

    console.log(
      new Date().toISOString(),
      "[category-death]",
      celeb.name,
      found.category || "",
      found.url
    );
    hits.push({
      celeb,
      entry: {
        id: `cat:${celeb.id}:${found.url}`,
        wikiPath: (() => {
          try {
            return new URL(found.url).pathname;
          } catch {
            return null;
          }
        })(),
        text: `${celeb.name} (${found.category || "death category"})`,
        url: found.url,
        lang: /de\.wikipedia/i.test(found.url) ? "de" : "en",
      },
      age: celeb.age_at_pick ?? null,
      via: "category",
    });
    if (delayMs) await sleep(delayMs);
  }

  return hits;
}

/**
 * True if celeb still has a death category (for retract safety).
 */
async function celebStillMarkedDead(userAgent, celeb) {
  const urls = [celeb.wiki_url, celeb.wiki_url_de].filter(Boolean);
  for (const url of urls) {
    const r = await checkUrlDead(userAgent, url);
    if (r.dead) return true;
  }
  return false;
}

module.exports = {
  DEATH_REGEX,
  checkUrlDead,
  findPoolDeathsByCategory,
  celebStillMarkedDead,
  pageHasDeathCategory,
  parseDeathYear,
  isDeathValidForSeason,
};
