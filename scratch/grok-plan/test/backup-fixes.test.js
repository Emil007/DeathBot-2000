const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");

// Isolated DB per test run
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-backup-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const backup = require("../src/backup");

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

function seedPerson() {
  db.markWikiSeen({ id: "en:/wiki/PersonA", text: "Person A", url: "https://en.wikipedia.org/wiki/PersonA", lang: "en" });
  db.markWikiAnnounced("en:/wiki/PersonA");
}

test("restore rejects an invalid package and leaves the live DB untouched (F6)", () => {
  seedPerson();
  const before_ = !!db.getDb().prepare("SELECT 1 FROM wiki_seen WHERE entry_id = ?").get("en:/wiki/PersonA");
  assert.ok(before_, "person present before");

  // fake/corrupt package into restore dir
  fs.mkdirSync(config.restoreDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile("deathbot.sqlite", Buffer.from("NOT A REAL SQLITE DB"));
  zip.writeZip(path.join(config.restoreDir, "fake.zip"));

  assert.throws(
    () => backup.restorePackage(config, "fake.zip"),
    /invalid|not a usable database/i,
    "restore must reject the corrupt package"
  );

  // Live DB must still be open AND untouched
  assert.ok(db.getDb(), "DB still initialized after failed restore");
  const after_ = !!db.getDb().prepare("SELECT 1 FROM wiki_seen WHERE entry_id = ?").get("en:/wiki/PersonA");
  assert.ok(after_, "person survives a failed restore");
});

test("restore applies a valid package (positive path)", () => {
  seedPerson();
  const pkg = backup.createPackage(config, { reason: "test-clean" });
  fs.copyFileSync(pkg.path, path.join(config.restoreDir, path.basename(pkg.name)));

  const res = backup.restorePackage(config, path.basename(pkg.name));
  assert.strictEqual(res.restored, path.basename(pkg.name), "restored basename");
  assert.ok(db.getDb(), "DB re-opened after valid restore");
  assert.ok(
    db.getDb().prepare("SELECT 1 FROM wiki_seen WHERE entry_id = ?").get("en:/wiki/PersonA"),
    "person present after valid restore"
  );
});
