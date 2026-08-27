const axios = require("axios");

/** Same idea as the proven deathlist_checker.py */
const DEATH_REGEX = /(Category:\d{4}_deaths|Kategorie:Gestorben_\d{4})/i;

function createClient(userAgent) {
  return axios.create({
    timeout: 15000,
    headers: { "User-Agent": userAgent },
    validateStatus: (s) => s >= 200 && s < 500,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  let lang = "en";
  let title = null;
  try {
    const u = new URL(url);
    lang = u.hostname.split(".")[0];
    title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
  } catch {
    return pageHasDeathCategory(createClient(userAgent), url);
  }

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
        return { dead: true, category: c, via: "api" };
      }
      if (/^Gestorben \d{4}$/i.test(c.replace(/^Kategorie:/i, "").trim())) {
        return { dead: true, category: c, via: "api" };
      }
    }
    // API may truncate; HTML regex as backup
    return pageHasDeathCategory(client, url);
  } catch {
    return pageHasDeathCategory(client, url);
  }
}

/**
 * Check all auto-match celebs via their confirmed wiki URL(s).
 * @returns {Promise<Array<{ celeb, entry, age, via: 'category' }>>}
 */
async function findPoolDeathsByCategory(userAgent, { delayMs = 350 } = {}) {
  const db = require("../db");
  const celebs = db.getAliveCelebsForAuto();
  const hits = [];

  for (const celeb of celebs) {
    const urls = [celeb.wiki_url, celeb.wiki_url_de].filter(Boolean);
    if (!urls.length) continue;

    let found = null;
    for (const url of urls) {
      const result = await checkUrlDead(userAgent, url);
      if (result.dead) {
        found = { url, category: result.category };
        break;
      }
      if (delayMs) await sleep(delayMs);
    }
    if (!found && delayMs) await sleep(delayMs);

    if (found) {
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
    }
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
};
