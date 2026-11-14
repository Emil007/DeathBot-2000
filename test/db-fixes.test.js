const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolated DB per test run
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-db-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");

let config;
before(() => {
  config = loadConfig();
  db.openDb(config);
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EPOCH = "1970-01-01 00:00:00";

test("repairAnnouncedBursts excludes EPOCH rows (F1)", () => {
  // Seed 25 rows sharing the EPOCH timestamp + 1 real same-second burst of 25.
  const tx = db.getDb().transaction(() => {
    for (let i = 0; i < 25; i++) {
      db.getDb()
        .prepare("INSERT INTO wiki_seen (entry_id, announced_at) VALUES (?, ?)")
        .run(`en:/wiki/epoch_seed_${i}`, EPOCH);
      db.getDb()
        .prepare(
          "INSERT INTO announced_deaths (entry_id, name, url, lang, announced_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(`en:/wiki/epoch_seed_${i}`, `Epoch ${i}`, "https://en.wikipedia.org/wiki/x", "en", EPOCH);
    }
    const burstTs = "2026-10-10 00:00:00";
    for (let i = 0; i < 25; i++) {
      db.getDb()
        .prepare("INSERT INTO wiki_seen (entry_id, announced_at) VALUES (?, ?)")
        .run(`en:/wiki/real_burst_${i}`, burstTs);
      db.getDb()
        .prepare(
          "INSERT INTO announced_deaths (entry_id, name, url, lang, announced_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(`en:/wiki/real_burst_${i}`, `Burst ${i}`, "https://en.wikipedia.org/wiki/x", "en", burstTs);
    }
  });
  tx();

  const fixed = db.repairAnnouncedBursts(20);

  // Only the real same-second burst should be restamped to EPOCH.
  assert.strictEqual(fixed, 25, "only the 25 real-burst rows should be repaired");

  const epochRows = db
    .getDb()
    .prepare("SELECT COUNT(*) AS c FROM announced_deaths WHERE announced_at = ?")
    .get(EPOCH).c;
  // 25 original epoch + 25 repaired = 50
  assert.strictEqual(epochRows, 50, "real burst rows were moved to EPOCH, originals untouched");
});

test("junk prune is opt-in counters, not auto-run (Punkt 1)", () => {
  db.getDb()
    .prepare("INSERT INTO wiki_seen (entry_id, announced_at) VALUES (?, ?)")
    .run("en:/wiki/List_of_days_of_the_year", EPOCH);
  db.getDb()
    .prepare(
      "INSERT INTO announced_deaths (entry_id, name, url, lang, announced_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      "en:/wiki/List_of_days_of_the_year",
      "List of days",
      "https://en.wikipedia.org/wiki/List_of_days_of_the_year",
      "en",
      EPOCH
    );

  assert.strictEqual(db.countJunkAnnouncements(), 1, "counter sees the junk row");
  assert.strictEqual(db.pruneJunkAnnouncements(), 1, "prune deletes the junk row");
  assert.strictEqual(db.countJunkAnnouncements(), 0, "nothing left after prune");
  // meta marker recorded for the opt-in script guard
  assert.ok(db.getMeta("junk_prune_last_run"), "prune records a last-run marker");
});

test("repairAnnouncedBursts twice is idempotent (EPOCH never re-churned)", () => {
  db.getDb()
    .prepare("INSERT INTO wiki_seen (entry_id, announced_at) VALUES (?, ?)")
    .run("en:/wiki/once_more", EPOCH);
  db.getDb()
    .prepare(
      "INSERT INTO announced_deaths (entry_id, name, url, lang, announced_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run("en:/wiki/once_more", "Once more", "https://en.wikipedia.org/wiki/x", "en", EPOCH);

  const before_ = db.getDb().prepare("SELECT COUNT(*) AS c FROM announced_deaths").get().c;
  db.repairAnnouncedBursts(20);
  const after_ = db.getDb().prepare("SELECT COUNT(*) AS c FROM announced_deaths").get().c;
  assert.strictEqual(after_, before_, "no rows added/removed by a second repair pass");
});

function resetM3() {
  const d = db.getDb();
  d.exec(`
    DROP TRIGGER IF EXISTS m3_abort_retract;
    DROP TRIGGER IF EXISTS m3_abort_wipe;
    DELETE FROM death_awards;
    DELETE FROM pick_death_warnings;
    DELETE FROM picks;
    DELETE FROM pick_draft_entries;
    DELETE FROM pick_drafts;
    DELETE FROM celeb_review_queue;
    DELETE FROM celeb_url_wait;
    DELETE FROM celeb_aka;
    DELETE FROM celeb_blacklist;
    DELETE FROM celebs;
    DELETE FROM player_bonuses;
    DELETE FROM season_point_snapshots;
    DELETE FROM pending_pastes;
    DELETE FROM players;
    DELETE FROM seasons;
    DELETE FROM announced_deaths;
    DELETE FROM wiki_seen;
  `);
  d.prepare("DELETE FROM meta WHERE key = ?").run("pending_season_review");
  db.ensureActiveSeason();
}

test("busy_timeout is set and applyDeath refuses unconfirmed and excluded celebs", () => {
  assert.strictEqual(db.getDb().pragma("busy_timeout", { simple: true }), 10000);
  resetM3();
  db.setSeasonLive(true);
  const season = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Gate", discordUserId: "161616161616161616" });
  db.setPoints(player.id, 5);

  const unconfirmed = db.findOrCreateCeleb({ name: "Unconfirmed Star", age: 40 });
  assert.strictEqual(unconfirmed.celeb.wiki_confirmed, 0);
  assert.strictEqual(unconfirmed.celeb.exclude_from_auto, 1);
  db.setPick(player.id, unconfirmed.celeb.id, season.id);
  const skippedU = db.applyDeath(unconfirmed.celeb.id, {
    confirmed: true,
    source: "kill",
    diedAt: `${season.year}-05-01`,
  });
  assert.strictEqual(skippedU.skipped, true);
  assert.strictEqual(skippedU.reason, "unconfirmed");
  assert.strictEqual(
    db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(unconfirmed.celeb.id).is_alive,
    1
  );
  assert.strictEqual(
    db.getDb().prepare("SELECT COUNT(*) AS c FROM death_awards WHERE celeb_id = ?").get(unconfirmed.celeb.id).c,
    0
  );

  const excluded = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, age_at_pick, is_alive, wiki_confirmed, exclude_from_auto)
       VALUES ('Excluded Star', 'excluded star', 50, 1, 1, 1)`
    )
    .run().lastInsertRowid;
  db.setPick(player.id, excluded, season.id);
  const skippedE = db.applyDeath(excluded, {
    confirmed: true,
    source: "kill",
    diedAt: `${season.year}-05-02`,
  });
  assert.strictEqual(skippedE.skipped, true);
  assert.strictEqual(skippedE.reason, "exclude_from_auto");
  assert.strictEqual(db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(excluded).is_alive, 1);
  assert.strictEqual(
    db.getDb().prepare("SELECT COUNT(*) AS c FROM death_awards WHERE celeb_id = ?").get(excluded).c,
    0
  );
  assert.strictEqual(db.getDb().prepare("SELECT base_points FROM players WHERE id = ?").get(player.id).base_points, 5);
});

test("findOrCreateCeleb leaves an existing row byte-identical", () => {
  resetM3();
  const first = db.findOrCreateCeleb({ name: "Byte Name", age: 33, description: "orig" });
  const before = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(first.celeb.id);
  const again = db.findOrCreateCeleb({ name: "Byte Name!!!", age: 99, description: "other" });
  const after = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(first.celeb.id);
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.celeb.id, first.celeb.id);
  assert.strictEqual(after.name, before.name);
  assert.strictEqual(after.age_at_pick, before.age_at_pick);
  assert.strictEqual(after.sheet_age_hint, before.sheet_age_hint);
  assert.strictEqual(after.description, before.description);
  assert.strictEqual(Buffer.compare(Buffer.from(after.name), Buffer.from(before.name)), 0);
  assert.deepStrictEqual(db.getAkas(first.celeb.id), []);
  assert.deepStrictEqual(again.ageConflict, { existing: 33, incoming: 99 });
});

test("retractDeath rolls back an aborted savepoint and deducts exactly once", () => {
  resetM3();
  db.setSeasonLive(true);
  const season = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Retract", discordUserId: "171717171717171717" });
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, age_at_pick, is_alive, wiki_confirmed, exclude_from_auto)
       VALUES ('Payable', 'payable', 40, 1, 1, 0)`
    )
    .run().lastInsertRowid;
  db.setPick(player.id, cid, season.id);
  const res = db.applyDeath(cid, { confirmed: true, source: "test", diedAt: `${season.year}-06-15` });
  assert.strictEqual(res.awards.length, 1);
  const gained = res.awards[0].points;
  assert.ok(gained > 0);
  const points = db.getDb().prepare("SELECT base_points FROM players WHERE id = ?").get(player.id).base_points;
  assert.strictEqual(points, gained);
  assert.strictEqual(
    db.getDb().prepare("SELECT death_announced_at FROM celebs WHERE id = ?").get(cid).death_announced_at,
    null
  );

  db.getDb().exec(`
    CREATE TRIGGER m3_abort_retract
    BEFORE UPDATE OF is_alive ON celebs
    WHEN NEW.is_alive = 1
    BEGIN
      SELECT RAISE(ABORT, 'injected');
    END;
  `);
  try {
    assert.throws(
      () => {
        db.getDb().transaction(() => {
          db.retractDeath(cid);
        })();
      },
      /injected/
    );
  } finally {
    db.getDb().exec("DROP TRIGGER IF EXISTS m3_abort_retract");
  }

  assert.strictEqual(
    db.getDb().prepare("SELECT base_points FROM players WHERE id = ?").get(player.id).base_points,
    points,
    "points survive the aborted savepoint"
  );
  assert.strictEqual(
    db.getDb().prepare("SELECT COUNT(*) AS c FROM death_awards WHERE celeb_id = ?").get(cid).c,
    1
  );
  assert.strictEqual(db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(cid).is_alive, 0);

  const second = db.retractDeath(cid);
  assert.ok(second);
  assert.strictEqual(
    db.getDb().prepare("SELECT base_points FROM players WHERE id = ?").get(player.id).base_points,
    points - gained
  );
  assert.strictEqual(
    db.getDb().prepare("SELECT COUNT(*) AS c FROM death_awards WHERE celeb_id = ?").get(cid).c,
    0
  );
  assert.strictEqual(db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(cid).is_alive, 1);
  assert.strictEqual(
    db.getDb().prepare("SELECT retract_pending FROM celebs WHERE id = ?").get(cid).retract_pending,
    1
  );
});

test("markWikiAnnounced backfills announced_deaths without refreshing announced_at", () => {
  resetM3();
  db.markWikiSeen({
    id: "en:/wiki/Late_Person",
    lang: "en",
    text: "Late Person",
    url: "https://en.wikipedia.org/wiki/Late_Person",
    qid: "QOLD",
  });
  db.getDb()
    .prepare("UPDATE wiki_seen SET announced_at = ? WHERE entry_id = ?")
    .run("2000-01-01 00:00:00", "en:/wiki/Late_Person");
  db.markWikiAnnounced("en:/wiki/Late_Person", "2026-11-01 00:00:00", "QOLD");
  const row = db.getDb().prepare("SELECT * FROM announced_deaths WHERE entry_id = ?").get("en:/wiki/Late_Person");
  assert.ok(row, "missing announced_deaths row is inserted");
  assert.strictEqual(row.announced_at, "2000-01-01 00:00:00");
  assert.strictEqual(row.qid, "QOLD");
  assert.strictEqual(
    db.getDb().prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?").get("en:/wiki/Late_Person")
      .announced_at,
    "2000-01-01 00:00:00"
  );
  db.markWikiAnnounced("en:/wiki/Late_Person", "2026-12-01 00:00:00", "QOLD");
  assert.strictEqual(
    db.getDb().prepare("SELECT COUNT(*) AS c FROM announced_deaths WHERE entry_id = ?").get("en:/wiki/Late_Person").c,
    1
  );
  assert.ok(db.recentAnnouncedQids().has("QOLD"));
  assert.ok(!db.recentAnnouncedIdentities("2026-01-01 00:00:00").qids.has("QOLD"));
});

test("activateAnnouncedSeason stores pending_season_review and does not add a third season", () => {
  resetM3();
  db.setMeta("year_rollover_annual_review", "sentinel");
  db.setSeasonLive(true);
  const running = db.getActiveSeason();
  const nextYear = Number(running.year) + 1;
  db.openAnnouncedSeason({
    year: nextYear,
    startDate: `${nextYear}-04-02`,
    channelId: "ann-chan",
    note: "keep",
  });
  const announced = db.getAnnouncedSeason();
  const res = db.activateAnnouncedSeason();
  assert.strictEqual(db.getMeta("pending_season_review"), String(running.id));
  assert.strictEqual(db.getMeta("year_rollover_annual_review"), "sentinel");
  assert.strictEqual(res.archived.id, running.id);
  assert.strictEqual(res.archived.active, 0);
  assert.strictEqual(res.archived.phase, "archived");
  assert.strictEqual(res.activated.active, 1);
  assert.strictEqual(res.activated.phase, "running");
  assert.strictEqual(res.activated.year, nextYear);
  assert.strictEqual(res.activated.start_date, `${nextYear}-04-02`);
  assert.strictEqual(db.getActiveSeason().id, announced.id);
  assert.notStrictEqual(db.getActiveSeason().id, running.id);
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM seasons").get().c, 2);
});

test("clearSeasonForNewYear rolls back when the transaction throws", () => {
  resetM3();
  const season = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Wipe", discordUserId: "181818181818181818" });
  const celeb = db.findOrCreateCeleb({ name: "Keep Me", age: 44 });
  db.setPick(player.id, celeb.celeb.id, season.id);
  assert.throws(() => db.clearSeasonForNewYear(season.year, "2027-02-31"), /startDate/);
  assert.strictEqual(db.getActiveSeason().id, season.id);
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM picks").get().c, 1);

  db.getDb().exec(`
    CREATE TRIGGER m3_abort_wipe
    BEFORE DELETE ON picks
    BEGIN
      SELECT RAISE(ABORT, 'injected wipe');
    END;
  `);
  try {
    assert.throws(
      () => db.clearSeasonForNewYear(Number(season.year) + 3, `${Number(season.year) + 3}-01-01`),
      /injected wipe/
    );
  } finally {
    db.getDb().exec("DROP TRIGGER IF EXISTS m3_abort_wipe");
  }
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM picks").get().c, 1);
  assert.strictEqual(db.getActiveSeason().id, season.id);
  assert.strictEqual(
    db.getDb().prepare("SELECT name FROM celebs WHERE id = ?").get(celeb.celeb.id).name,
    "Keep Me"
  );
});

test("finalizeDraft asks once for unlinked names, then freezes; remove clears the ack", () => {
  resetM3();
  const active = db.getActiveSeason();
  const year = Number(active.year) + 1;
  db.openAnnouncedSeason({ year, startDate: `${year}-01-01`, channelId: "9", note: null });
  const announced = db.getAnnouncedSeason();
  const player = db.upsertPlayer({ displayName: "Unl", discordUserId: "191919191919191919" });
  const decoy = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wikidata_id, wiki_url_norm, wiki_confirmed, exclude_from_auto, is_alive)
       VALUES ('Decoy Q', 'decoy q', 'QDECOY', 'en:decoy', 1, 0, 1)`
    )
    .run().lastInsertRowid;

  const draft = db.getOrCreateDraft(player.id, announced.id);
  db.addDraftNames(draft.id, ["Raw Unlinked", "Also Unlinked"]);
  for (const entry of db.listDraftEntries(draft.id)) {
    db.setDraftEntryLinked(entry.id, {
      qid: "QDECOY",
      wikiNorm: "en:decoy",
      wikiUrl: "https://en.wikipedia.org/wiki/Decoy_Q",
      linkStatus: "unlinked",
    });
  }
  assert.strictEqual(db.getDraftForPlayer(player.id, announced.id).unlinked_ack, 0);

  const first = db.finalizeDraft(player.id, announced.id);
  assert.strictEqual(first.blocked, "unlinked");
  assert.deepStrictEqual(first.names, ["Raw Unlinked", "Also Unlinked"]);
  assert.strictEqual(db.getDraftForPlayer(player.id, announced.id).status, "draft");
  assert.strictEqual(db.getDraftForPlayer(player.id, announced.id).unlinked_ack, 1);
  assert.strictEqual(db.getAnnouncedSeasonPicksForPlayer(player.id, announced.id).length, 0);

  const second = db.finalizeDraft(player.id, announced.id);
  assert.strictEqual(second.added, 2);
  assert.strictEqual(db.getDraftForPlayer(player.id, announced.id).status, "finalized");
  assert.strictEqual(Number(db.getDraftForPlayer(player.id, announced.id).unlinked_ack), 0);
  const picks = db.getAnnouncedSeasonPicksForPlayer(player.id, announced.id);
  assert.strictEqual(picks.length, 2);
  assert.ok(picks.every((pk) => pk.celeb_id !== decoy));

  const player2 = db.upsertPlayer({ displayName: "Unl2", discordUserId: "202020202020202020" });
  const draft2 = db.getOrCreateDraft(player2.id, announced.id);
  db.addDraftNames(draft2.id, ["Keep Name", "Drop Name"]);
  for (const entry of db.listDraftEntries(draft2.id)) {
    db.setDraftEntryLinked(entry.id, { linkStatus: "unlinked" });
  }
  const asked = db.finalizeDraft(player2.id, announced.id);
  assert.strictEqual(asked.blocked, "unlinked");
  assert.strictEqual(db.getDraftForPlayer(player2.id, announced.id).unlinked_ack, 1);
  const drop = db.listDraftEntries(draft2.id).find((entry) => entry.raw_name === "Drop Name");
  assert.strictEqual(db.removeDraftEntry(drop.id), true);
  assert.strictEqual(db.getDraftForPlayer(player2.id, announced.id).unlinked_ack, 0);
  assert.strictEqual(db.getDraftForPlayer(player2.id, announced.id).status, "draft");
  const askedAgain = db.finalizeDraft(player2.id, announced.id);
  assert.strictEqual(askedAgain.blocked, "unlinked");
  assert.strictEqual(db.getDraftForPlayer(player2.id, announced.id).status, "draft");
  assert.strictEqual(db.getDraftForPlayer(player2.id, announced.id).unlinked_ack, 1);
});

test("listScoreboard returns both totals from one query", () => {
  resetM3();
  db.setSeasonLive(true);
  const season = db.getActiveSeason();
  const ann = db.upsertPlayer({ displayName: "Ann", discordUserId: "212121212121212121" });
  const bob = db.upsertPlayer({ displayName: "Bob", discordUserId: "232323232323232323" });
  db.setPoints(ann.id, 10);
  db.setPoints(bob.id, 4);
  db.upsertBonus({ id: "sb", name: "ScoreBonus", description: "", points: 7 });
  db.awardBonus(ann.id, "sb");
  db.awardBonus(bob.id, "sb");
  db.awardBonus(bob.id, "sb");
  const celeb = db.findOrCreateCeleb({ name: "Score Celeb", age: 50 });
  db.setPick(ann.id, celeb.celeb.id, season.id);
  db.setPick(bob.id, celeb.celeb.id, season.id);

  const rows = db.listScoreboard();
  assert.strictEqual(rows.length, 2);
  const byName = Object.fromEntries(rows.map((row) => [row.display_name, row]));
  assert.strictEqual(byName.Ann.total, 17);
  assert.strictEqual(byName.Bob.total, 18);
  assert.strictEqual(byName.Ann.pickCount, 1);
  assert.strictEqual(byName.Bob.pickCount, 1);
  assert.strictEqual(byName.Ann.base_points, 10);
  assert.strictEqual(byName.Bob.base_points, 4);
});

test("seasonReview.deaths counts a dead pick with zero points and no positive award", () => {
  resetM3();
  db.setSeasonLive(true);
  const season = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Zero", discordUserId: "242424242424242424" });
  const inYear = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, is_alive, died_at, wiki_confirmed, exclude_from_auto)
       VALUES ('Zero Dead', 'zero dead', 0, ?, 1, 0)`
    )
    .run(`${season.year}-06-01`).lastInsertRowid;
  const early = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, is_alive, died_at, wiki_confirmed, exclude_from_auto)
       VALUES ('Early Dead', 'early dead', 0, ?, 1, 0)`
    )
    .run(`${Number(season.year) - 1}-12-31`).lastInsertRowid;
  db.setPick(player.id, inYear, season.id);
  db.setPick(player.id, early, season.id);
  db.getDb()
    .prepare("INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (?, ?, 0, ?)")
    .run(inYear, player.id, season.id);

  const review = db.seasonReview(season.id);
  assert.strictEqual(review.deaths, 1);
  const live = db.seasonLiveReview(season.id);
  assert.strictEqual(live.deaths, 1);
  const row = live.rows.find((r) => r.name === "Zero");
  assert.ok(row);
  assert.strictEqual(row.hits, 0);
});

test("findPlayerByQuery matches only a mention or a snowflake", () => {
  resetM3();
  const player = db.upsertPlayer({ displayName: "Looks Like", discordUserId: "252525252525252525" });
  assert.strictEqual(db.findPlayerByQuery("<@252525252525252525>").id, player.id);
  assert.strictEqual(db.findPlayerByQuery("<@!252525252525252525>").id, player.id);
  assert.strictEqual(db.findPlayerByQuery("252525252525252525").id, player.id);
  assert.strictEqual(db.findPlayerByQuery("Looks Like"), null);
  assert.strictEqual(db.findPlayerByQuery("Looks"), null);
  assert.strictEqual(db.findPlayerByQuery("nope"), null);
});

test("death announcement, retraction queue and pending paste are one-shot", () => {
  resetM3();
  db.setSeasonLive(true);
  const season = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Queue", discordUserId: "262626262626262626" });
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, age_at_pick, is_alive, wiki_confirmed, exclude_from_auto)
       VALUES ('Announce Me', 'announce me', 60, 1, 1, 0)`
    )
    .run().lastInsertRowid;
  db.setPick(player.id, cid, season.id);
  db.applyDeath(cid, { confirmed: true, source: "test", diedAt: `${season.year}-07-01` });
  const unannounced = db.listUnannouncedDeaths();
  assert.ok(unannounced.some((row) => row.id === cid));
  assert.strictEqual(db.markDeathAnnounced(cid), true);
  assert.strictEqual(db.markDeathAnnounced(cid), false);
  assert.ok(!db.listUnannouncedDeaths().some((row) => row.id === cid));
  const stamped = db.getDb().prepare("SELECT death_announced_at FROM celebs WHERE id = ?").get(cid)
    .death_announced_at;
  assert.match(stamped, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  db.retractDeath(cid);
  assert.ok(db.listPendingRetractions().some((row) => row.id === cid));
  assert.strictEqual(db.markRetractionAnnounced(cid), true);
  assert.ok(!db.listPendingRetractions().some((row) => row.id === cid));

  db.savePendingPaste("user-1", "first");
  db.savePendingPaste("user-1", "second");
  assert.strictEqual(db.takePendingPaste("user-1"), "second");
  assert.strictEqual(db.takePendingPaste("user-1"), null);
});

test("resolveDeathpoolChannel prefers the active season, then the latest archived id", () => {
  resetM3();
  db.setSeasonLive(true);
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "arch-chan");
  const year = Number(running.year) + 1;
  db.openAnnouncedSeason({ year, startDate: `${year}-01-01`, channelId: "signup", note: null });
  db.activateAnnouncedSeason();
  const cfg = { ...config, channelDeathpool: "env-must-not-win" };
  assert.strictEqual(db.resolveDeathpoolChannel(cfg), "arch-chan");
  db.setSeasonDeathpoolChannel(db.getActiveSeason().id, "live-chan");
  assert.strictEqual(db.resolveDeathpoolChannel(cfg), "live-chan");
  db.setSeasonDeathpoolChannel(db.getActiveSeason().id, null);
  assert.strictEqual(db.resolveDeathpoolChannel(cfg), "arch-chan");
  db.getDb()
    .prepare("UPDATE seasons SET deathpool_channel_id = NULL WHERE phase = 'archived'")
    .run();
  assert.strictEqual(db.resolveDeathpoolChannel(cfg), null);
});
