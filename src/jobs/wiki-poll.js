const { scrapeEn } = require("../wiki/scraper-en");
const { scrapeDe } = require("../wiki/scraper-de");
const { findPoolMatches } = require("../wiki/match");
const db = require("../db");
const { announceDeathpool, announceAllDeath } = require("../discord/announce");

async function runWikiPoll(client, config, { seedOnly = false } = {}) {
  console.log(new Date().toISOString(), "[poll] starting wiki scrape…");
  const [enEntries, deData] = await Promise.all([
    scrapeEn(config.userAgent),
    scrapeDe(config.userAgent),
  ]);

  const enIds = new Set(enEntries.map((e) => e.wikiPath));
  const newEn = [];
  const newDeOnly = [];

  for (const e of enEntries) {
    if (db.isWikiSeen(e.id)) continue;
    db.markWikiSeen(e);
    newEn.push(e);
  }

  for (const d of deData.entries) {
    if (db.isWikiSeen(d.id)) continue;
    db.markWikiSeen(d);

    let enUrl = null;
    try {
      enUrl = await deData.resolveEnglish(d.url);
    } catch {
      /* ignore */
    }

    if (enUrl) {
      const path = enUrl.includes("wikipedia.org")
        ? "/" + enUrl.split("wikipedia.org")[1].replace(/^\/+/, "")
        : null;
      const wikiPath = path?.startsWith("/wiki/") ? path : null;
      if (wikiPath && enIds.has(wikiPath)) {
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
        if (!db.isWikiSeen(bridged.id)) {
          db.markWikiSeen(bridged);
          newEn.push(bridged);
        }
        continue;
      }
    }
    newDeOnly.push(d);
  }

  console.log(
    new Date().toISOString(),
    `[poll] new EN=${newEn.length} DE-only=${newDeOnly.length} (seedOnly=${seedOnly})`
  );

  if (seedOnly) {
    // First run: mark everything seen so all-deaths doesn't spam history
    for (const e of [...newEn, ...newDeOnly]) {
      db.markWikiAnnounced(e.id);
    }
  } else if (config.channelAllDeaths) {
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

  // Deathpool matching always runs (including first boot after imports)
  const poolEntries = [...enEntries, ...deData.entries];
  const matches = findPoolMatches(poolEntries);
  for (const m of matches) {
    try {
      console.log(new Date().toISOString(), "[poll] DEATHPOOL HIT", m.celeb.name);
      await announceDeathpool(client, config, m);
    } catch (err) {
      console.error("[poll] deathpool announce", err.message);
    }
  }
}

function startWikiPoller(client, config) {
  let seeding = true;
  runWikiPoll(client, config, { seedOnly: true })
    .catch((e) => console.error("[poll] seed failed", e))
    .finally(() => {
      seeding = false;
    });

  const ms = config.wikiPollerMinutes * 60 * 1000;
  setInterval(() => {
    if (seeding) return;
    runWikiPoll(client, config, { seedOnly: false }).catch((e) =>
      console.error("[poll] failed", e)
    );
  }, ms);
}

module.exports = { runWikiPoll, startWikiPoller };
