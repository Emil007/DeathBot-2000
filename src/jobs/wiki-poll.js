const { scrapeEn } = require("../wiki/scraper-en");
const { scrapeDe } = require("../wiki/scraper-de");
const { resolveEnglishArticle } = require("../wiki/page-lookup");
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
const ops = require("../ops/status");
const { logEvent, logError } = require("../discord/log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Global poll serialization: runWikiPoll is called both from the scheduled
 * poller tick and directly from admin commands (/check, /go, /ungo). Without a
 * shared lock, a command-triggered poll could overlap the running poller and
 * double-post announcements. enqueuePoll chains every poll behind the previous
 * one so two polls never run concurrently.
 */
let pollQueue = Promise.resolve();

function enqueuePoll(task) {
  const run = pollQueue.then(task);
  pollQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Retry a language scrape that returned 0 entries or threw (e.g. an
 * ENETUNREACH / connect failure mid-poll), so a transient network hiccup
 * doesn't silently empty one language until the next poll. 2 extra tries with
 * backoff + warn-log every retry.
 */
async function scrapeLangRetry(fn, label, { tries = 3 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    let result;
    try {
      result = await fn();
    } catch (e) {
      console.warn(`[wiki] ${label} attempt ${attempt}/${tries} error: ${e.message}`);
      if (attempt < tries) {
        await sleep(700 * attempt + Math.random() * 500);
        continue;
      }
      throw e;
    }
    const count = Array.isArray(result) ? result.length : (result?.entries || []).length;
    if (count === 0 && attempt < tries) {
      console.warn(
        `[wiki] ${label} lieferte 0 Einträge (attempt ${attempt}/${tries}) – Retry mit Backoff`
      );
      await sleep(700 * attempt + Math.random() * 500);
      continue;
    }
    if (count > 0 && attempt > 1) {
      console.log(`[wiki] ${label} nach Retry wieder ${count} Einträge`);
    }
    return result;
  }
}

async function scrapeAll(config, scope = "full") {
  const [enEntries, deData] = await Promise.all([
    scrapeLangRetry(() => scrapeEn(config.userAgent, { scope }), "en"),
    scrapeLangRetry(() => scrapeDe(config.userAgent, { scope }), "de"),
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

    // Prefer category check (same signal as detection); fall back to death-list
    // match. A transient wiki/API error must NEVER count as "confirmed alive":
    // treat it as unknown and defer retraction to the next nightly instead of
    // pulling points back on a false signal.
    let stillDead = null;
    let catError = null;
    try {
      const cat = await celebStillMarkedDead(config.userAgent, celeb);
      if (cat.error) catError = cat.error;
      else stillDead = cat.dead;
    } catch (e) {
      catError = e.message;
    }

    if (stillDead == null && catError) {
      console.log(
        new Date().toISOString(),
        "[retract] category check uncertain — deferring",
        celeb.name,
        catError
      );
      continue;
    }

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
  // All entry points (poller tick + admin commands) funnel through the lock.
  return enqueuePoll(() => runWikiPollUnlocked(client, config, { mode }));
}

async function runWikiPollUnlocked(client, config, { mode = "live" } = {}) {
  const t0 = Date.now();
  ops.markPollStart(mode);
  console.log(new Date().toISOString(), `[poll] mode=${mode}`);
  try {
    const result = await runWikiPollInner(client, config, { mode });
    ops.markPollEnd(mode, {
      ok: true,
      durationMs: Date.now() - t0,
      stats: result.stats || null,
    });
    return result;
  } catch (e) {
    ops.markPollEnd(mode, {
      ok: false,
      durationMs: Date.now() - t0,
      error: e.message,
    });
    throw e;
  }
}

async function runWikiPollInner(client, config, { mode = "live" } = {}) {
  const scope = mode === "live" ? "recent" : "full";
  const { enEntries, deData, poolEntries } = await scrapeAll(config, scope);

  const enIds = new Set(enEntries.map((e) => e.wikiPath));
  const newEn = [];

  for (const e of enEntries) {
    // Retry entries whose announce failed on an earlier poll: isWikiSeen alone
    // isn't enough — a row stays "seen" without announced_at when the Discord
    // send throws, and it would otherwise be silently skipped forever. Mirror
    // the DE / bridged handling below (check announced_at, not just seen).
    const row = db
      .getDb()
      .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
      .get(e.id);
    if (row?.announced_at) continue;
    db.markWikiSeen(e);
    newEn.push(e);
  }

  for (const d of deData.entries) {
    if (!db.isWikiSeen(d.id)) db.markWikiSeen(d);
  }

  const newDeOnly = [];

  // DE entries that map to an EN article (already scraped this poll, or bridged
  // via interwiki) must NOT be stamped announced until their EN entry is
  // confirmed announced. Otherwise a failed EN post (transient Discord/network
  // error) would silently drop the person: DE is marked announced, never
  // retried, while the EN row stays un-announced.
  const deferredDeEn = [];
  const deferDeForEn = (deEntry, enId) => deferredDeEn.push({ deId: deEntry.id, enId });

  if (mode !== "seed") {
    for (const d of deData.entries) {
      const row = db
        .getDb()
        .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
        .get(d.id);
      if (row?.announced_at) continue;

      let enUrl = null;
      let enResolveError = null;
      if (d.redName) {
        // No own article: pageUrl is only a research target (band/party/occupation).
        // A DE→EN bridge from it would wrongly announce the band as the person.
      } else {
        try {
          enUrl = await resolveEnglishArticle(config.userAgent, d.url);
        } catch (e) {
          enResolveError = e;
        }
      }
      if (enResolveError) {
        // Transient resolver failure ≠ "no EN variant": deferring keeps the
        // EN-first rule intact (a hiccup must not push a DE entry to DE-only).
        // Not stamped → retried on the next poll.
        console.log(
          new Date().toISOString(),
          "[poll] en-resolve failed — deferring DE",
          d.id,
          enResolveError.message
        );
        continue;
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
        if (wikiPath) {
          const enId = `en:${wikiPath}`;
          const enRow = db
            .getDb()
            .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
            .get(enId);
          if (enIds.has(wikiPath)) {
            if (enRow?.announced_at) {
              // EN was announced on an earlier poll → DE is safe to stamp now.
              db.markWikiAnnounced(d.id);
            } else if (mode === "reconcile") {
              db.markWikiAnnounced(d.id);
            } else {
              // EN is being announced THIS poll → stamp DE only after EN really
              // sent (survives a failed EN post: both stay un-announced, retried
              // next poll instead of silently dropping the person).
              deferDeForEn(d, enId);
            }
            continue;
          }
          const bridged = {
            id: enId,
            wikiPath,
            text: d.text + " 🌍",
            url: enUrl.startsWith("http") ? enUrl : `https:${enUrl}`,
            lang: "en",
            fromDe: true,
            // F19: liste mitführen, damit eine Nicht-Personen-Karte NICHT auf die
            // Research-URL fällt, sondern auf die DE-Liste verlinkt.
            ...(d.listUrl ? { listUrl: d.listUrl } : {}),
            // DE death date + Nekrolog-URL year, else the EN card shows the current year
            ...(d.day != null ? { day: d.day } : {}),
            ...(d.month != null ? { month: d.month } : {}),
            ...(d.year != null ? { year: d.year } : {}),
          };
          const bridgedRow = db
            .getDb()
            .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
            .get(bridged.id);
          if (!db.isWikiSeen(bridged.id)) {
            db.markWikiSeen(bridged);
            newEn.push(bridged);
            if (mode === "reconcile") db.markWikiAnnounced(d.id);
            else deferDeForEn(d, enId);
          } else if (!bridgedRow?.announced_at) {
            newEn.push(bridged);
            if (mode === "reconcile") db.markWikiAnnounced(d.id);
            else deferDeForEn(d, enId);
          } else {
            // bridged EN already announced earlier → DE safe to stamp now.
            db.markWikiAnnounced(d.id);
          }
          continue;
        }
      }
      newDeOnly.push(d);
    }
  }

  // Dedup queued EN cards by id: the same interwiki target can be resolved from
  // several DE rows in one poll (shared EN article), which previously posted the
  // same card multiple times.
  const uniqueNewEn = [];
  {
    const seenEnIds = new Set();
    for (const e of newEn) {
      if (seenEnIds.has(e.id)) continue;
      seenEnIds.add(e.id);
      uniqueNewEn.push(e);
    }
  }

  console.log(
    new Date().toISOString(),
    `[poll] new EN=${uniqueNewEn.length} DE-only=${newDeOnly.length} scraped EN=${enEntries.length} DE=${deData.entries.length}`
  );

  if (mode === "seed") {
    db.seedAllWikiSeen([...enEntries, ...deData.entries, ...uniqueNewEn]);
    return {
      hits: [],
      seeded: true,
      stats: {
        scrapedEn: enEntries.length,
        scrapedDe: deData.entries.length,
        newEn: 0,
        newDe: 0,
        hits: 0,
      },
    };
  }

  if ((mode === "live" || mode === "nightly") && config.channelAllDeaths) {
    // M2: Identitäten einmal pro Kandidat auflösen, dann deduplicieren.
    const { planAnnouncements } = require("../wiki/announce-dedup");
    const { fetchDeathBrief } = require("../wiki/death-brief");

    const candidates = [...uniqueNewEn, ...newDeOnly];
    // Nur Einträge, deren EN-Pendant NICHT schon in diesem Poll gedealt wird,
    // und die nicht bereits gestempelt sind, bekommen eine eigene brief-Auflösung.
    const deferredIds = new Set(deferredDeEn.map((t) => t.deId));
    const resolvable = candidates.filter((e) => !deferredIds.has(e.id));

    const history = db.recentAnnouncedIdentities(
      new Date(Date.now() - config.deathConfirmDays * 2 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
    );

    const resolvedEntries = [];
    for (const e of resolvable) {
      if (e.resolved) {
        resolvedEntries.push(e);
        continue;
      }
      let brief = null;
      try {
        brief = await fetchDeathBrief(e.url, config.userAgent, {
          listText: e.text,
          beruf: e.beruf || null,
          redName: !!e.redName,
        });
        e.resolved = {
          qid: brief.qid || null,
          isHuman: brief.isHuman ?? null,
          url: brief.url || e.url,
          pageMissing: !!brief.pageMissing,
          error: null,
        };
        e.brief = brief;
      } catch (err) {
        e.resolved = { qid: null, isHuman: null, url: e.url, pageMissing: false, error: err.message };
        console.warn("[poll] brief resolve failed", e.id, err.message);
      }
      resolvedEntries.push(e);
    }

    const { post, bind, defer } = planAnnouncements(resolvedEntries, history);
    for (const d of defer) {
      console.log(
        new Date().toISOString(),
        "[poll] deferring (resolve error) — not stamped",
        d.id
      );
    }

    for (const e of post) {
      try {
        await announceAllDeath(client, config, e, {
          isDeOnly: e.lang === "de",
          brief: e.brief || undefined,
        });
        db.markWikiAnnounced(e.id, null, e.resolved?.qid || null);
      } catch (err) {
        console.error("[poll] all-death", e.lang, err.message);
      }
    }
    // Verlierer erst stempeln, wenn ihr Gewinner wirklich gesendet wurde.
    for (const b of bind) {
      if (b.loserId === b.winnerId) {
        // historisch bereits gepostet — nicht erneut posten, nur sicher stempeln
        db.markWikiAnnounced(b.loserId);
        await logEvent(client, config, {
          kind: "announce-suppress",
          summary: `Karte unterdrückt (${b.reason || "?"}): ${b.loserId}`,
          detail: b.loserId === b.winnerId ? "bereits in einer früheren Runde gepostet" : undefined,
        }).catch(() => {});
        continue;
      }
      const winnerRow = db
        .getDb()
        .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
        .get(b.winnerId);
      if (winnerRow?.announced_at) {
        db.markWikiAnnounced(b.loserId);
        await logEvent(client, config, {
          kind: "announce-suppress",
          summary: `Karte unterdrückt (${b.reason || "?"}): ${b.loserId} → ${b.winnerId}`,
        }).catch(() => {});
      }
    }
    // DE-nur-Verlierer der EN-Brücke wie bisher (deferredDeEn) nachziehen.
    for (const t of deferredDeEn) {
      const enRow = db
        .getDb()
        .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
        .get(t.enId);
      if (enRow?.announced_at) db.markWikiAnnounced(t.deId);
    }
  } else {
    for (const e of [...uniqueNewEn, ...newDeOnly]) db.markWikiAnnounced(e.id);
    // Non-announce modes stamp deferred DE too (their EN is treated as announced).
    for (const t of deferredDeEn) db.markWikiAnnounced(t.deId);
  }

  // Primary: per-celeb death-category check (proven approach from deathlist_checker.py)
  // Secondary: death-list name/URL matching
  let categoryHits = [];
  try {
    categoryHits = await findPoolDeathsByCategory(config.userAgent, {
      delayMs: 300,
      seasonStartDate: db.getActiveSeason().start_date,
    });
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
      ops.noteError(`deathpool ${m.celeb.name}: ${err.message}`);
      await logError(client, config, err, { where: "deathpool " + m.celeb.name }).catch(
        () => {}
      );
    }
  }

  if (mode === "nightly") {
    await processRetractions(client, config, poolEntries);
  }

  // M2+: Pre-Start-Todeswarnungen für announced-Picks (bis Saisonstart).
  // Nach jeder Deathpool-Verarbeitung, damit frisch entdeckte(e) Tode dem
  // Einreicher sofort per DM gemeldet werden — unabhängig vom Poll-Modus.
  let warned = 0;
  try {
    const { warnAnnouncedPreStartDeaths } = require("../discord/pick-assistant");
    warned = await warnAnnouncedPreStartDeaths({ client, config });
    if (warned) {
      console.log(new Date().toISOString(), `[poll] pre-start death warnings sent: ${warned}`);
    }
  } catch (e) {
    console.warn("[poll] pre-start death warn failed", e.message);
  }

  return {
    hits,
    seeded: false,
    stats: {
      scrapedEn: enEntries.length,
      scrapedDe: deData.entries.length,
      newEn: uniqueNewEn.length,
      newDe: newDeOnly.length,
      categoryHits: categoryHits.length,
      listHits: listHits.length,
      hits: hits.length,
    },
  };
}

function startWikiPoller(client, config) {
  let busy = false;
  let nightlyPending = false;

  const tick = async (forcedMode) => {
    if (busy) {
      if (forcedMode === "nightly") {
        nightlyPending = true;
        ops.setNightlyPending(true);
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
      ops.noteError(`poller: ${e.message}`);
    } finally {
      busy = false;
      if (nightlyPending) {
        nightlyPending = false;
        ops.setNightlyPending(false);
        setImmediate(() => {
          console.log(new Date().toISOString(), "[nightly] running deferred full-year scrape");
          tick("nightly");
        });
      }
    }
  };

  // Boot: only seed when the pool is not yet live (fresh setup / pre-live). For
  // an already-live bot a full seed here would stamp everything without
  // announced_at to EPOCH — including deaths that appeared while the container
  // was down — silently swallowing them as "already announced" and losing real
  // posts. tick() without an argument already branches on db.isLive(), so a
  // live restart now drains new deaths through a normal live poll instead.
  tick().finally(() => {
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
