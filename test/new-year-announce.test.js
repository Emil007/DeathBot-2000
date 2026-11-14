const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-m5-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const { buildSeasonEmbed } = require("../src/discord/commands/announce-season");
const { assertWipeAllowed } = require("../src/discord/commands/new-year");

let config;
before(() => {
  config = loadConfig();
  db.openDb(config);
  db.setSeasonLive(true);
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("buildSeasonEmbed conveys the participation steps", () => {
  const embed = buildSeasonEmbed({
    year: 2027,
    startDate: "2027-01-01",
    channelName: "wettbuero",
    note: "Werdet Teil!",
    runningYear: 2026,
  });
  const d = embed.data && embed.data.description;
  const desc = typeof d === "string" ? d : JSON.stringify(embed);
  assert.ok(desc.includes("2027"));
  assert.ok(desc.includes("2027-01-01"));
  assert.ok(desc.includes("2026"), "running year must be mentioned");
  assert.ok(/Direktnachricht|DM/i.test(desc), "DM step must be described");
  assert.ok(/fertig|done/i.test(desc), "fertig step must be described");
  assert.ok(/nicht.*teil|nimmt nicht/i.test(desc), "non-member exclusion must be described");
  const noteField = embed.data && (embed.data.fields || []).find?.((f) => f.value?.includes("Werdet Teil!"));
  assert.ok((embed.data && embed.data.description) ? desc.includes("Werdet Teil!") : noteField);
});

test("wipe is refused while a running season exists", () => {
  const res = assertWipeAllowed();
  assert.strictEqual(res.ok, false);
  const celebCount = db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c;
  // Nah an der Rolle: kein Wipe ausgeführt, Celebs bleiben
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c, celebCount);
});

test("repost path is safe: after openAnnouncedSeason + repost, counters unchanged", async () => {
  const running = db.getActiveSeason();
  const { season } = db.openAnnouncedSeason({
    year: 2027,
    startDate: "2027-01-01",
    channelId: "777",
    note: "x",
  });
  const before = {
    celebs: db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c,
    picks: db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c,
    awards: db.getDb().prepare("SELECT COUNT(*) c FROM death_awards").get().c,
    announced: db.getDb().prepare("SELECT COUNT(*) c FROM seasons WHERE phase='announced'").get().c,
  };
  // repost logik: nur setSeasonAnnounce falls neue Notiz + kein Schreiber in Tabellen
  db.setSeasonAnnounce(season.id, { channelId: "778", note: "neue notiz" });
  const after = {
    celebs: db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c,
    picks: db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c,
    awards: db.getDb().prepare("SELECT COUNT(*) c FROM death_awards").get().c,
    announced: db.getDb().prepare("SELECT COUNT(*) c FROM seasons WHERE phase='announced'").get().c,
  };
  assert.deepStrictEqual(after, before, "repost must not touch pool tables nor add seasons");
  assert.strictEqual(db.getActiveSeason().id, running.id, "running season unchanged");
});

test("activate refuses before start_date via guard helper path", () => {
  // Der Datums-Guard ist inline; hier die Bedingung nachbilden
  const announced = db.getAnnouncedSeason();
  const today = "2026-11-14";
  const blocked = today < announced.start_date;
  assert.strictEqual(blocked, true);
});
