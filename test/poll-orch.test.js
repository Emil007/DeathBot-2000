const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-poll-orch-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;
process.env.TZ = "Europe/Vienna";

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const scraperEn = require("../src/wiki/scraper-en");
const scraperDe = require("../src/wiki/scraper-de");
const categoryDeath = require("../src/wiki/category-death");
const match = require("../src/wiki/match");
const pageLookup = require("../src/wiki/page-lookup");
const deathBrief = require("../src/wiki/death-brief");
const announce = require("../src/discord/announce");
const log = require("../src/discord/log");
const { runWikiPoll } = require("../src/jobs/wiki-poll");

const EN_KEEP = {
  id: "en:/wiki/PollOrchKeep",
  wikiPath: "/wiki/PollOrchKeep",
  text: "Poll Orch Keep, 70, actor.",
  url: "https://en.wikipedia.org/wiki/PollOrchKeep",
  lang: "en",
};
const DE_KEEP = {
  id: "de:/wiki/PollOrchKeepDe",
  text: "Poll Orch Keep De, 70, Schauspieler.",
  url: "https://de.wikipedia.org/wiki/PollOrchKeepDe",
  lang: "de",
};

let config;
const scrapeLog = [];

function client(extra = {}) {
  return {
    channels: {
      fetch: async () => null,
    },
    guilds: { cache: new Map() },
    user: { setPresence: async () => {} },
    users: { fetch: async () => { throw new Error("no user"); } },
    ...extra,
  };
}

function insertCeleb(fields) {
  const row = {
    name: "Celeb",
    name_key: "celeb" + Math.random().toString(16).slice(2),
    is_alive: 1,
    wiki_confirmed: 0,
    exclude_from_auto: 0,
    manual_only: 0,
    death_confirmed: 0,
    wiki_url: null,
    death_detected_at: null,
    ...fields,
  };
  return db
    .getDb()
    .prepare(
      `INSERT INTO celebs (
         name, name_key, is_alive, wiki_confirmed, exclude_from_auto, manual_only,
         death_confirmed, wiki_url, death_detected_at
       ) VALUES (
         @name, @name_key, @is_alive, @wiki_confirmed, @exclude_from_auto, @manual_only,
         @death_confirmed, @wiki_url, @death_detected_at
       )`
    )
    .run(row).lastInsertRowid;
}

