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
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "guild-test";
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

test("removeSidecars deletes -wal and -shm and leaves the main file", () => {
  const base = path.join(config.dataDir, "sidecar-target.sqlite");
  fs.writeFileSync(base, "main");
  fs.writeFileSync(base + "-wal", "stale-wal");
  fs.writeFileSync(base + "-shm", "stale-shm");
  backup.removeSidecars(base);
  assert.ok(!fs.existsSync(base + "-wal"), "wal removed");
  assert.ok(!fs.existsSync(base + "-shm"), "shm removed");
  assert.strictEqual(fs.readFileSync(base, "utf8"), "main", "main file stays");
});

test("removeSidecars ignores missing sidecars", () => {
  const base = path.join(config.dataDir, "no-sidecars.sqlite");
  fs.writeFileSync(base, "x");
  assert.doesNotThrow(() => backup.removeSidecars(base));
  assert.ok(fs.existsSync(base));
});

test("a partial .tmp write is not a restore candidate", () => {
  fs.mkdirSync(config.restoreDir, { recursive: true });
  const stubName = "aborted-write.zip.tmp";
  fs.writeFileSync(path.join(config.restoreDir, stubName), "partial-zip-bytes");
  fs.writeFileSync(path.join(config.restoreDir, "notes.txt"), "nope");
  fs.writeFileSync(path.join(config.restoreDir, "keep-me.zip"), "PK");
  assert.ok(!fs.existsSync(path.join(config.restoreDir, "aborted-write.zip")));

  const listed = backup.listRestoreCandidates(config).map((c) => c.name);
  assert.ok(listed.includes("keep-me.zip"), "finished .zip is still listed");
  assert.ok(!listed.includes(stubName), "half .tmp must not be listed");
  assert.ok(!listed.includes("notes.txt"));
  assert.ok(listed.every((n) => n.endsWith(".zip") && !n.endsWith(".tmp")));
});

test("createPackage publishes the zip by rename", () => {
  const events = [];
  const origRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith(".tmp") && String(to).endsWith(".zip")) {
      events.push({
        from,
        to,
        tmpExists: fs.existsSync(from),
        zipExistsBefore: fs.existsSync(to),
      });
    }
    return origRename(from, to);
  };
  let pkg;
  try {
    pkg = backup.createPackage(config, { reason: "atomic-zip" });
  } finally {
    fs.renameSync = origRename;
  }

  assert.strictEqual(events.length, 1, "zip is published by exactly one rename");
  assert.strictEqual(events[0].to, pkg.path);
  assert.strictEqual(events[0].tmpExists, true, "temp zip exists before rename");
  assert.strictEqual(events[0].zipExistsBefore, false, "final .zip must not exist before rename");
  assert.ok(fs.existsSync(pkg.path));
  assert.ok(!fs.existsSync(pkg.path + ".tmp"), "temp name is gone after rename");
  assert.deepStrictEqual(
    fs.readdirSync(config.backupsDir).filter((f) => f.startsWith(".snapshot-")),
    []
  );

  const zip = new AdmZip(pkg.path);
  const entry = zip.getEntry("deathbot.sqlite");
  assert.ok(entry, "snapshot sqlite is inside the zip");
  assert.strictEqual(entry.getData().subarray(0, 15).toString("utf8"), "SQLite format 3");
});

test("an aborted zip publish leaves no .zip and no .tmp", () => {
  const origRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith(".tmp") && String(to).endsWith(".zip")) {
      throw new Error("rename aborted");
    }
    return origRename(from, to);
  };
  try {
    assert.throws(
      () => backup.createPackage(config, { reason: "abort-rename" }),
      /rename aborted/
    );
  } finally {
    fs.renameSync = origRename;
  }

  const leftovers = fs.readdirSync(config.backupsDir).filter((f) => f.includes("abort-rename"));
  assert.deepStrictEqual(leftovers, [], "aborted publish must not leave a zip or a tmp");
  assert.deepStrictEqual(
    fs.readdirSync(config.backupsDir).filter((f) => f.startsWith(".snapshot-")),
    []
  );
  const listed = backup.listRestoreCandidates(config).map((c) => c.name);
  assert.ok(!listed.some((n) => n.includes("abort-rename")));
  assert.ok(db.getDb().prepare("SELECT 1 AS ok").get().ok === 1, "live DB still open");
});

