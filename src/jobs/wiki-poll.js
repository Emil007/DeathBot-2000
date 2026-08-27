const { scrapeEn } = require("../wiki/scraper-en");
const { scrapeDe } = require("../wiki/scraper-de");
const { findPoolMatches, entryMatchesCeleb } = require("../wiki/match");
const {
  findPoolDeathsByCategory,
  celebStillMarkedDead,
} = require("../wiki/category-death");
const db = require("../db");
const {
  processDeathpoolHit,
  announceAllDeath,
  announceRetraction,
} = require("../discord/announce");

async function scrapeAll(config, scope = "full") {
  const [enEntries, deData] = await Promise.all([
    scrapeEn(config.userAgent, { scope }),
    scrapeDe(config.userAgent, { scope }),
  ]);
  return { enEntries, deData, poolEntries: [...enEntries, ...deData.entries] };
}

async function processRetractions(client, config, poolEntries) {
  const pending = db.getUnconfirmedDeaths();
  if (!pending.length) return;

  const confirmMs = config.deathConfirmDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const celeb of pending) {
    const detected = celeb.death_detected_at ? Date.parse(celeb.death_detected_at) : now;

    // Prefer category check (same signal as detection); fall back to death-list match
    let stillDead = await celebStillMarkedDead(config.userAgent, celeb);
    if (!stillDead && poolEntries?.length) {
      stillDead = poolEntries.some((entry) => {
        const akas = db.getAkas(celeb.id);
        const blacklist = db.getBlacklist(celeb.id);
        return entryMatchesCeleb(entry, celeb, akas, blacklist);
      });
    }

    if (!stillDead) {
      console.log(new Date().toISOString(), "[retract]", celeb.name);
      const result = db.retractDeath(celeb.id);
      if (result && db.isLive()) {
        await announceRetraction(client, config, result).catch((e) =>
          console.error("[retract] announce", e.message)
        );
      }
      continue;
    }

    if (now - detected >= confirmMs) {
      console.log(new Date().toISOString(), "[confirm]", celeb.name);
      db.confirmDeath(celeb.id);
    }
  }
}

function mergeHits(categoryHits, listHits) {
  const byId = new Map();
  for (const h of [...categoryHits, ...listHits]) {
    if (!byId.has(h.celeb.id)) byId.set(h.celeb.id, h);
  }
  return [...byId.values()];
}

/**
 * @param {'seed'|'reconcile'|'live'|'nightly'} mode
 */