describe("poll orchestration", { concurrency: false }, () => {
  before(() => {
    config = loadConfig();
    db.openDb(config);
    db.setSeasonLive(false);
    scraperEn.scrapeEn = async (_ua, opts) => {
      scrapeLog.push({ lang: "en", scope: opts.scope, tz: opts.tz, now: opts.now });
      return [EN_KEEP];
    };
    scraperDe.scrapeDe = async (_ua, opts) => {
      scrapeLog.push({ lang: "de", scope: opts.scope, tz: opts.tz, now: opts.now });
      return { entries: [DE_KEEP] };
    };
    pageLookup.resolveEnglishArticle = async () => null;
    deathBrief.fetchDeathBrief = async (url) => ({
      qid: null,
      isHuman: true,
      url,
      pageMissing: false,
      name: "Brief",
    });
    categoryDeath.findDeathsByCategory = async () => [];
    categoryDeath.celebStillMarkedDead = async () => ({ dead: false, error: "stub-unavailable" });
    match.buildPoolIndex = (celebs, maps) => ({ celebs, ...maps });
    match.matchEntriesToIndex = () => [];
    db.markWikiSeen(EN_KEEP);
    db.markWikiAnnounced(EN_KEEP.id);
    db.markWikiSeen(DE_KEEP);
    db.markWikiAnnounced(DE_KEEP.id);
    if (!db.getAnnouncedSeason()) {
      db.openAnnouncedSeason({
        year: 2027,
        startDate: "2027-01-01",
        channelId: "777",
        note: null,
      });
    }
  });

  after(() => {
    try {
      db.closeDb();
    } catch {
      /* closed */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("second seed while not live uses scope recent and does not reseed the year", async () => {
    db.setSeasonLive(false);
    db.getDb().prepare("DELETE FROM meta WHERE key = ?").run("wiki_seeded_at");
    const seeded = [];
    const orig = db.seedAllWikiSeen;
    db.seedAllWikiSeen = (entries) => {
      seeded.push(entries);
      return orig(entries);
    };
    const from = scrapeLog.length;
    try {
      await runWikiPoll(client(), config, { mode: "seed" });
      const first = scrapeLog.slice(from);
      assert.ok(first.some((c) => c.lang === "en" && c.scope === "full"));
      assert.ok(first.some((c) => c.lang === "de" && c.scope === "full"));
      assert.ok(first.every((c) => c.tz === config.tz && c.now instanceof Date));
      assert.strictEqual(seeded.length, 1);
      assert.ok(db.getMeta("wiki_seeded_at"));

      const mid = scrapeLog.length;
      await runWikiPoll(client(), config, { mode: "seed" });
      const second = scrapeLog.slice(mid);
      assert.ok(second.some((c) => c.lang === "en" && c.scope === "recent"));
      assert.ok(second.some((c) => c.lang === "de" && c.scope === "recent"));
      assert.strictEqual(seeded.length, 1, "seedAllWikiSeen must not run again");
    } finally {
      db.seedAllWikiSeen = orig;
    }
  });

  test("category http-429 does not retract", async () => {
    const id = insertCeleb({
      name: "Zqx Rate Limited",
      is_alive: 0,
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      death_confirmed: 0,
      death_detected_at: new Date().toISOString(),
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Rate_Limited",
    });
    const retracts = [];
    const orig = db.retractDeath;
    db.retractDeath = (celebId) => {
      retracts.push(celebId);
      return orig(celebId);
    };
    const origFind = categoryDeath.findDeathsByCategory;
    categoryDeath.findDeathsByCategory = async () => [
      { celebId: id, dead: false, error: "http-429" },
    ];
    try {
      await runWikiPoll(client(), config, { mode: "nightly" });
      assert.ok(!retracts.includes(id), "429 must not retract");
      assert.strictEqual(retracts.length, 0);
      const row = db.getDb().prepare("SELECT is_alive, death_confirmed FROM celebs WHERE id = ?").get(id);
      assert.strictEqual(row.is_alive, 0);
      assert.strictEqual(row.death_confirmed, 0);
    } finally {
      db.retractDeath = orig;
      categoryDeath.findDeathsByCategory = origFind;
    }
  });

  test("unconfirmed announced hit does not call applyDeath", async () => {
    const season = db.getAnnouncedSeason();
    const pid = db
      .getDb()
      .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES (?, ?, 0)")
      .run("AnnPicker", "ann-" + Date.now()).lastInsertRowid;
    const id = insertCeleb({
      name: "Zqx Unconfirmed Announced",
      is_alive: 1,
      wiki_confirmed: 0,
      exclude_from_auto: 1,
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Unconfirmed_Announced",
    });
    db.getDb()
      .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
      .run(pid, id, season.id);
    const excludedId = insertCeleb({
      name: "Zqx Excluded Confirmed",
      is_alive: 1,
      wiki_confirmed: 1,
      exclude_from_auto: 1,
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Excluded_Confirmed",
    });
    db.getDb()
      .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
      .run(pid, excludedId, season.id);

    const applies = [];
    const orig = db.applyDeath;
    db.applyDeath = (...args) => {
      applies.push(args[0]);
      return orig(...args);
    };
    const origFind = categoryDeath.findDeathsByCategory;
    categoryDeath.findDeathsByCategory = async () => [
      {
        celebId: id,
        dead: true,
        category: "Category:2026 deaths",
        lang: "en",
        title: "Zqx Unconfirmed Announced",
        url: "https://en.wikipedia.org/wiki/Zqx_Unconfirmed_Announced",
      },
      {
        celebId: excludedId,
        dead: true,
        category: "Category:2026 deaths",
        lang: "en",
        title: "Zqx Excluded Confirmed",
        url: "https://en.wikipedia.org/wiki/Zqx_Excluded_Confirmed",
      },
    ];
    try {
      await runWikiPoll(client(), config, { mode: "nightly" });
      assert.ok(!applies.includes(id), "unconfirmed announced hit must not book");
      assert.ok(!applies.includes(excludedId), "exclude_from_auto announced hit must not book");
      const row = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(id);
      assert.strictEqual(row.is_alive, 1);
    } finally {
      db.applyDeath = orig;
      categoryDeath.findDeathsByCategory = origFind;
    }
  });

  test("worst case: 429 does not retract and unconfirmed hit does not book", async () => {
    const season = db.getAnnouncedSeason();
    const pid = db
      .getDb()
      .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES (?, ?, 0)")
      .run("WorstPicker", "worst-" + Date.now()).lastInsertRowid;
    const deadId = insertCeleb({
      name: "Zqx Worst Dead",
      is_alive: 0,
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      death_confirmed: 0,
      death_detected_at: new Date().toISOString(),
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Worst_Dead",
    });
    const rawId = insertCeleb({
      name: "Zqx Worst Raw",
      is_alive: 1,
      wiki_confirmed: 0,
      exclude_from_auto: 1,
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Worst_Raw",
    });
    db.getDb()
      .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
      .run(pid, rawId, season.id);

    const retracts = [];
    const applies = [];
    let akaHits = 0;
    let indexMaps = null;
    const origRetract = db.retractDeath;
    const origApply = db.applyDeath;
    const origAkas = db.getAkas;
    const origBl = db.getBlacklist;
    const origIndex = match.buildPoolIndex;
    db.retractDeath = (celebId) => {
      retracts.push(celebId);
      return origRetract(celebId);
    };
    db.applyDeath = (...args) => {
      applies.push(args[0]);
      return origApply(...args);
    };
    db.getAkas = (...args) => {
      akaHits++;
      return origAkas(...args);
    };
    db.getBlacklist = (...args) => {
      akaHits++;
      return origBl(...args);
    };
    match.buildPoolIndex = (celebs, maps) => {
      indexMaps = maps;
      return origIndex(celebs, maps);
    };
    const origFind = categoryDeath.findDeathsByCategory;
    let scanned = [];
    categoryDeath.findDeathsByCategory = async (_ua, celebs) => {
      scanned = celebs.map((c) => c.id);
      return [
        { celebId: deadId, dead: false, error: "http-429" },
        {
          celebId: rawId,
          dead: true,
          category: "Category:2026 deaths",
          lang: "en",
          title: "Zqx Worst Raw",
          url: "https://en.wikipedia.org/wiki/Zqx_Worst_Raw",
        },
      ];
    };
    try {
      await runWikiPoll(client(), config, { mode: "nightly" });
      assert.strictEqual(retracts.length, 0);
      assert.ok(!applies.includes(rawId));
      assert.ok(scanned.includes(deadId));
      assert.ok(scanned.includes(rawId));
      assert.strictEqual(akaHits, 0, "aka/blacklist must be loaded once, not via getAkas in the loop");
      assert.ok(indexMaps.akaById instanceof Map);
      assert.ok(indexMaps.blacklistById instanceof Map);
    } finally {
      db.retractDeath = origRetract;
      db.applyDeath = origApply;
      db.getAkas = origAkas;
      db.getBlacklist = origBl;
      match.buildPoolIndex = origIndex;
      categoryDeath.findDeathsByCategory = origFind;
    }
  });

  test("confirmed auto category hit does call applyDeath", async () => {
    const id = insertCeleb({
      name: "Zqx Auto Booked",
      is_alive: 1,
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      manual_only: 0,
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Auto_Booked",
    });
    const applies = [];
    const orig = db.applyDeath;
    db.applyDeath = (...args) => {
      applies.push(args[0]);
      return orig(...args);
    };
    const origFind = categoryDeath.findDeathsByCategory;
    categoryDeath.findDeathsByCategory = async () => [
      {
        celebId: id,
        dead: true,
        category: "Category:2026 deaths",
        lang: "en",
        title: "Zqx Auto Booked",
        url: "https://en.wikipedia.org/wiki/Zqx_Auto_Booked",
      },
    ];
    try {
      await runWikiPoll(client(), config, { mode: "nightly" });
      assert.ok(applies.includes(id));
      const row = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(id);
      assert.strictEqual(row.is_alive, 0);
    } finally {
      db.applyDeath = orig;
      categoryDeath.findDeathsByCategory = origFind;
    }
  });

  test("alive signal inside the confirm window retracts; outside it does not", async () => {
    const inside = insertCeleb({
      name: "Zqx Inside Window",
      is_alive: 0,
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      death_confirmed: 0,
      death_detected_at: new Date().toISOString(),
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Inside_Window",
    });
    const outside = insertCeleb({
      name: "Zqx Outside Window",
      is_alive: 0,
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      death_confirmed: 0,
      death_detected_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Outside_Window",
    });
    const retracts = [];
    const orig = db.retractDeath;
    db.retractDeath = (celebId) => {
      retracts.push(celebId);
      return orig(celebId);
    };
    const origFind = categoryDeath.findDeathsByCategory;
    categoryDeath.findDeathsByCategory = async () => [
      { celebId: inside, dead: false },
      { celebId: outside, dead: false },
    ];
    try {
      await runWikiPoll(client(), config, { mode: "nightly" });
      assert.ok(retracts.includes(inside));
      assert.ok(!retracts.includes(outside));
      const out = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(outside);
      assert.strictEqual(out.is_alive, 0);
    } finally {
      db.retractDeath = orig;
      categoryDeath.findDeathsByCategory = origFind;
    }
  });

  test("still dead past the confirm window is confirmed, not retracted", async () => {
    const id = insertCeleb({
      name: "Zqx Confirm Window",
      is_alive: 0,
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      death_confirmed: 0,
      death_detected_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      wiki_url: "https://en.wikipedia.org/wiki/Zqx_Confirm_Window",
    });
    const confirms = [];
    const retracts = [];
    const origC = db.confirmDeath;
    const origR = db.retractDeath;
    db.confirmDeath = (celebId) => {
      confirms.push(celebId);
      return origC(celebId);
    };
    db.retractDeath = (celebId) => {
      retracts.push(celebId);
      return origR(celebId);
    };
    const origFind = categoryDeath.findDeathsByCategory;
    categoryDeath.findDeathsByCategory = async () => [{ celebId: id, dead: true, category: "Category:2026 deaths" }];
    try {
      await runWikiPoll(client(), config, { mode: "nightly" });
      assert.ok(confirms.includes(id));
      assert.ok(!retracts.includes(id));
    } finally {
      db.confirmDeath = origC;
      db.retractDeath = origR;
      categoryDeath.findDeathsByCategory = origFind;
    }
  });

  test("all-deaths throw (10003) does not stamp and is logged", async () => {
    db.setSeasonLive(true);
    const entry = {
      id: "en:/wiki/Zqx_Throw_" + Date.now(),
      wikiPath: "/wiki/Zqx_Throw",
      text: "Zqx Throw, 81, actor.",
      url: "https://en.wikipedia.org/wiki/Zqx_Throw",
      lang: "en",
    };
    const origEn = scraperEn.scrapeEn;
    scraperEn.scrapeEn = async (_ua, opts) => {
      scrapeLog.push({ lang: "en", scope: opts.scope, tz: opts.tz, now: opts.now });
      return [entry];
    };
    const origAnnounce = announce.announceAllDeath;
    const logged = [];
    const origLog = log.logError;
    announce.announceAllDeath = async () => {
      const err = new Error("Unknown Channel");
      err.code = 10003;
      throw err;
    };
    log.logError = async (...args) => {
      logged.push(args);
    };
    const cfg = { ...config, channelAllDeaths: "chan-all" };
    try {
      await runWikiPoll(client(), cfg, { mode: "live" });
      const row = db.getDb().prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?").get(entry.id);
      assert.ok(row, "seen row should exist so the send can be retried");
      assert.strictEqual(row.announced_at, null);
      assert.strictEqual(logged.length, 1);
      assert.match(String(logged[0][3].where), /all-deaths/);
    } finally {
      scraperEn.scrapeEn = origEn;
      announce.announceAllDeath = origAnnounce;
      log.logError = origLog;
      db.setSeasonLive(false);
    }
  });

  test("old QID is not posted again by the live poll", async () => {
    db.setSeasonLive(true);
    db.getDb()
      .prepare(
        `INSERT INTO announced_deaths (entry_id, name, url, lang, qid, announced_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "en:/wiki/Historical_Q",
        "Historical Q, actor.",
        "https://en.wikipedia.org/wiki/Historical_Q",
        "en",
        "Q-HIST",
        "2020-06-01 00:00:00"
      );
    const entry = {
      id: "en:/wiki/Historical_Q_2",
      wikiPath: "/wiki/Historical_Q_2",
      text: "Historical Q, actor.",
      url: "https://en.wikipedia.org/wiki/Historical_Q_2",
      lang: "en",
    };
    const origEn = scraperEn.scrapeEn;
    const origBrief = deathBrief.fetchDeathBrief;
    const origAnnounce = announce.announceAllDeath;
    let posts = 0;
    scraperEn.scrapeEn = async (_ua, opts) => {
      scrapeLog.push({ lang: "en", scope: opts.scope, tz: opts.tz, now: opts.now });
      return [entry];
    };
    deathBrief.fetchDeathBrief = async (url) => ({
      qid: "Q-HIST",
      isHuman: true,
      url,
      pageMissing: false,
      name: "Historical Q",
    });
    announce.announceAllDeath = async () => {
      posts++;
    };
    const cfg = { ...config, channelAllDeaths: "chan-all" };
    try {
      await runWikiPoll(client(), cfg, { mode: "live" });
      assert.strictEqual(posts, 0);
      const row = db.getDb().prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?").get(entry.id);
      assert.ok(row?.announced_at, "qid-history loser is stamped without a new post");
    } finally {
      scraperEn.scrapeEn = origEn;
      deathBrief.fetchDeathBrief = origBrief;
      announce.announceAllDeath = origAnnounce;
      db.setSeasonLive(false);
    }
  });

  test("pool check starts before card sends; presence refreshes once", async () => {
    db.setSeasonLive(true);
    const a = {
      id: "en:/wiki/CardA_" + Date.now(),
      wikiPath: "/wiki/CardA",
      text: "Card A, 60, actor.",
      url: "https://en.wikipedia.org/wiki/CardA",
      lang: "en",
    };
    const b = {
      id: "en:/wiki/CardB_" + Date.now(),
      wikiPath: "/wiki/CardB",
      text: "Card B, 61, actor.",
      url: "https://en.wikipedia.org/wiki/CardB",
      lang: "en",
    };
    const origEn = scraperEn.scrapeEn;
    const origFind = categoryDeath.findDeathsByCategory;
    const origAnnounce = announce.announceAllDeath;
    const order = [];
    let active = 0;
    let maxActive = 0;
    let presenceCalls = 0;
    scraperEn.scrapeEn = async (_ua, opts) => {
      scrapeLog.push({ lang: "en", scope: opts.scope, tz: opts.tz, now: opts.now });
      return [a, b];
    };
    categoryDeath.findDeathsByCategory = async (_ua, _celebs, opts) => {
      order.push("category");
      assert.strictEqual(opts.tz, config.tz);
      await new Promise((r) => setTimeout(r, 30));
      order.push("category-done");
      return [];
    };
    announce.announceAllDeath = async () => {
      order.push("send");
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    const cfg = { ...config, channelAllDeaths: "chan-all" };
    const c = client({
      user: {
        setPresence: async () => {
          presenceCalls++;
        },
      },
    });
    try {
      await runWikiPoll(c, cfg, { mode: "live" });
      assert.ok(order.indexOf("category") !== -1 && order.indexOf("category") < order.indexOf("send"));
      assert.strictEqual(order.filter((x) => x === "send").length, 2);
      assert.strictEqual(maxActive, 1, "channel.send stays strictly sequential");
      assert.strictEqual(presenceCalls, 1);
      const meta = JSON.parse(db.getMeta("alldeaths_day_count"));
      assert.strictEqual(meta.count, 2);
    } finally {
      scraperEn.scrapeEn = origEn;
      categoryDeath.findDeathsByCategory = origFind;
      announce.announceAllDeath = origAnnounce;
      db.setSeasonLive(false);
    }
  });
});