test("restore removes wal/shm before the new file is renamed onto the live path", () => {
  seedPerson();
  const pkg = backup.createPackage(config, { reason: "wal-order" });
  const baseName = path.basename(pkg.name);
  fs.mkdirSync(config.restoreDir, { recursive: true });
  fs.copyFileSync(pkg.path, path.join(config.restoreDir, baseName));
  db.setMeta("m17-restore-marker", "live-before-restore");

  const callLog = [];
  const origRemove = backup.removeSidecars;
  const origRename = fs.renameSync;
  const origClose = db.closeDb;
  let planted = false;

  db.closeDb = () => {
    const ret = origClose();
    if (!planted) {
      planted = true;
      fs.writeFileSync(config.dbPath + "-wal", "stale-wal");
      fs.writeFileSync(config.dbPath + "-shm", "stale-shm");
      callLog.push({
        step: "stale-sidecars-present",
        walExists: fs.existsSync(config.dbPath + "-wal"),
        shmExists: fs.existsSync(config.dbPath + "-shm"),
        liveIno: fs.statSync(config.dbPath).ino,
      });
    }
    return ret;
  };
  backup.removeSidecars = (dbPath) => {
    callLog.push({
      step: "removeSidecars:start",
      walExists: fs.existsSync(dbPath + "-wal"),
      shmExists: fs.existsSync(dbPath + "-shm"),
      liveIno: fs.statSync(dbPath).ino,
    });
    const ret = origRemove(dbPath);
    callLog.push({
      step: "removeSidecars:end",
      walExists: fs.existsSync(dbPath + "-wal"),
      shmExists: fs.existsSync(dbPath + "-shm"),
      liveIno: fs.statSync(dbPath).ino,
    });
    return ret;
  };
  fs.renameSync = (from, to) => {
    if (path.resolve(to) === path.resolve(config.dbPath)) {
      const newIno = fs.statSync(from).ino;
      callLog.push({
        step: "rename-live:before",
        walExists: fs.existsSync(to + "-wal"),
        shmExists: fs.existsSync(to + "-shm"),
        liveInoBefore: fs.statSync(to).ino,
        newIno,
      });
      const ret = origRename(from, to);
      callLog.push({
        step: "rename-live:after",
        walExists: fs.existsSync(to + "-wal"),
        shmExists: fs.existsSync(to + "-shm"),
        liveIno: fs.statSync(to).ino,
        newIno,
        liveIsNewFile: fs.statSync(to).ino === newIno,
      });
      return ret;
    }
    return origRename(from, to);
  };

  try {
    const res = backup.restorePackage(config, baseName);
    assert.strictEqual(res.restored, baseName);

    assert.strictEqual(planted, true, "stale sidecars were planted after close");
    const steps = callLog.map((e) => e.step);
    const plantedAt = steps.indexOf("stale-sidecars-present");
    const removeAt = steps.indexOf("removeSidecars:end");
    const renameAt = steps.indexOf("rename-live:before");
    assert.ok(plantedAt !== -1 && removeAt !== -1 && renameAt !== -1, "call log has plant, remove, rename");
    assert.ok(plantedAt < removeAt && removeAt < renameAt, "removeSidecars finishes before rename");

    const start = callLog.find((e) => e.step === "removeSidecars:start");
    const end = callLog.find((e) => e.step === "removeSidecars:end");
    const before = callLog.find((e) => e.step === "rename-live:before");
    const after = callLog.find((e) => e.step === "rename-live:after");

    assert.strictEqual(start.walExists, true, "wal is present when removeSidecars starts");
    assert.strictEqual(start.shmExists, true, "shm is present when removeSidecars starts");
    assert.strictEqual(end.walExists, false, "wal is gone when removeSidecars returns");
    assert.strictEqual(end.shmExists, false, "shm is gone when removeSidecars returns");
    assert.strictEqual(end.liveIno, start.liveIno, "live path is still the old file when sidecars are gone");

    assert.strictEqual(before.walExists, false, "wal is already gone before rename onto the live path");
    assert.strictEqual(before.shmExists, false, "shm is already gone before rename onto the live path");
    assert.strictEqual(before.liveInoBefore, start.liveIno);
    assert.notStrictEqual(before.newIno, start.liveIno);

    // Worst case this test rejects: WAL still there, and the new file is already the live path.
    if (after.walExists && after.liveIsNewFile) {
      assert.fail("WAL still present after the new file was renamed onto the live path");
    }
    assert.strictEqual(
      after.walExists,
      false,
      "WAL still present after the new file was renamed onto the live path"
    );
    assert.strictEqual(after.shmExists, false);
    assert.strictEqual(after.liveIsNewFile, true, "live path is the new file");
    assert.strictEqual(fs.statSync(config.dbPath).ino, after.newIno, "live path keeps the new file");

    assert.strictEqual(db.getMeta("m17-restore-marker"), null, "pre-restore live marker is not in the restored file");
    assert.ok(
      db.getDb().prepare("SELECT 1 FROM wiki_seen WHERE entry_id = ?").get("en:/wiki/PersonA"),
      "restored database is open and contains the packaged row"
    );
  } finally {
    backup.removeSidecars = origRemove;
    fs.renameSync = origRename;
    db.closeDb = origClose;
  }
});

test("BACKUP_CRON is 04:00 in config.tz", () => {
  assert.strictEqual(backup.BACKUP_CRON, "0 4 * * *");
  const src = fs.readFileSync(path.join(__dirname, "../src/backup/index.js"), "utf8");
  assert.ok(src.includes('const BACKUP_CRON = "0 4 * * *";'));
  assert.ok(src.includes("04:00 gibt es am EU-Frühjahrs- und Herbstumstellungstag genau einmal"));
  assert.match(src, /cron\.schedule\(\s*BACKUP_CRON\s*,/);
  assert.match(src, /timezone:\s*config\.tz/);
  assert.ok(!src.includes("0 2 * * *"), "nightly cron must not be 02:00");
  assert.ok(!/require\(["'][^"']*year-rollover["']\)/.test(src));
});
