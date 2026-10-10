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
