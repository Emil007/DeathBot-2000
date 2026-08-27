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

function safeJoinDir(dir, fileName) {
  const base = path.basename(String(fileName || ""));
  if (!base || base === "." || base === "..") return null;
  const root = path.resolve(dir);
  const resolved = path.resolve(root, base);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function findPackage(config, fileName) {
  const raw = String(fileName || "").trim();
  if (!raw) throw new Error("Package name required");
  // Basename only — reject traversal / separators
  if (raw.includes("..") || /[\\/]/.test(raw) || path.basename(raw) !== raw) {
    throw new Error("Invalid package name (use basename only, e.g. backup.zip)");
  }
  for (const dir of [config.restoreDir, config.backupsDir]) {
    const candidate = safeJoinDir(dir, raw);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
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

function pruneBackups(config, { keep = 14 } = {}) {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const files = fs
    .readdirSync(config.backupsDir)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => {
      const p = path.join(config.backupsDir, f);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name: f, path: p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  for (const f of files.slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(f.path);
      removed.push(f.name);
    } catch (e) {
      console.warn("[backup] prune failed", f.name, e.message);
    }
  }
  return { kept: files.slice(0, keep).map((f) => f.name), removed };
}

function startAutoBackup(config) {
  // Nightly backup (local TZ from process / compose TZ)
  cron.schedule("0 2 * * *", () => {
    try {
      const pkg = createPackage(config, { reason: "nightly" });
      const prune = pruneBackups(config, { keep: 14 });
      console.log(
        "[backup] nightly",
        pkg.name,
        `kept=${prune.kept.length} removed=${prune.removed.length}`
      );
    } catch (e) {
      console.error("[backup] nightly failed", e.message);
    }
  });
  console.log("[backup] nightly scheduled at 02:00 (keep last 14)");
}

module.exports = {
  createPackage,
  listRestoreCandidates,
  findPackage,
  restorePackage,
  pruneBackups,
  startAutoBackup,
};
