const scraperEn = require("../wiki/scraper-en");
const scraperDe = require("../wiki/scraper-de");
const pageLookup = require("../wiki/page-lookup");
const match = require("../wiki/match");
const categoryDeath = require("../wiki/category-death");
const deathBrief = require("../wiki/death-brief");
const announceDedup = require("../wiki/announce-dedup");
const db = require("../db");
const announce = require("../discord/announce");
const presence = require("../discord/presence");
const ops = require("../ops/status");
const log = require("../discord/log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldEventLoop = () => new Promise((r) => setImmediate(r));

/** Seen-Scan und Karten-Nebenläufe geben alle 400 Einträge den Event-Loop frei. */
async function yieldEvery(index) {
  if (index > 0 && index % 400 === 0) await yieldEventLoop();
}

const CHANNEL_ERROR_CODES = new Set([10003, 50001, 50013]);
const SEEN_BLOCK = 400;

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

function errorCode(err) {
  const raw = err?.code ?? err?.rawError?.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 429/5xx/Timeout und eine nicht verfügbare Guild sind „unavailable“, nie „lebt“ oder „Kanal fehlt“. */
function guildUnavailable(client) {
  const cache = client?.guilds?.cache;
  if (!cache || typeof cache.values !== "function") return false;
  for (const g of cache.values()) {
    if (g && g.available === false) return true;
  }
  return false;
}

function timeApi() {
  try {
    const t = require("../db/time");
    if (typeof t.calendarDate === "function" && typeof t.addCalendarDays === "function") return t;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return {
    calendarDate: calendarDateFallback,
    addCalendarDays: addCalendarDaysFallback,
  };
}

function asDate(instant) {
  if (instant instanceof Date) return instant;
  if (typeof instant === "number") return new Date(instant);
  const s = String(instant ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(" ", "T") + "Z");
  return new Date(s);
}

function calendarDateFallback(instant, timeZone) {
  const d = asDate(instant);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addCalendarDaysFallback(yyyyMmDd, n) {
  const [y, m, d] = String(yyyyMmDd).split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeTextApi() {
  try {
    const t = require("../discord/safe-text");
    if (typeof t.mentionOpts === "function" && typeof t.sanitizeDisplayName === "function") return t;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return {
    mentionOpts: () => ({ allowedMentions: { parse: [] } }),
    sanitizeDisplayName: sanitizeDisplayNameFallback,
  };
}

function sanitizeDisplayNameFallback(raw) {
  let s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_~|`<>@\[\]()]/g, "");
  s = s.replace(/\s+/g, " ").trim().slice(0, 80);
  return s || "Unbenannt";
}

function getWithWikiSlot() {
  try {
    const gate = require("../wiki/gate");
    if (typeof gate.withWikiSlot === "function") return gate.withWikiSlot;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return (fn) => fn();
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

async function scrapeAll(config, scope = "full", now = new Date()) {
  const [enEntries, deData] = await Promise.all([
    scrapeLangRetry(
      () => scraperEn.scrapeEn(config.userAgent, { scope, tz: config.tz, now }),
      "en"
    ),
    scrapeLangRetry(
      () => scraperDe.scrapeDe(config.userAgent, { scope, tz: config.tz, now }),
      "de"
    ),
  ]);
  const deEntries = deData?.entries || [];
  return { enEntries, deData: deData || { entries: deEntries }, poolEntries: [...enEntries, ...deEntries] };
}

/**
 * QID-Historie ohne Zeitfenster. Namen bleiben leer: der Dedup darf Personen
 * nicht über historische Nicht-Personen-Namen verschlucken (F16).
 * ANNAHME: solange M3 `recentAnnouncedQids` nicht exportiert, liest der Poll
 * dieselbe fensterlose Menge direkt aus announced_deaths.
 */
function qidHistory() {
  if (typeof db.recentAnnouncedQids === "function") return db.recentAnnouncedQids();
  const rows = db
    .getDb()
    .prepare("SELECT qid FROM announced_deaths WHERE qid IS NOT NULL AND TRIM(qid) != ''")
    .all();
  return new Set(rows.map((r) => r.qid));
}

function canAutoBook(celeb) {
  return !!celeb && Number(celeb.wiki_confirmed) === 1 && Number(celeb.exclude_from_auto) === 0;
}

function loadAliasMaps(database) {
  const akaById = new Map();
  const blacklistById = new Map();
  const akaStmt = database.prepare("SELECT celeb_id, alias FROM celeb_aka");
  for (const row of akaStmt.all()) {
    let list = akaById.get(row.celeb_id);
    if (!list) akaById.set(row.celeb_id, (list = []));
    list.push(row.alias);
  }
  const blStmt = database.prepare("SELECT celeb_id, term FROM celeb_blacklist");
  for (const row of blStmt.all()) {
    let list = blacklistById.get(row.celeb_id);
    if (!list) blacklistById.set(row.celeb_id, (list = []));
    list.push(row.term);
  }
  return { akaById, blacklistById };
}

/**
 * Statements einmal pro Lauf. M3 kapselt markWikiSeen/markWikiAnnounced noch
 * nicht (prepare sitzt in der Funktion). Die Transaktion um announced_at +
 * announced_deaths bleibt bei jedem Stempel, seedAllWikiSeen behält ihre eigene.
 */
function createWikiStamp(database) {
  const selectOne = database.prepare(
    "SELECT entry_id, announced_at FROM wiki_seen WHERE entry_id = ?"
  );
  const insertSeen = database.prepare(
    `INSERT OR IGNORE INTO wiki_seen (entry_id, lang, text, url, qid) VALUES (?, ?, ?, ?, ?)`
  );
  const selectAnn = database.prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?");
  const updateAnn = database.prepare(
    `UPDATE wiki_seen SET announced_at = ?, qid = COALESCE(?, qid) WHERE entry_id = ?`
  );
  const insertDeath = database.prepare(
    `INSERT OR IGNORE INTO announced_deaths (entry_id, name, url, lang, qid, announced_at)
     SELECT entry_id, text, url, lang, COALESCE(?, qid), ? FROM wiki_seen WHERE entry_id = ?`
  );
  const nowStmt = database.prepare("SELECT datetime('now') AS t");
  const announceTx = database.transaction((entryId, at, qid) => {
    const existing = selectAnn.get(entryId);
    if (!existing || existing.announced_at) return null;
    const ts = at || nowStmt.get().t;
    updateAnn.run(ts, qid ?? null, entryId);
    insertDeath.run(qid ?? null, ts, entryId);
    return ts;
  });
  // id -> { announced_at } | null (null = nachgesehen, nicht in der Tabelle)
  const seenState = new Map();

  function rememberRow(id, announcedAt) {
    seenState.set(id, { announced_at: announcedAt ?? null });
  }

  function lookup(id) {
    if (seenState.has(id)) return seenState.get(id);
    const row = selectOne.get(id);
    if (!row) {
      seenState.set(id, null);
      return null;
    }
    const state = { announced_at: row.announced_at ?? null };
    seenState.set(id, state);
    return state;
  }

  function isSeen(id) {
    return !!lookup(id);
  }

  function isAnnounced(id) {
    const state = lookup(id);
    return !!(state && state.announced_at);
  }

  function markSeen(entry) {
    insertSeen.run(
      entry.id,
      entry.lang || null,
      entry.text || null,
      entry.url || null,
      entry.qid || entry.resolved?.qid || null
    );
    if (!seenState.get(entry.id)) seenState.set(entry.id, { announced_at: null });
  }

  function markAnnounced(entryId, at = null, qid = null) {
    const ts = announceTx(entryId, at, qid);
    if (ts) seenState.set(entryId, { announced_at: ts });
    return ts;
  }

  return { rememberRow, isSeen, isAnnounced, markSeen, markAnnounced, seenState };
}

async function loadSeenBlocks(database, ids, stamp) {
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += SEEN_BLOCK) {
    if (i > 0) await yieldEventLoop();
    const block = unique.slice(i, i + SEEN_BLOCK);
    const stmt = database.prepare(
      `SELECT entry_id, announced_at FROM wiki_seen WHERE entry_id IN (${block.map(() => "?").join(",")})`
    );
    const found = new Set();
    for (const row of stmt.all(...block)) {
      found.add(row.entry_id);
      stamp.rememberRow(row.entry_id, row.announced_at ?? null);
    }
    for (const id of block) {
      if (!found.has(id)) stamp.seenState.set(id, null);
    }
  }
}

function resolveScope(mode) {
  // Nicht live und der erste Jahres-Seed ist durch: nur noch das recente Fenster,
  // nicht noch einmal das ganze Jahr.
  if (!db.isLive() && db.getMeta("wiki_seeded_at")) return "recent";
  if (mode === "live") return "recent";
  return "full";
}

function withinRetractWindow(celeb, config, now) {
  const { calendarDate, addCalendarDays } = timeApi();
  const today = calendarDate(asDate(now), config.tz);
  if (!today) return false;
  let detected = celeb.death_detected_at
    ? calendarDate(asDate(celeb.death_detected_at), config.tz)
    : today;
  if (!detected || !/^\d{4}-\d{2}-\d{2}$/.test(detected)) detected = today;
  const days = Number(config.deathConfirmDays);
  const n = Number.isFinite(days) ? days : 7;
  const deadline = addCalendarDays(detected, n);
  if (!deadline) return false;
  return today <= deadline;
}

async function resendPendingRetractions(client, config) {
  if (typeof db.listPendingRetractions !== "function") return;
  if (guildUnavailable(client)) {
    console.error("[retract] Discord guild unavailable — pending retractions deferred");
    return;
  }
  let rows = [];
  try {
    rows = db.listPendingRetractions() || [];
  } catch (e) {
    console.error("[retract] listPendingRetractions failed", e.message);
    return;
  }
  if (!rows.length) return;
  const channelId = db.resolveDeathpoolChannel(config);
  const channel =
    channelId && client?.channels?.fetch
      ? await client.channels.fetch(channelId).catch(() => null)
      : null;
  if (!channel?.isTextBased?.()) return;
  for (const row of rows) {
    const celeb = row.celeb || row;
    if (!celeb?.id) continue;
    const awards = row.awards || [];
    try {
      await announce.announceRetraction(client, config, { celeb, awards });
      if (typeof db.markRetractionAnnounced === "function") db.markRetractionAnnounced(celeb.id);
    } catch (e) {
      console.error("[retract] announce", e.message);
    }
  }
}

async function processRetractions(client, config, poolEntries, categoryByCeleb, akaById, blacklistById, now) {
  const pending = db.getUnconfirmedDeaths();
  if (!pending.length) return;

  for (let i = 0; i < pending.length; i++) {
    await yieldEvery(i);
    const celeb = pending[i];
    const cat = categoryByCeleb.get(celeb.id);
    let stillDead = null;
    let catError = null;
    if (cat) {
      if (cat.error) catError = cat.error;
      else stillDead = !!cat.dead;
    } else {
      try {
        const checked = await categoryDeath.celebStillMarkedDead(config.userAgent, celeb);
        if (checked?.error) catError = checked.error;
        else stillDead = !!checked?.dead;
      } catch (e) {
        catError = e.message;
      }
    }

    // error (429/5xx/Timeout) ist unavailable: weder Retract noch Confirm.
    if (catError || stillDead == null) {
      console.log(
        new Date().toISOString(),
        "[retract] category check uncertain — deferring",
        celeb.name,
        catError || "unknown"
      );
      continue;
    }

    if (!stillDead && poolEntries?.length) {
      const akas = akaById.get(celeb.id) || [];
      const blacklist = blacklistById.get(celeb.id) || [];
      stillDead = poolEntries.some((entry) =>
        match.entryMatchesCeleb(entry, celeb, akas, blacklist)
      );
    }

    const inWindow = withinRetractWindow(celeb, config, now);

    if (!stillDead) {
      if (!inWindow) {
        console.log(
          new Date().toISOString(),
          "[retract] window closed — not retracting",
          celeb.name
        );
        continue;
      }
      console.log(new Date().toISOString(), "[retract]", celeb.name);
      const result = db.retractDeath(celeb.id);
      if (result && db.isLive()) {
        if (guildUnavailable(client)) {
          console.error("[retract] Discord guild unavailable — announcement deferred");
          continue;
        }
        try {
          await announce.announceRetraction(client, config, result);
          if (typeof db.markRetractionAnnounced === "function") {
            db.markRetractionAnnounced(celeb.id);
          }
        } catch (e) {
          console.error("[retract] announce", e.message);
        }
      }
      continue;
    }

    if (!inWindow) {
      console.log(new Date().toISOString(), "[confirm]", celeb.name);
      db.confirmDeath(celeb.id);
    }
  }
}

function mergeHits(categoryHits, listHits) {
  const byId = new Map();
  for (const h of [...categoryHits, ...listHits]) {
    if (h?.celeb && !byId.has(h.celeb.id)) byId.set(h.celeb.id, h);
  }
  return [...byId.values()];
}

/**
 * ANNAHME: Retract-Kandidaten laufen im selben findDeathsByCategory-Aufruf mit,
 * damit ein error-Ergebnis den Retract sperrt, ohne einen zweiten Scan.
 */
function celebsForCategoryScan() {
  const map = new Map();
  const add = (list) => {
    for (const c of list || []) {
      if (c && c.id != null && !map.has(c.id)) map.set(c.id, c);
    }
  };
  add(db.getAliveCelebsForAuto());
  if (typeof db.getAliveCelebsForAnnounced === "function") add(db.getAliveCelebsForAnnounced());
  add(db.getUnconfirmedDeaths());
  return [...map.values()];
}

function categoryEntry(celeb, result) {
  const url = result.url || celeb.wiki_url || celeb.wiki_url_de || null;
  let year = null;
  if (result.category && typeof categoryDeath.parseDeathYear === "function") {
    year = categoryDeath.parseDeathYear(result.category);
  }
  let wikiPath = null;
  if (url) {
    try {
      wikiPath = new URL(url).pathname;
    } catch {
      wikiPath = null;
    }
  }
  return {
    id: `cat:${celeb.id}:${url || ""}`,
    wikiPath,
    text: `${celeb.name} (${result.category || "death category"})`,
    url,
    lang: result.lang || (url && /de\.wikipedia/i.test(url) ? "de" : "en"),
    year: year ?? null,
    month: year != null ? 11 : null,
    day: year != null ? 31 : null,
  };
}

function normalizeListHit(hit, celebById) {
  if (!hit) return null;
  const celeb = hit.celeb || (hit.celebId != null ? celebById.get(hit.celebId) : null);
  if (!celeb) return null;
  const entry = hit.entry || {
    id: `list:${celeb.id}`,
    text: hit.text || celeb.name,
    url: hit.url || celeb.wiki_url || null,
    lang: hit.lang || "en",
    wikiPath: hit.wikiPath || null,
  };
  return {
    celeb,
    entry,
    age: hit.age ?? hit.wikiAge ?? celeb.age_at_pick ?? null,
    via: hit.via || "list",
  };
}

function listHitsFor(celebs, entries, mode, akaById, blacklistById) {
  const celebById = new Map(celebs.map((c) => [c.id, c]));
  if (typeof match.buildPoolIndex === "function" && typeof match.matchEntriesToIndex === "function") {
    const index = match.buildPoolIndex(celebs, { akaById, blacklistById });
    const raw = match.matchEntriesToIndex(index, entries, { mode }) || [];
    return raw.map((h) => normalizeListHit(h, celebById)).filter(Boolean);
  }
  // ANNAHME: bis M10 den Index exportiert, bleibt der bisherige Listen-Match.
  if (mode === "auto" && typeof match.findPoolMatches === "function") {
    return match.findPoolMatches(entries) || [];
  }
  if (mode === "announced" && typeof match.findPoolMatchesForAnnounced === "function") {
    return match.findPoolMatchesForAnnounced(entries) || [];
  }
  return [];
}

function rememberCategory(byCeleb, id, result) {
  if (id == null) return;
  byCeleb.set(id, result);
  const n = Number(id);
  if (Number.isFinite(n)) byCeleb.set(n, result);
  byCeleb.set(String(id), result);
}

function celebFrom(celebById, id) {
  if (celebById.has(id)) return celebById.get(id);
  const n = Number(id);
  if (Number.isFinite(n) && celebById.has(n)) return celebById.get(n);
  const s = String(id);
  for (const [key, celeb] of celebById) {
    if (String(key) === s) return celeb;
  }
  return null;
}

function idIn(set, id) {
  if (set.has(id)) return true;
  const n = Number(id);
  if (Number.isFinite(n) && set.has(n)) return true;
  const s = String(id);
  for (const key of set) {
    if (String(key) === s) return true;
  }
  return false;
}

function splitCategoryResults(results, autoIds, announcedIds, celebById) {
  const byCeleb = new Map();
  const autoHits = [];
  const announcedHits = [];
  for (const r of results || []) {
    const id = r.celebId ?? r.celeb?.id;
    if (id == null) continue;
    rememberCategory(byCeleb, id, r);
    if (r.error) continue;
    if (!r.dead) continue;
    const celeb = celebFrom(celebById, id);
    if (!celeb || Number(celeb.is_alive) !== 1) continue;
    const hit = {
      celeb,
      entry: categoryEntry(celeb, r),
      age: celeb.age_at_pick ?? null,
      via: "category",
    };
    if (idIn(autoIds, celeb.id)) autoHits.push(hit);
    else if (idIn(announcedIds, celeb.id)) announcedHits.push(hit);
  }
  return { byCeleb, autoHits, announcedHits };
}

async function mapLimit(items, limit, fn) {
  if (!items.length) return;
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i];
      await yieldEvery(i);
      await fn(item, i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function resolveBriefs(entries, config) {
  const slot = getWithWikiSlot();
  await mapLimit(entries, 3, async (e) => {
    if (e.resolved) return;
    await slot(async () => {
      try {
        const brief = await deathBrief.fetchDeathBrief(e.url, config.userAgent, {
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
        e.resolved = {
          qid: null,
          isHuman: null,
          url: e.url,
          pageMissing: false,
          error: err.message,
        };
        console.warn("[poll] brief resolve failed", e.id, err.message);
      }
    });
  });
}

async function bumpPresenceOnce(client, config, posted) {
  if (posted > 0 && typeof presence.readDayCount === "function") {
    const before = presence.readDayCount(db, config.tz);
    db.setMeta(
      "alldeaths_day_count",
      JSON.stringify({ date: before.date, count: before.count + posted })
    );
  }
  if (typeof presence.refreshPresence === "function") {
    await presence.refreshPresence(client, config, db);
  }
}

/**
 * Bereits gebuchte, aber nie gepostete Deathpool-Tode nachreichen.
 * Nur wenn der Kanal wirklich auflösbar ist. ANNAHME: die Funktion lebt im Poll;
 * M3 liefert listUnannouncedDeaths / markDeathAnnounced.
 */
async function replayUnannounced(client, config) {
  if (typeof db.listUnannouncedDeaths !== "function") return 0;
  if (typeof db.markDeathAnnounced !== "function") return 0;
  if (guildUnavailable(client)) {
    console.error("[poll] Discord guild unavailable — unannounced deaths deferred");
    return 0;
  }
  const channelId = db.resolveDeathpoolChannel(config);
  if (!channelId || !client?.channels?.fetch) return 0;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return 0;
  let rows = [];
  try {
    rows = db.listUnannouncedDeaths() || [];
  } catch (e) {
    console.error("[poll] listUnannouncedDeaths failed", e.message);
    return 0;
  }
  const { mentionOpts, sanitizeDisplayName } = safeTextApi();
  let n = 0;
  for (const celeb of rows) {
    if (!celeb?.id) continue;
    try {
      const name = sanitizeDisplayName(celeb.name);
      await channel.send({
        content: `**Deathpool-Treffer** — ${name}`,
        ...mentionOpts(),
      });
      db.markDeathAnnounced(celeb.id);
      n++;
    } catch (e) {
      console.error("[poll] replay unannounced", celeb.name, e.message);
    }
  }
  return n;
}

/**
 * @param {'seed'|'reconcile'|'live'|'nightly'} mode
 */
async function runWikiPoll(client, config, { mode = "live" } = {}) {
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
  const now = new Date();
  await resendPendingRetractions(client, config);

  const scope = resolveScope(mode);
  const { enEntries, deData, poolEntries } = await scrapeAll(config, scope, now);
  const deEntries = deData.entries || [];

  const database = db.getDb();
  const stamp = createWikiStamp(database);
  await loadSeenBlocks(
    database,
    [...enEntries.map((e) => e.id), ...deEntries.map((d) => d.id)],
    stamp
  );

  const enIds = new Set(enEntries.map((e) => e.wikiPath));
  const newEn = [];

  for (let i = 0; i < enEntries.length; i++) {
    await yieldEvery(i);
    const e = enEntries[i];
    // Retry entries whose announce failed on an earlier poll: isWikiSeen alone
    // isn't enough — a row stays "seen" without announced_at when the Discord
    // send throws, and it would otherwise be silently skipped forever.
    if (stamp.isAnnounced(e.id)) continue;
    stamp.markSeen(e);
    newEn.push(e);
  }

  for (let i = 0; i < deEntries.length; i++) {
    await yieldEvery(i);
    const d = deEntries[i];
    if (!stamp.isSeen(d.id)) stamp.markSeen(d);
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
    for (let i = 0; i < deEntries.length; i++) {
      await yieldEvery(i);
      const d = deEntries[i];
      if (stamp.isAnnounced(d.id)) continue;

      let enUrl = null;
      let enResolveError = null;
      if (d.redName) {
        // No own article: pageUrl is only a research target (band/party/occupation).
        // A DE→EN bridge from it would wrongly announce the band as the person.
      } else {
        try {
          enUrl = await pageLookup.resolveEnglishArticle(config.userAgent, d.url);
        } catch (e) {
          enResolveError = e;
        }
      }
      if (enResolveError) {
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
        if (!wikiPath && enUrl.includes("/wiki/")) {
          try {
            wikiPath = new URL(enUrl.startsWith("http") ? enUrl : `https:${enUrl}`).pathname;
          } catch {
            wikiPath = null;
          }
        }
        if (wikiPath) {
          const enId = `en:${wikiPath}`;
          if (enIds.has(wikiPath)) {
            if (stamp.isAnnounced(enId)) {
              stamp.markAnnounced(d.id);
            } else if (mode === "reconcile") {
              stamp.markAnnounced(d.id);
            } else {
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
            ...(d.listUrl ? { listUrl: d.listUrl } : {}),
            ...(d.day != null ? { day: d.day } : {}),
            ...(d.month != null ? { month: d.month } : {}),
            ...(d.year != null ? { year: d.year } : {}),
          };
          if (!stamp.isSeen(bridged.id)) {
            stamp.markSeen(bridged);
            newEn.push(bridged);
            if (mode === "reconcile") stamp.markAnnounced(d.id);
            else deferDeForEn(d, enId);
          } else if (!stamp.isAnnounced(bridged.id)) {
            newEn.push(bridged);
            if (mode === "reconcile") stamp.markAnnounced(d.id);
            else deferDeForEn(d, enId);
          } else {
            stamp.markAnnounced(d.id);
          }
          continue;
        }
      }
      newDeOnly.push(d);
    }
  }

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
    `[poll] new EN=${uniqueNewEn.length} DE-only=${newDeOnly.length} scraped EN=${enEntries.length} DE=${deEntries.length}`
  );

  if (mode === "seed") {
    const already = db.getMeta("wiki_seeded_at");
    if (!already) {
      db.seedAllWikiSeen([...enEntries, ...deEntries, ...uniqueNewEn]);
      db.setMeta("wiki_seeded_at", now.toISOString());
    }
    return {
      hits: [],
      seeded: !already,
      stats: {
        scrapedEn: enEntries.length,
        scrapedDe: deEntries.length,
        newEn: 0,
        newDe: 0,
        hits: 0,
        scope,
      },
    };
  }

  const { akaById, blacklistById } = loadAliasMaps(database);
  const scanCelebs = celebsForCategoryScan();
  const celebById = new Map(scanCelebs.map((c) => [c.id, c]));
  const autoIds = new Set((db.getAliveCelebsForAuto() || []).map((c) => c.id));
  const announcedIds = new Set(
    (typeof db.getAliveCelebsForAnnounced === "function" ? db.getAliveCelebsForAnnounced() : []).map(
      (c) => c.id
    )
  );

  // Pool-Prüfung starten, bevor die Karten-Schleife awaited — sie darf nicht
  // hinter dem seriellen channel.send warten.
  const poolTask = (async () => {
    if (typeof categoryDeath.findDeathsByCategory !== "function") {
      throw new Error("findDeathsByCategory missing");
    }
    const season = db.getActiveSeason();
    return categoryDeath.findDeathsByCategory(config.userAgent, scanCelebs, {
      seasonStartDate: season?.start_date || null,
      tz: config.tz,
    });
  })().catch((e) => {
    console.error("[poll] category check failed", e.message);
    return [];
  });

  const announceCards = (mode === "live" || mode === "nightly") && config.channelAllDeaths;
  let postedCards = 0;

  try {
    if (announceCards && guildUnavailable(client)) {
      console.error("[poll] Discord guild unavailable — all-deaths deferred");
    } else if (announceCards) {
      const candidates = [...uniqueNewEn, ...newDeOnly];
      const deferredIds = new Set(deferredDeEn.map((t) => t.deId));
      const resolvable = candidates.filter((e) => !deferredIds.has(e.id));
      await resolveBriefs(resolvable, config);

      const history = { qids: qidHistory(), humanNames: new Set() };
      const { post, bind, defer } = announceDedup.planAnnouncements(resolvable, history);
      for (const d of defer) {
        console.log(
          new Date().toISOString(),
          "[poll] deferring (resolve error) — not stamped",
          d.id
        );
      }

      for (const e of post) {
        try {
          await announce.announceAllDeath(client, config, e, {
            isDeOnly: e.lang === "de",
            brief: e.brief || undefined,
          });
          stamp.markAnnounced(e.id, null, e.resolved?.qid || null);
          postedCards += 1;
        } catch (err) {
          console.error("[poll] all-death", e.lang, err.message);
          const code = errorCode(err);
          if (CHANNEL_ERROR_CODES.has(code)) {
            await log.logError(client, config, err, { where: "all-deaths " + (e.id || "") }).catch(
              () => {}
            );
          }
        }
      }
      await bumpPresenceOnce(client, config, postedCards);

      for (const b of bind) {
        if (b.loserId === b.winnerId) {
          stamp.markAnnounced(b.loserId);
          await log.logEvent(client, config, {
            kind: "announce-suppress",
            summary: `Karte unterdrückt (${b.reason || "?"}): ${b.loserId}`,
            detail: b.loserId === b.winnerId ? "bereits in einer früheren Runde gepostet" : undefined,
          }).catch(() => {});
          continue;
        }
        if (stamp.isAnnounced(b.winnerId)) {
          stamp.markAnnounced(b.loserId);
          await log.logEvent(client, config, {
            kind: "announce-suppress",
            summary: `Karte unterdrückt (${b.reason || "?"}): ${b.loserId} → ${b.winnerId}`,
          }).catch(() => {});
        }
      }
      for (const t of deferredDeEn) {
        if (stamp.isAnnounced(t.enId)) stamp.markAnnounced(t.deId);
      }
    } else {
      for (const e of [...uniqueNewEn, ...newDeOnly]) stamp.markAnnounced(e.id);
      for (const t of deferredDeEn) stamp.markAnnounced(t.deId);
    }
  } catch (e) {
    await poolTask;
    throw e;
  }

  const categoryResults = await poolTask;

  const { byCeleb, autoHits, announcedHits } = splitCategoryResults(
    categoryResults,
    autoIds,
    announcedIds,
    celebById
  );
  const autoList = listHitsFor(
    db.getAliveCelebsForAuto(),
    poolEntries,
    "auto",
    akaById,
    blacklistById
  );
  const announcedList = listHitsFor(
    typeof db.getAliveCelebsForAnnounced === "function" ? db.getAliveCelebsForAnnounced() : [],
    poolEntries,
    "announced",
    akaById,
    blacklistById
  );
  const autoMerged = mergeHits(autoHits, autoList);
  const announcedMerged = mergeHits(announcedHits, announcedList);
  console.log(
    new Date().toISOString(),
    `[poll] pool hits: category=${autoHits.length + announcedHits.length} list=${autoList.length + announcedList.length} merged=${autoMerged.length + announcedMerged.length}`
  );

  const hits = [];
  const doAnnounce = mode === "live" || mode === "nightly";
  const confirmed = mode === "reconcile";

  for (let i = 0; i < autoMerged.length; i++) {
    await yieldEvery(i);
    const m = autoMerged[i];
    if (!canAutoBook(m.celeb) || Number(m.celeb.is_alive) !== 1) continue;
    try {
      console.log(new Date().toISOString(), `[poll] DEATHPOOL HIT (${mode})`, m.celeb.name, m.via || "list");
      const result = await announce.processDeathpoolHit(
        client,
        config,
        { celeb: m.celeb, entry: m.entry, wikiAge: m.age },
        { announce: doAnnounce, confirmed, source: mode === "reconcile" ? "reconcile" : "wiki" }
      );
      hits.push({ celeb: m.celeb, entry: m.entry, wikiAge: m.age, result });
    } catch (err) {
      console.error("[poll] deathpool", err.message);
      ops.noteError(`deathpool ${m.celeb.name}: ${err.message}`);
      await log.logError(client, config, err, { where: "deathpool " + m.celeb.name }).catch(() => {});
    }
  }

  const announcedBooked = [];
  for (let i = 0; i < announcedMerged.length; i++) {
    await yieldEvery(i);
    const m = announcedMerged[i];
    if (Number(m.celeb.is_alive) !== 1) continue;
    // Unbestätigt oder aus dem Auto-Pool: nichts buchen. Die Pre-Start-Warnung
    // läuft danach über die bestehenden died_at-Zeilen.
    if (!canAutoBook(m.celeb)) continue;
    try {
      await announce.processDeathpoolHit(
        client,
        config,
        { celeb: m.celeb, entry: m.entry, wikiAge: m.age },
        { announce: false, confirmed: false, source: "announced-prestart" }
      );
      announcedBooked.push(m);
    } catch (err) {
      console.error("[poll] announced pre-start", err.message);
      await log.logError(client, config, err, { where: "announced-prestart" }).catch(() => {});
    }
  }
  if (announcedBooked.length) {
    console.log(
      new Date().toISOString(),
      `[poll] announced pre-start deaths: ${announcedBooked.length}`
    );
    const announcedSeason = db.getAnnouncedSeason?.() || null;
    const preYear = announcedSeason?.year ? `${announcedSeason.year}` : "Nächstes";
    for (const m of announcedBooked) {
      await log.logEvent(client, config, {
        kind: "announced-death",
        summary: `${preYear}-Pick-Tod erkannt (Pre-Start): ${m.celeb.name}`,
        detail: `via ${m.entry?.text || "Liste"}`,
      }).catch(() => {});
    }
  }

  if (mode === "nightly") {
    await processRetractions(client, config, poolEntries, byCeleb, akaById, blacklistById, now);
  }

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

  if (mode === "live") {
    const channelId = db.resolveDeathpoolChannel(config);
    let channel = null;
    if (channelId && client?.channels?.fetch && !guildUnavailable(client)) {
      channel = await client.channels.fetch(channelId).catch(() => null);
    }
    if (channel?.isTextBased?.()) {
      await replayUnannounced(client, config);
    }
  }

  return {
    hits,
    seeded: false,
    stats: {
      scrapedEn: enEntries.length,
      scrapedDe: deEntries.length,
      newEn: uniqueNewEn.length,
      newDe: newDeOnly.length,
      categoryHits: autoHits.length + announcedHits.length,
      listHits: autoList.length + announcedList.length,
      hits: hits.length,
      scope,
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
  cron.schedule(
    `0 ${hour} * * *`,
    () => {
      if (!db.isLive()) {
        console.log("[nightly] skipped (not live)");
        return;
      }
      console.log(new Date().toISOString(), "[nightly] full-year scrape starting");
      tick("nightly");
    },
    { timezone: config.tz }
  );
  console.log(`[nightly] scheduled at hour ${hour} tz=${config.tz}`);
}

module.exports = { runWikiPoll, startWikiPoller, scrapeAll };
