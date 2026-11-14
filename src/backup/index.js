const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const AdmZip = require("adm-zip");
const db = require("../db");

// 04:00 gibt es am EU-Frühjahrs- und Herbstumstellungstag genau einmal.
const BACKUP_CRON = "0 4 * * *";

let snapshotSeq = 0;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function unlinkQuiet(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      console.error("[backup] cleanup failed:", filePath, e.message);
    }
  }
}

/**
 * Drop SQLite sidecars for a database path. Missing files are fine.
 * Unlink first; if the file is busy, rename it aside so it is no longer
 * named `-wal` / `-shm` (SQLite would otherwise replay it).
 */
function removeSidecars(dbPath) {
  if (!dbPath || typeof dbPath !== "string") {
    throw new Error("removeSidecars: database path required");
  }
  for (const side of ["-wal", "-shm"]) {
    const sidecar = dbPath + side;
    try {
      fs.unlinkSync(sidecar);
    } catch (unlinkErr) {
      if (unlinkErr && unlinkErr.code === "ENOENT") continue;
      const aside = `${sidecar}.aside-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(sidecar, aside);
      } catch (renameErr) {
        if (renameErr && renameErr.code === "ENOENT") continue;
        console.error("[backup] sidecar remove failed:", sidecar, renameErr.message);
        throw new Error(`Restore sidecar remove failed: ${renameErr.message}`);
      }
    }
  }
}

function createPackage(config, { reason = "backup", retain = false } = {}) {
  // retain=true → Ablage in data/backups/season-start/ (ewig aufbewahrt, nie vom
  // nächtlichen Prune gelöscht). Für das Saison-Start-Backup mit den Tipps.
  const dir = retain
    ? path.join(config.backupsDir, "season-start")
    : config.backupsDir;
  fs.mkdirSync(dir, { recursive: true });
  const season = db.getActiveSeason();
  const stats = db.statsSnapshot();
  const name = `season-${season.year}-${timestamp()}-${reason}.zip`;
  const outPath = path.join(dir, name);
  // `<name>.tmp` — does not end in `.zip`, so listRestoreCandidates ignores it.
  const tmpZip = `${outPath}.tmp`;
  const snapPath = path.join(
    dir,
    `.snapshot-${process.pid}-${Date.now()}-${snapshotSeq++}.sqlite`
  );

  let published = false;
  try {
    // Checkpoint, then a consistent copy. The live file is not what goes
    // into the zip: an open WAL must not be packed next to a new main file.
    // VACUUM INTO stays synchronous — db.backup() is async and createPackage
    // is called without await.
    db.getDb().pragma("wal_checkpoint(TRUNCATE)");
    db.getDb().prepare("VACUUM INTO ?").run(snapPath);

    const zip = new AdmZip();
    zip.addLocalFile(snapPath, "", "deathbot.sqlite");
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
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
    zip.writeZip(tmpZip);
    if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) {
      throw new Error("Backup zip was not written");
    }
    fs.renameSync(tmpZip, outPath);
    published = true;
  } finally {
    unlinkQuiet(snapPath);
    unlinkQuiet(snapPath + "-wal");
    unlinkQuiet(snapPath + "-shm");
    if (!published) unlinkQuiet(tmpZip);
  }

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

  const written = path.join(path.dirname(config.dbPath), `.restore.tmp.${process.pid}.sqlite`);
  // Write to a sibling temp file first: if writing/parsing fails the live DB is
  // never touched.
  fs.writeFileSync(written, entry.getData());

  // Validate BEFORE touching the live DB: the package could be corrupt or not a
  // real SQLite file at all. Opening it read-only fails fast on garbage; we
  // never swap a broken file over a working database. This is the difference
  // between "restore failed" (live DB untouched) and "restore destroyed the
  // live DB then failed" (the pre-fix behaviour).
  const Database = require("better-sqlite3");
  let sanity = null;
  try {
    sanity = new Database(written, { readonly: true });
    sanity.prepare("SELECT COUNT(*) AS c FROM sqlite_master").get();
  } catch (e) {
    try {
      fs.unlinkSync(written);
    } catch {
      /* ignore */
    }
    throw new Error(`Restore invalid (not a usable database): ${e.message}`);
  } finally {
    if (sanity) {
      try {
        sanity.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Close first so SQLite releases -wal/-shm. Sidecars must be gone BEFORE
  // the new file occupies config.dbPath — otherwise the old WAL is replayed
  // onto the restored database.
  let swapped = false;
  db.closeDb();
  try {
    // Via module.exports so tests can record the call order.
    module.exports.removeSidecars(config.dbPath);
    console.log("[backup] restore: removed -wal/-shm before replacing the database");
    fs.renameSync(written, config.dbPath);
    swapped = true;
    console.log("[backup] restore: database file replaced");
  } finally {
    if (!swapped) {
      try {
        if (fs.existsSync(written)) fs.unlinkSync(written);
      } catch {
        /* ignore */
      }
    }
    // reopen is best-effort (itself retries once internally); if it still fails,
    // the bot must not silently run on a stale/closed DB.
    try {
      db.reopenDb(config);
    } catch (e) {
      console.error("[backup] restore reopen failed — DB unavailable:", e.message);
      throw new Error(`Restore reopened DB failed: ${e.message}`);
    }
  }

  return { manifest, safety: safety.name, restored: fileName };
}

function pruneBackups(config, { keep = 14 } = {}) {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  // Nur die Wurzel rotieren. Der Unterordner season-start/ (die ewig
  // aufbewahrten Saison-Start-Backups mit den Tipps) wird NIEMALS gelöscht.
  const files = fs
    .readdirSync(config.backupsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".zip"))
    .map((e) => {
      const p = path.join(config.backupsDir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name: e.name, path: p, mtimeMs };
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

function startAutoBackup(config, client) {
  // 04:00 gibt es am EU-Frühjahrs- und Herbstumstellungstag genau einmal.
  cron.schedule(
    BACKUP_CRON,
    () => {
      try {
        const pkg = createPackage(config, { reason: "nightly" });
        const prune = pruneBackups(config, { keep: 14 });
        console.log(
          "[backup] nightly",
          pkg.name,
          `kept=${prune.kept.length} removed=${prune.removed.length}`
        );
        // Nacht-Backup ist KEIN Wiki-Scan -> darf in den Logkanal.
        if (client) {
          const { logEvent } = require("../discord/log");
          logEvent(client, config, {
            kind: "backup",
            summary: `Nacht-Backup: ${pkg.name} (kept=${prune.kept.length} removed=${prune.removed.length})`,
          }).catch(() => {});
        }
      } catch (e) {
        console.error("[backup] nightly failed", e.message);
        if (client) {
          const { logError } = require("../discord/log");
          logError(client, config, e, { where: "nightly backup" }).catch(() => {});
        }
      }
    },
    { timezone: config.tz }
  );
  console.log(`[backup] nightly scheduled at 04:00 (tz=${config.tz}, keep last 14)`);
}

module.exports = {
  BACKUP_CRON,
  createPackage,
  listRestoreCandidates,
  findPackage,
  restorePackage,
  removeSidecars,
  pruneBackups,
  startAutoBackup,
};
