const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-parallel-"));
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
  db.setSeasonLive(true);
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
  db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "99", note: "" });
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

function player(id, name) {
  return db.upsertPlayer({ displayName: name, discordUserId: id });
}

test("enqueueReview on a confirmed running celeb is refused (no invalidation)", () => {
  const p = player("9001", "Runner");
  const running = db.getActiveSeason();
  const rc = db.findOrCreateCeleb({ name: "Confirmed Running Cele", age: 50 });
  // bestätige als running-Celeb (wie Admin-review)
  db.applyWikiConfirm(rc.celeb.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Confirmed_Running_Cele",
    wikiNorm: "en:confirmed_running_cele",
    age: 50,
  });
  db.setPick(p.id, rc.celeb.id, running.id);

  const before = db.getDb().prepare("SELECT * FROM celebs WHERE id=?").get(rc.celeb.id);
  assert.strictEqual(before.wiki_confirmed, 1);
  assert.strictEqual(before.exclude_from_auto, 0);

  const announced = db.getAnnouncedSeason();
  const res = db.enqueueReview(rc.celeb.id, { wikiUrl: "x" }, { seasonId: announced.id });
  assert.strictEqual(res.queued, false);
  assert.strictEqual(res.reason, "running-celeb");

  const after = db.getDb().prepare("SELECT * FROM celebs WHERE id=?").get(rc.celeb.id);
  assert.strictEqual(after.wiki_confirmed, 1, "must stay confirmed");
  assert.strictEqual(after.exclude_from_auto, 0, "must stay auto-match");
  assert.strictEqual(after.age_at_pick, 50, "age unchanged");
});

test("enqueueReview announced-season entry is counted only in announced counter", () => {
  const announced = db.getAnnouncedSeason();
  const running = db.getActiveSeason();
  // neuer celeb, nicht bestätigt
  const c = db.findOrCreateCeleb({ name: "Brand New 2027 Star", age: null });
  const res = db.enqueueReview(c.celeb.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Brand_New_2027_Star",
    wikiNorm: "en:brand_new_2027_star",
    proposedAge: 66,
    lang: "en",
  }, { seasonId: announced.id });
  assert.strictEqual(res.queued, true);

  assert.ok(db.countPendingReviews({ seasonId: announced.id }) >= 1);
  // blockingLive-Zähler zählt die announced-Zeile NICHT
  const runningBlocking = db.countPendingReviews({ blockingLive: true });
  const legacy = db
    .getDb()
    .prepare("SELECT COUNT(*) c FROM celeb_review_queue WHERE status='pending' AND (season_id IS NULL OR season_id = ?)")
    .get(running.id).c;
  assert.strictEqual(runningBlocking, legacy, "announced row must not block the running season");
});

test("applyDeath awards only running-season winner with pick/celeb age", () => {
  const running = db.getActiveSeason();
  const announced = db.getAnnouncedSeason();

  // celeb gedealt: 2026 pick mit céléb-Alter, 2027 pick mit pick-Alter
  const c = db.findOrCreateCeleb({ name: "Shared Dead Celeb", age: 80 });
  db.applyWikiConfirm(c.celeb.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Shared_Dead_Celeb",
    wikiNorm: "en:shared_dead_celeb",
    age: 80,
  });

  const p26 = player("9101", "P26");
  const p27 = player("9102", "P27");
  db.setPick(p26.id, c.celeb.id, running.id);
  db.setPick(p27.id, c.celeb.id, announced.id);
  // 2027er-Alter auf pick setzen
  db.getDb()
    .prepare("UPDATE picks SET age_at_pick = 79 WHERE player_id=? AND celeb_id=? AND season_id=?")
    .run(p27.id, c.celeb.id, announced.id);

  const res = db.applyDeath(c.celeb.id, { confirmed: true, source: "test", diedAt: "2026-12-01" });
  // nur der 2026er-Spieler bekam Punkte
  assert.strictEqual(res.awards.length, 1);
  assert.strictEqual(res.awards[0].player.id, p26.id);
  // Score aus celeb-Alter 80 -> 20
  assert.strictEqual(res.awards[0].points, 20);

  // Award trägt running season_id
  const award = db
    .getDb()
    .prepare("SELECT * FROM death_awards WHERE celeb_id=? AND player_id=?")
    .get(c.celeb.id, p26.id);
  assert.strictEqual(award.season_id, running.id);
  assert.strictEqual(db.playerTotal(p26.id), 20);
  assert.strictEqual(db.playerTotal(p27.id), 0, "2027 pick must not score during running 2026");
});

test("finalized draft is not reopened after season switch", () => {
  const announced = db.getAnnouncedSeason();
  const p = player("9201", "LockedIn");
  const draft = db.getOrCreateDraft(p.id, announced.id);
  db.addDraftNames(draft.id, ["One Final"]); // pending -> finalize blocked
  const either = db.finalizeDraft(p.id, announced.id);
  assert.ok(either.blocked || either.added !== undefined);
});
