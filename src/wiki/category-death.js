const axios = require("axios");

/** Same idea as the proven deathlist_checker.py */
// Nur die kanonischen Todes-Jahreskategorien: exakt 4 Ziffern + exakt
// "deaths"/"_deaths" bzw. "Gestorben 2026"/"Gestorben_2026", verankert am
// Ende ($). Keine Unterkategorien ("Category:2026 deaths in France"), keine
// anderen Suffixe ("Category:January 2026 deaths"), kein [_: ]-Fressen.
const DEATH_REGEX = /(Category:(?:\d{4})_deaths$|Category:(?:\d{4}) deaths$|Kategorie:Gestorben_\d{4}$|Kategorie:Gestorben \d{4}$)/i;

const BATCH_SIZE = 50;

/**
 * M1 owns `src/db/time.js` (`localMidnightUtc`). This package only calls it.
 * If that module is not in the tree yet, the same contract is applied locally
 * so revision timestamps do not fall back to `${date}T00:00:00Z`.
 */
function timeModuleMissing(err) {
  if (!err || err.code !== "MODULE_NOT_FOUND") return false;
  const first = String(err.message || "").split("\n")[0];
  return /[/\\]db[/\\]time(?:\.js)?['"]?\s*$/.test(first);
}

function tzOffsetMs(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - date.getTime();
}

function localMidnightUtcFallback(yyyyMmDd, timeZone) {
  const [y, m, d] = String(yyyyMmDd).split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset1 = tzOffsetMs(new Date(utcGuess), timeZone);
  let utc = utcGuess - offset1;
  const offset2 = tzOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset1) utc = utcGuess - offset2;
  return new Date(utc).toISOString();
}

function timeApi() {
  if (timeApi.mod) return timeApi.mod;
  try {
    timeApi.mod = require("../db/time");
  } catch (err) {
    if (!timeModuleMissing(err)) throw err;
    timeApi.mod = { localMidnightUtc: localMidnightUtcFallback };
  }
  return timeApi.mod;
}

