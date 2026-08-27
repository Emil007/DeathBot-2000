const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const AdmZip = require("adm-zip");
const db = require("../db");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function createPackage(config, { reason = "backup" } = {}) {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const season = db.getActiveSeason();
  const stats = db.statsSnapshot();
  const name = `season-${season.year}-${timestamp()}-${reason}.zip`;
  const outPath = path.join(config.backupsDir, name);

  // Ensure WAL checkpointed into main file
  db.getDb().pragma("wal_checkpoint(TRUNCATE)");

  const zip = new AdmZip();
  zip.addLocalFile(config.dbPath, "", "deathbot.sqlite");
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify(
        {
          created_at: new Date().toISOString(),
          reason,
          season,
          stats,
          version: 1,
        },
        null,
        2
      ),
      "utf8"
    )
  );
  zip.writeZip(outPath);
  return { path: outPath, name, stats, season };
}

function listRestoreCandidates(config) {
  fs.mkdirSync(config.restoreDir, { recursive: true });
  return fs
    .readdirSync(config.restoreDir)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => ({ name: f, path: path.join(config.restoreDir, f) }));
}

function findPackage(config, fileName) {
  const inRestore = path.join(config.restoreDir, fileName);
  if (fs.existsSync(inRestore)) return inRestore;
  const inBackups = path.join(config.backupsDir, fileName);
  if (fs.existsSync(inBackups)) return inBackups;
  return null;
}

function restorePackage(config, fileName) {
  const zipPath = findPackage(config, fileName);
  if (!zipPath) throw new Error(`Package not found: ${fileName}`);

  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry("deathbot.sqlite");
  if (!entry) throw new Error("Invalid package: missing deathbot.sqlite");

  const manifestEntry = zip.getEntry("manifest.json");
  const manifest = manifestEntry
    ? JSON.parse(manifestEntry.getData().toString("utf8"))
    : null;

  // Safety backup of current DB first
  const safety = createPackage(config, { reason: "pre-restore" });

  db.closeDb();
  try {
    fs.writeFileSync(config.dbPath, entry.getData());
    // remove sidecars
    for (const side of ["-wal", "-shm"]) {
      const p = config.dbPath + side;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } finally {
    db.reopenDb(config);
  }

  return { manifest, safety: safety.name, restored: fileName };
}

function startAutoBackup(config) {
  cron.schedule("0 */6 * * *", () => {
    try {
      const pkg = createPackage(config, { reason: "auto" });
      console.log("[backup] auto package", pkg.name);
    } catch (e) {
      console.error("[backup] auto failed", e.message);
    }
  });
}

module.exports = {
  createPackage,
  listRestoreCandidates,
  findPackage,
  restorePackage,
  startAutoBackup,
};
