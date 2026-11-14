#!/usr/bin/env node
/**
 * Opt-in cleanup for junk Wikipedia LIST/NAV-page announcements.
 *
 * Background: pruneJunkAnnouncements used to run destructively on every
 * startup. It is now removed from the boot path; this script is the explicit,
 * safe replacement.
 *
 * Usage:
 *   node scripts/prune-junk-announcements.js             # dry-run (default)
 *   DATA_DIR=/path node scripts/prune-junk-announcements.js --apply
 *   ... --apply --force                                  # ignore already-run marker
 *
 * Standalone operation: only DATA_DIR is needed (defaults to ./data next to
 * the repo). Creates a safety backup before deleting. Records a meta marker so
 * it won't silently re-run; --force bypasses that guard.
 */
const path = require("path");
const fs = require("fs");
const db = require("../src/db");
const { createPackage } = require("../src/backup");

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const config = {
  dataDir,
  dbPath: path.join(dataDir, "deathbot.sqlite"),
  backupsDir: path.join(dataDir, "backups"),
  restoreDir: path.join(dataDir, "restore"),
};

console.log("db:", config.dbPath);
if (!fs.existsSync(config.dbPath)) {
  console.error(`Datenbank nicht gefunden: ${config.dbPath}`);
  process.exit(2);
}

let exitCode = 0;
db.openDb(config);
try {
  const count = db.countJunkAnnouncements();
  console.log(
    apply ? "Mode: APPLY" : "Mode: DRY-RUN (add --apply to delete)",
    `| junk list-page announcements: ${count}`
  );

  if (!count) {
    console.log("Nichts zu bereinigen.");
  } else if (apply) {
    const runBefore = db.getMeta("junk_prune_last_run");
    if (runBefore && !force) {
      console.log(`Junk-Prune lief bereits am ${runBefore}. --force ueberschreibt das.`);
      exitCode = 0;
    } else {
      // Safety backup BEFORE the destructive delete.
      const safety = createPackage(config, { reason: "pre-junk-prune" });
      console.log("Safety-Backup erstellt:", safety.name);
      const removed = db.pruneJunkAnnouncements();
      console.log(`Bereinigt: ${removed} Eintraege entfernt.`);
    }
  } else {
    console.log("Dry-run: keine Aenderungen. Mit --apply wirklich bereinigen.");
  }
} catch (e) {
  console.error("Fehler:", e.message);
  exitCode = 1;
} finally {
  db.closeDb();
}

process.exit(exitCode);