function createClient(userAgent) {
  return axios.create({
    timeout: 20000,
    headers: { "User-Agent": userAgent },
    // 429 must not resolve into the HTML fallback. 5xx already reject.
    validateStatus: (s) => s >= 200 && s < 500 && s !== 429,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") return true;
  return /timeout/i.test(String(err.message || ""));
}

function httpError(status) {
  return `http-${status || 0}`;
}

/**
 * Three linear attempts, same shape as getRetry in death-brief.js
 * (`600 * (i + 1) + jitter`). 429 and 5xx are retried; a failed status is
 * never returned as a clean success.
 */
async function getRetry(client, url, params, { tries = 3 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await client.get(url, params ? { params } : undefined);
      const status = Number(r?.status || 0);
      if (status === 429 || status >= 500) {
        last = { failed: true, status, error: httpError(status) };
        if (i < tries - 1) {
          await sleep(600 * (i + 1) + Math.random() * 400);
          continue;
        }
        return last;
      }
      if (status < 200 || status >= 300) {
        return { failed: true, status, error: httpError(status) };
      }
      return r;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        last = { failed: true, status, error: httpError(status) };
        if (i < tries - 1) {
          await sleep(600 * (i + 1) + Math.random() * 400);
          continue;
        }
        return last;
      }
      if (status) return { failed: true, status, error: httpError(status) };
      if (isTimeoutError(err)) {
        last = { failed: true, error: "timeout" };
        if (i < tries - 1) {
          await sleep(600 * (i + 1) + Math.random() * 400);
          continue;
        }
        return last;
      }
      return { failed: true, error: err?.message || "network" };
    }
  }
  return last || { failed: true, error: "network" };
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

function normTitle(s) {
  return String(s || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pagesOf(data) {
  const pages = data?.query?.pages;
  if (!pages) return [];
  return Array.isArray(pages) ? pages : Object.values(pages);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * True if the Wikipedia page HTML (or API categories) marks the person as deceased.
 * A failed status is never "alive": it carries `error`.
 */
async function pageHasDeathCategory(client, url) {
  if (!url || !/wikipedia\.org\/wiki\//i.test(url)) return { dead: false };
  const res = await getRetry(client, url);
  if (res.failed) {
    return { dead: false, status: res.status, error: res.error || httpError(res.status) };
  }
  if (typeof res.data !== "string") {
    return { dead: false, status: res.status, error: httpError(res.status) };
  }
  const html = String(res.data);
  // Only the page's own category box — not body mentions of other death cats
  const catBox =
    html.match(/id="catlinks"[\s\S]*?<\/div><\/div>/i)?.[0] ||
    html.match(/id="mw-normal-catlinks"[\s\S]*?<\/div>/i)?.[0] ||
    "";
  const haystack = catBox || html;
  const m = DEATH_REGEX.exec(haystack);
  if (!m) return { dead: false, status: 200 };
  return { dead: true, category: m[1], status: 200 };
}

function deathCategoryTitle(raw) {
  const c = String(raw || "");
  const bare = c.replace(/^(Category|Kategorie):/i, "").trim().replace(/_/g, " ");
  if (/^\d{4} deaths$/i.test(bare)) return c;
  if (/^Gestorben \d{4}$/i.test(bare)) return c;
  const m = DEATH_REGEX.exec(c);
  return m ? m[1] : null;
}

function interpretCategories(page, meta) {
  const cats = (page?.categories || []).map((c) => c.title || "");
  const living = cats.some((c) => {
    const bare = c.replace(/^(Category|Kategorie):/i, "").trim();
    return /^Living people$/i.test(bare) || /^Lebende Person$/i.test(bare);
  });
  for (const c of cats) {
    const hit = deathCategoryTitle(c);
    if (hit) return { ...meta, dead: true, category: hit };
  }
  if (living) return { ...meta, dead: false, via: "api-living" };
  return { ...meta, dead: false, via: "api" };
}

/**
 * Prefer MediaWiki API categories (lighter than full HTML); fall back to HTML regex.
 * 429/5xx/timeout never fall through to HTML and never come back as a clean alive.
 */
async function checkUrlDead(userAgent, url, client) {
  if (!url) return { dead: false };
  const parsed = parseWikiUrl(url);
  const c = client || createClient(userAgent);
  if (!parsed) return pageHasDeathCategory(c, url);

  const { lang, title } = parsed;
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const res = await getRetry(c, api, {
    action: "query",
    titles: title,
    prop: "categories",
    cllimit: "max",
    format: "json",
    origin: "*",
    redirects: 1,
  });
  if (res.failed) {
    return { dead: false, error: res.error || httpError(res.status), lang, title };
  }
  const page = pagesOf(res.data)[0];
  if (!page || page.missing != null || page.invalid != null) {
    const html = await pageHasDeathCategory(c, url);
    if (html.error) return { dead: false, error: html.error, status: html.status, lang, title };
    return { ...html, lang, title };
  }
  return interpretCategories(page, { via: "api", lang, title });
}

/**
 * Content of the last revision at or before local midnight of seasonStart
 * in `tz` (default Europe/Vienna). Full rvprop=content belongs only here.
 */
async function revisionContentBefore(client, lang, title, seasonStartDate, tz) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const zone = tz || "Europe/Vienna";
  let rvstart = timeApi().localMidnightUtc(seasonStartDate, zone);
  if (rvstart instanceof Date) rvstart = rvstart.toISOString();
  const res = await getRetry(client, api, {
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
  });
  if (res.failed || res.status !== 200) return null;
  const data = res.data;
  const page = Array.isArray(data?.query?.pages)
    ? data.query.pages[0]
    : pagesOf(data)[0];
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
async function isDeathValidForSeason(userAgent, url, category, seasonStartDate, tz, client) {
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

  const c = client || createClient(userAgent);
  try {
    const before = await revisionContentBefore(
      c,
      parsed.lang,
      parsed.title,
      seasonStartDate,
      tz
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

function buildPageIndex(data) {
  const pages = pagesOf(data);
  const byTitle = new Map();
  const alias = new Map();
  for (const p of pages) {
    if (p?.title) byTitle.set(normTitle(p.title), p);
  }
  const link = (from, to) => {
    if (!from || !to) return;
    alias.set(normTitle(from), normTitle(to));
  };
  for (const n of data?.query?.normalized || []) link(n.from, n.to);
  for (const r of data?.query?.redirects || []) link(r.from, r.to);
  return { pages, byTitle, alias };
}

function pageForTitle(index, title) {
  let key = normTitle(title);
  const seen = new Set();
  while (index.alias.has(key) && !seen.has(key)) {
    seen.add(key);
    const next = index.alias.get(key);
    if (!next || next === key) break;
    key = next;
  }
  return index.byTitle.get(key) || null;
}

function collectJobs(celebs) {
  const jobs = [];
  let ord = 0;
  for (const celeb of celebs || []) {
    const urls = [celeb.wiki_url, celeb.wiki_url_de].filter(Boolean);
    for (const url of urls) {
      const parsed = parseWikiUrl(url);
      if (!parsed?.lang || !parsed.title) continue;
      jobs.push({
        celebId: celeb.id,
        url,
        lang: parsed.lang,
        title: parsed.title,
        ord: ord++,
      });
    }
  }
  return jobs;
}

/**
 * One pass over `celebs` (auto pool, announced pool, or their union).
 * Titles go out in batches of 50, one HTTP client per language for the run.
 * `dead: false` without `error` means the categories really came back alive.
 * 429 / 5xx / timeout set `error` and are not a life sign.
 *
 * `seasonStartDate` and `tz` are accepted and forwarded by the wrappers; the
 * batch itself does not pull revision content. That happens only in
 * isDeathValidForSeason, and only for a real hit.
 */
async function findDeathsByCategory(userAgent, celebs, opts = {}) {
  const delayMs = opts.delayMs || 0;
  const list = Array.isArray(celebs) ? celebs : [];
  const jobs = collectJobs(list);
  const byLang = new Map();
  for (const job of jobs) {
    if (!byLang.has(job.lang)) byLang.set(job.lang, []);
    byLang.get(job.lang).push(job);
  }

  const clients = new Map();
  const clientFor = (lang) => {
    if (!clients.has(lang)) clients.set(lang, createClient(userAgent));
    return clients.get(lang);
  };

  const outcome = new Map();
  let batchNo = 0;
  for (const [lang, langJobs] of byLang) {
    const client = clientFor(lang);
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const unique = [];
    const seen = new Set();
    for (const job of langJobs) {
      const key = normTitle(job.title);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(job);
    }
    for (const group of chunk(unique, BATCH_SIZE)) {
      if (batchNo > 0 && delayMs) await sleep(delayMs);
      batchNo += 1;
      const inGroup = new Set(group.map((j) => normTitle(j.title)));
      const targets = langJobs.filter((j) => inGroup.has(normTitle(j.title)));
      const res = await getRetry(client, api, {
        action: "query",
        titles: group.map((j) => j.title).join("|"),
        prop: "categories",
        cllimit: "max",
        format: "json",
        origin: "*",
        redirects: 1,
      });
      if (res.failed) {
        const error = res.error || httpError(res.status);
        for (const job of targets) {
          outcome.set(job.ord, {
            dead: false,
            error,
            lang,
            title: job.title,
            url: job.url,
          });
        }
        continue;
      }
      const index = buildPageIndex(res.data);
      for (const job of targets) {
        let page = pageForTitle(index, job.title);
        // Einzelseiten-Fallback NUR für EINZEL-URL-Requests (Einzelseiten-Mocks
        // und seltene API-Antworten, die eine Kategorie liefern, obwohl der
        // zurückgegebene Titel vom angefragten abweicht).
        // NIEMALS bei Mehrfach-Titel-Batches anwenden: dort würde eine einzige
        // echte Todes-Seite ALLE angefragten Personen kollateral als tot
        // markieren (verursachte den 3-Sekunden-Falsch-Positiv-Dump).
        if (!page && index.pages.length === 1 && group.length === 1) {
          const only = index.pages[0];
          const cats = (only.categories || []).map((c) => c.title || "").join(" ");
          if (DEATH_REGEX.test(cats)) page = only;
        }
        if (!page) {
          outcome.set(job.ord, {
            dead: false,
            error: "unmatched",
            lang,
            title: job.title,
            url: job.url,
          });
          continue;
        }
        if (page.missing != null || page.invalid != null) {
          outcome.set(job.ord, { dead: false, lang, title: job.title, url: job.url });
          continue;
        }
        outcome.set(
          job.ord,
          interpretCategories(page, { via: "api", lang, title: job.title, url: job.url })
        );
      }
    }
  }

  const byCeleb = new Map();
  for (const job of jobs) {
    if (!byCeleb.has(job.celebId)) byCeleb.set(job.celebId, []);
    byCeleb.get(job.celebId).push(job);
  }

  const rows = [];
  for (const celeb of list) {
    const mine = byCeleb.get(celeb.id);
    if (!mine?.length) {
      rows.push({ celebId: celeb.id, dead: false });
      continue;
    }
    mine.sort((a, b) => a.ord - b.ord);
    let lastError = null;
    let aliveMeta = null;
    let pushed = false;
    for (const job of mine) {
      const r = outcome.get(job.ord);
      if (!r) continue;
      if (r.error) {
        lastError = r.error;
        continue;
      }
      if (r.dead) {
        rows.push({
          celebId: celeb.id,
          dead: true,
          category: r.category,
          lang: r.lang,
          title: r.title,
          url: r.url,
        });
        pushed = true;
        break;
      }
      aliveMeta = r;
    }
    if (pushed) continue;
    if (lastError) {
      // An error is not a life sign, even if another URL looked clean.
      rows.push({ celebId: celeb.id, dead: false, error: lastError });
    } else {
      rows.push({
        celebId: celeb.id,
        dead: false,
        lang: aliveMeta?.lang,
        title: aliveMeta?.title,
        url: aliveMeta?.url,
      });
    }
  }
  return rows;
}

function wikiPathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Category rows have no day tag. The year comes from the category; month/day
 * are chosen so entryDeathDateIso yields YYYY-01-01 (F18).
 * Altzeilen ohne gespeichertes Scraping-Datum werden nicht rekonstruiert, es gibt keine Spalte `entry_death_date_iso`.
 */
function datePartsFromCategory(category) {
  const year = parseDeathYear(category);
  if (year == null) return {};
  return { year, month: 0, day: 1 };
}

function categoryHit(celeb, row, { announced = false } = {}) {
  const url = row.url;
  const hit = {
    celeb,
    entry: {
      id: `cat:${celeb.id}:${url}`,
      wikiPath: wikiPathOf(url),
      text: `${celeb.name} (${row.category || "death category"})`,
      url,
      lang: /de\.wikipedia/i.test(url) ? "de" : "en",
      ...datePartsFromCategory(row.category),
    },
    age: celeb.age_at_pick ?? null,
    via: "category",
  };
  if (announced) hit.announced = true;
  return hit;
}

/**
 * Check all auto-match celebs via their confirmed wiki URL(s).
 * Skips (and excludes from auto) deaths that pre-date the season start.
 * Thin wrapper around findDeathsByCategory; passes `tz` through.
 */
async function findPoolDeathsByCategory(userAgent, { delayMs = 350, seasonStartDate = null, tz } = {}) {
  const db = require("../db");
  const season = db.getActiveSeason();
  const start = seasonStartDate || season.start_date;
  const zone = tz || "Europe/Vienna";
  const celebs = db.getAliveCelebsForAuto();
  const rows = await findDeathsByCategory(userAgent, celebs, {
    seasonStartDate: start,
    tz: zone,
    delayMs,
  });
  const byId = new Map(celebs.map((c) => [c.id, c]));
  const hits = [];
  // One client for every real hit's revision read, not one per URL.
  const histClient = createClient(userAgent);
  for (const row of rows) {
    if (row.error || !row.dead) {
      if (row.error) {
        const celeb = byId.get(row.celebId);
        console.warn(
          new Date().toISOString(),
          "[category-death] unavailable",
          celeb?.name || row.celebId,
          row.error
        );
      }
      continue;
    }
    const celeb = byId.get(row.celebId);
    if (!celeb) continue;

    const validity = await isDeathValidForSeason(
      userAgent,
      row.url,
      row.category,
      start,
      zone,
      histClient
    );
    if (!validity.valid) {
      console.log(
        new Date().toISOString(),
        "[category-death] pre-season/invalid → exclude auto",
        celeb.name,
        row.category || "",
        validity.reason
      );
      db.setExcludeFromAuto(celeb.id, true);
      continue;
    }

    console.log(
      new Date().toISOString(),
      "[category-death]",
      celeb.name,
      row.category || "",
      row.url
    );
    hits.push(categoryHit(celeb, row));
  }
  return hits;
}

/**
 * Check all ANNOUNCED-season celebs via their confirmed wiki URL(s) — the
 * 2027-only picks (exclude_from_auto=1) that the auto pool never sees.
 *
 * F14c: a registered pick whose celeb dies before the season start must be
 * caught here too. The death is applied with announce:false (no deathpool card)
 * so warnAnnouncedPreStartDeaths() can DM the picker.
 *
 * Unlike the auto sweep, the validity gate does NOT suppress a hit: for an
 * announced (live=0) season whose start is in the future, every current death
 * happened before that start — that's exactly what should trigger a warning.
 * Thin wrapper around findDeathsByCategory; passes `tz` through.
 * The stored day for an untagged category is January 1 of the category year
 * on this path as well as on the pool path.
 */
async function findAnnouncedDeathsByCategory(userAgent, { delayMs = 350, seasonStartDate = null, tz } = {}) {
  const db = require("../db");
  const announcedSeason = db.getAnnouncedSeason?.() || null;
  const start =
    seasonStartDate || announcedSeason?.start_date || db.getActiveSeason().start_date;
  const zone = tz || "Europe/Vienna";
  const celebs = db.getAliveCelebsForAnnounced();
  const rows = await findDeathsByCategory(userAgent, celebs, {
    seasonStartDate: start,
    tz: zone,
    delayMs,
  });
  const byId = new Map(celebs.map((c) => [c.id, c]));
  const hits = [];
  for (const row of rows) {
    if (row.error || !row.dead) continue;
    const celeb = byId.get(row.celebId);
    if (!celeb) continue;
    console.log(
      new Date().toISOString(),
      "[category-death] announced",
      celeb.name,
      row.category || "",
      row.url
    );
    hits.push(categoryHit(celeb, row, { announced: true }));
  }
  return hits;
}

/**
 * True if celeb still has a death category (for retract safety).
 * Returns { dead, error? }. A 429/5xx/timeout is forwarded as `error` and
 * is NOT turned into dead:true — a caller that only checks `dead === false`
 * would otherwise retract on an outage.
 */
async function celebStillMarkedDead(userAgent, celeb) {
  const rows = await findDeathsByCategory(userAgent, [celeb], { delayMs: 0 });
  const row = rows.find((r) => r.celebId === celeb.id);
  if (!row) return { dead: false };
  if (row.error) return { dead: false, error: row.error };
  return { dead: row.dead === true };
}

module.exports = {
  DEATH_REGEX,
  checkUrlDead,
  findDeathsByCategory,
  findPoolDeathsByCategory,
  findAnnouncedDeathsByCategory,
  celebStillMarkedDead,
  pageHasDeathCategory,
  parseDeathYear,
  isDeathValidForSeason,
};