async function runWikiPoll(client, config, { mode = "live" } = {}) {
  console.log(new Date().toISOString(), `[poll] mode=${mode}`);
  const scope = mode === "live" ? "recent" : "full";
  const { enEntries, deData, poolEntries } = await scrapeAll(config, scope);

  const enIds = new Set(enEntries.map((e) => e.wikiPath));
  const newEn = [];

  for (const e of enEntries) {
    if (db.isWikiSeen(e.id)) continue;
    db.markWikiSeen(e);
    newEn.push(e);
  }

  for (const d of deData.entries) {
    if (!db.isWikiSeen(d.id)) db.markWikiSeen(d);
  }

  const newDeOnly = [];
  if (mode !== "seed") {
    for (const d of deData.entries) {
      const row = db
        .getDb()
        .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
        .get(d.id);
      if (row?.announced_at) continue;

      let enUrl = null;
      try {
        enUrl = await deData.resolveEnglish(d.url);
      } catch {
        /* ignore */
      }
      if (enUrl) {
        const pathPart = enUrl.includes("wikipedia.org")
          ? "/" + enUrl.split("wikipedia.org")[1].replace(/^\/+/, "")
          : null;
        let wikiPath = pathPart?.startsWith("/wiki/") ? pathPart.split("?")[0] : null;
        // absolute interwiki sometimes
        if (!wikiPath && enUrl.includes("/wiki/")) {
          try {
            wikiPath = new URL(enUrl.startsWith("http") ? enUrl : `https:${enUrl}`).pathname;
          } catch {
            wikiPath = null;
          }
        }
        if (wikiPath && enIds.has(wikiPath)) {
          db.markWikiAnnounced(d.id);
          continue;
        }
        if (wikiPath) {
          const bridged = {
            id: `en:${wikiPath}`,
            wikiPath,
            text: d.text + " 🌍",
            url: enUrl.startsWith("http") ? enUrl : `https:${enUrl}`,
            lang: "en",
            fromDe: true,
          };
          const bridgedRow = db
            .getDb()
            .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
            .get(bridged.id);
          if (!db.isWikiSeen(bridged.id)) {
            db.markWikiSeen(bridged);
            newEn.push(bridged);
          } else if (!bridgedRow?.announced_at) {
            newEn.push(bridged);
          }
          db.markWikiAnnounced(d.id);
          continue;
        }
      }
      newDeOnly.push(d);
    }
  }

  console.log(
    new Date().toISOString(),
    `[poll] new EN=${newEn.length} DE-only=${newDeOnly.length} scraped EN=${enEntries.length} DE=${deData.entries.length}`
  );

  if (mode === "seed") {
    db.seedAllWikiSeen([...enEntries, ...deData.entries, ...newEn]);
    return { hits: [], seeded: true };
  }

  if ((mode === "live" || mode === "nightly") && config.channelAllDeaths) {
    for (const e of newEn) {
      try {
        await announceAllDeath(client, config, e, { isDeOnly: false });
        db.markWikiAnnounced(e.id);
      } catch (err) {
        console.error("[poll] all-death EN", err.message);
      }
    }
    for (const e of newDeOnly) {
      try {
        await announceAllDeath(client, config, e, { isDeOnly: true });
        db.markWikiAnnounced(e.id);
      } catch (err) {
        console.error("[poll] all-death DE", err.message);
      }
    }
  } else {
    for (const e of [...newEn, ...newDeOnly]) db.markWikiAnnounced(e.id);
  }

  // Primary: per-celeb death-category check (proven approach from deathlist_checker.py)
  // Secondary: death-list name/URL matching
  let categoryHits = [];
  try {
    categoryHits = await findPoolDeathsByCategory(config.userAgent, { delayMs: 300 });
  } catch (e) {
    console.error("[poll] category check failed", e.message);
  }
  const listHits = findPoolMatches(poolEntries);
  const matches = mergeHits(categoryHits, listHits);
  console.log(
    new Date().toISOString(),
    `[poll] pool hits: category=${categoryHits.length} list=${listHits.length} merged=${matches.length}`
  );

  const hits = [];
  const announce = mode === "live" || mode === "nightly";
  const confirmed = mode === "reconcile";

  for (const m of matches) {
    try {
      console.log(new Date().toISOString(), `[poll] DEATHPOOL HIT (${mode})`, m.celeb.name, m.via || "list");
      const result = await processDeathpoolHit(
        client,
        config,
        { celeb: m.celeb, entry: m.entry, wikiAge: m.age },
        { announce, confirmed, source: mode === "reconcile" ? "reconcile" : "wiki" }
      );
      hits.push({ celeb: m.celeb, entry: m.entry, wikiAge: m.age, result });
    } catch (err) {
      console.error("[poll] deathpool", err.message);
    }
  }

  if (mode === "nightly") {
    await processRetractions(client, config, poolEntries);
  }

  return { hits, seeded: false };
}

function startWikiPoller(client, config) {
  let busy = false;
  let nightlyPending = false;

  const tick = async (forcedMode) => {
    if (busy) {
      if (forcedMode === "nightly") {
        nightlyPending = true;
        console.log("[nightly] deferred — poller busy, will retry after current job");
      }
      return;
    }
    busy = true;
    try {
      if (forcedMode) {
        await runWikiPoll(client, config, { mode: forcedMode });
        return;
      }
      if (!db.isLive()) {
        await runWikiPoll(client, config, { mode: "seed" });
        return;
      }
      await runWikiPoll(client, config, { mode: "live" });
    } catch (e) {
      console.error("[poll] failed", e);
    } finally {
      busy = false;
      if (nightlyPending) {
        nightlyPending = false;
        setImmediate(() => {
          console.log(new Date().toISOString(), "[nightly] running deferred full-year scrape");
          tick("nightly");
        });
      }
    }
  };

  tick("seed").finally(() => {
    const ms = config.wikiPollerMinutes * 60 * 1000;
    setInterval(() => tick(), ms);
  });

  const cron = require("node-cron");
  const hour = Math.min(23, Math.max(0, config.nightlyFullScrapeHour));
  cron.schedule(`0 ${hour} * * *`, () => {
    if (!db.isLive()) {
      console.log("[nightly] skipped (not live)");
      return;
    }
    console.log(new Date().toISOString(), "[nightly] full-year scrape starting");
    tick("nightly");
  });
  console.log(`[nightly] scheduled at hour ${hour}`);
}

module.exports = { runWikiPoll, startWikiPoller, scrapeAll };
