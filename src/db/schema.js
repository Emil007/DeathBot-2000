const fs = require("fs");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  phase TEXT,
  announce_channel_id TEXT,
  announce_note TEXT,
  deathpool_channel_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  discord_user_id TEXT NOT NULL UNIQUE,
  base_points INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS celebs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  age_at_pick INTEGER,
  sheet_age_hint INTEGER,
  description TEXT,
  is_alive INTEGER NOT NULL DEFAULT 1,
  died_at TEXT,
  wiki_url TEXT,
  wiki_url_norm TEXT,
  wiki_url_de TEXT,
  wikidata_id TEXT,
  wiki_confirmed INTEGER NOT NULL DEFAULT 0,
  manual_only INTEGER NOT NULL DEFAULT 0,
  exclude_from_auto INTEGER NOT NULL DEFAULT 0,
  death_confirmed INTEGER NOT NULL DEFAULT 0,
  death_detected_at TEXT,
  death_source TEXT,
  death_list_url TEXT,
  death_announced_at TEXT,
  retract_pending INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_celebs_wiki_url_norm
  ON celebs(wiki_url_norm) WHERE wiki_url_norm IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_celebs_wikidata_id
  ON celebs(wikidata_id) WHERE wikidata_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS celeb_review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  celeb_id INTEGER NOT NULL UNIQUE,
  proposed_wiki_url TEXT,
  proposed_age INTEGER,
  proposed_lang TEXT,
  proposed_candidates TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  season_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS picks (
  player_id INTEGER NOT NULL,
  celeb_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  age_at_pick INTEGER,
  PRIMARY KEY (player_id, celeb_id, season_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
);

-- Pre-Start-Todeswarnung für announced-Picks: pro (Saison, Celeb, Player) genau
-- einmal melden, damit der 2027er-Selbstbedienungs-Flow nie doppelt stört.
CREATE TABLE IF NOT EXISTS pick_death_warnings (
  season_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  celeb_id INTEGER NOT NULL,
  warned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season_id, player_id, celeb_id),
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS celeb_aka (
  celeb_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (celeb_id, alias),
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS celeb_blacklist (
  celeb_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  PRIMARY KEY (celeb_id, term),
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bonuses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  points INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_bonuses (
  player_id INTEGER NOT NULL,
  bonus_id TEXT NOT NULL,
  times INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (player_id, bonus_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (bonus_id) REFERENCES bonuses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS death_awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  celeb_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  points INTEGER NOT NULL,
  season_id INTEGER,
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS celeb_url_wait (
  admin_user_id TEXT PRIMARY KEY,
  celeb_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pick_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  unlinked_ack INTEGER NOT NULL DEFAULT 0,
  UNIQUE (player_id, season_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pick_draft_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  raw_name TEXT NOT NULL,
  wiki_url TEXT,
  wiki_norm TEXT,
  qid TEXT,
  proposed_age INTEGER,
  candidates_json TEXT,
  link_status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (draft_id) REFERENCES pick_drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_pastes (
  discord_user_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS season_point_snapshots (
  season_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  base_points INTEGER NOT NULL DEFAULT 0,
  bonus_points INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  snapshotted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season_id, player_id),
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wiki_seen (
  entry_id TEXT PRIMARY KEY,
  lang TEXT,
  text TEXT,
  url TEXT,
  qid TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  announced_at TEXT
);

CREATE TABLE IF NOT EXISTS announced_deaths (
  entry_id TEXT PRIMARY KEY,
  name TEXT,
  url TEXT,
  lang TEXT,
  qid TEXT,
  announced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phrase_history (
  phrase_hash TEXT PRIMARY KEY,
  used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Zielspalten von celebs. Frisches SCHEMA und der Rebuild müssen dieselben
// Namen tragen. name_key ist absichtlich nicht UNIQUE.
const CELEB_COLUMNS = [
  ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
  ["name", "TEXT NOT NULL"],
  ["name_key", "TEXT NOT NULL"],
  ["age_at_pick", "INTEGER"],
  ["sheet_age_hint", "INTEGER"],
  ["description", "TEXT"],
  ["is_alive", "INTEGER NOT NULL DEFAULT 1"],
  ["died_at", "TEXT"],
  ["wiki_url", "TEXT"],
  ["wiki_url_norm", "TEXT"],
  ["wiki_url_de", "TEXT"],
  ["wikidata_id", "TEXT"],
  ["wiki_confirmed", "INTEGER NOT NULL DEFAULT 0"],
  ["manual_only", "INTEGER NOT NULL DEFAULT 0"],
  ["exclude_from_auto", "INTEGER NOT NULL DEFAULT 0"],
  ["death_confirmed", "INTEGER NOT NULL DEFAULT 0"],
  ["death_detected_at", "TEXT"],
  ["death_source", "TEXT"],
  ["death_list_url", "TEXT"],
  ["death_announced_at", "TEXT"],
  ["retract_pending", "INTEGER NOT NULL DEFAULT 0"],
];

const LEGACY_NAME_KEY_UNIQUE = /name_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i;

function assertIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`migrate: unexpected sqlite identifier ${JSON.stringify(name)}`);
  }
  return name;
}

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function tableCols(db, table) {
  assertIdent(table);
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function legacyNameKeyUnique(db) {
  const meta = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'celebs'`)
    .get();
  return !!(meta && meta.sql && LEGACY_NAME_KEY_UNIQUE.test(meta.sql));
}

function mainDbFile(db) {
  const rows = db.prepare(`PRAGMA database_list`).all();
  const main = rows.find((r) => r.name === "main");
  if (!main || !main.file) {
    throw new Error(
      "migrate: PRAGMA database_list has no main database file; refusing to rebuild celebs"
    );
  }
  return main.file;
}

function ensureCelebColumns(db) {
  if (!tableExists(db, "celebs")) return;
  const have = tableCols(db, "celebs");
  for (const [name, type] of CELEB_COLUMNS) {
    if (name === "id" || have.has(name)) continue;
    db.exec(`ALTER TABLE celebs ADD COLUMN ${name} ${type}`);
  }
}

// Dieselbe Rundlauf-Regel wie parseCalendarDate, lokal gehalten, damit
// schema.js time.js nicht lädt. Exakt YYYY-MM-DD, und Date.UTC(y, m-1, d)
// muss auf dasselbe Jahr, denselben Monat und denselben Tag fallen.
function isRoundTripCalendarDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

function dropUniqueNameKeyIndexes(db) {
  const indexes = db.prepare(`PRAGMA index_list(celebs)`).all();
  for (const idx of indexes) {
    if (!idx.unique || !idx.name || String(idx.name).startsWith("sqlite_autoindex")) continue;
    const indexName = assertIdent(idx.name);
    const info = db.prepare(`PRAGMA index_info(${indexName})`).all();
    if (info.length === 1 && info[0].name === "name_key") {
      db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
  }
}

function healDuplicateActive(db) {
  if (!tableCols(db, "seasons").has("live")) return;
  // live = 1 gewinnt; bei mehreren (oder keinem) die kleinste id.
  // Nur active wird geändert.
  const rows = db
    .prepare(
      `SELECT id FROM seasons
       WHERE active = 1
       ORDER BY CASE WHEN live = 1 THEN 0 ELSE 1 END, id ASC`
    )
    .all();
  if (rows.length <= 1) return;
  const keeperId = rows[0].id;
  const clear = db.prepare(`UPDATE seasons SET active = 0 WHERE id = ? AND active = 1`);
  for (const row of rows) {
    if (row.id !== keeperId) clear.run(row.id);
  }
}

function healNullPhases(db, liveAddedThisRun) {
  const cols = tableCols(db, "seasons");
  if (!cols.has("phase")) return;
  if (liveAddedThisRun) {
    // Die gerade mit DEFAULT 0 angelegte live-Spalte ist keine Phasenquelle.
    db.exec(`UPDATE seasons SET phase = 'running' WHERE phase IS NULL AND active = 1`);
    db.exec(`UPDATE seasons SET phase = 'archived' WHERE phase IS NULL AND active = 0`);
    return;
  }
  if (!cols.has("live")) return;
  db.exec(`
    UPDATE seasons SET phase = 'running'  WHERE phase IS NULL AND active = 1 AND live = 1;
    UPDATE seasons SET phase = 'setup'    WHERE phase IS NULL AND active = 1 AND live = 0;
    UPDATE seasons SET phase = 'archived' WHERE phase IS NULL AND active = 0;
  `);
}

function healStartDates(db) {
  const cols = tableCols(db, "seasons");
  if (!cols.has("start_date") || !cols.has("year")) return;
  db.exec(`
    UPDATE seasons
    SET start_date = printf('%04d-01-01', year)
    WHERE start_date IS NULL OR start_date = ''
  `);
  const rows = db.prepare(`SELECT id, year, start_date FROM seasons`).all();
  const fixedFor = db.prepare(`SELECT printf('%04d-01-01', ?) AS s`);
  const apply = db.prepare(
    `UPDATE seasons SET start_date = printf('%04d-01-01', year) WHERE id = ?`
  );
  for (const row of rows) {
    if (row.start_date == null || row.start_date === "") continue;
    if (isRoundTripCalendarDate(row.start_date)) continue;
    const fixed = fixedFor.get(row.year).s;
    console.error(
      `[db] migrate: season ${row.id} has invalid start_date ${JSON.stringify(row.start_date)} (year ${row.year}); resetting start_date to ${fixed}`
    );
    apply.run(row.id);
  }
}

function healNullAwardSeasons(db) {
  const cols = tableCols(db, "death_awards");
  if (!cols.has("season_id")) return;
  const actives = db.prepare(`SELECT id FROM seasons WHERE active = 1 ORDER BY id ASC`).all();
  if (actives.length !== 1) return;
  const activeId = actives[0].id;
  const nullRows = db
    .prepare(
      `SELECT id, celeb_id, player_id FROM death_awards
       WHERE season_id IS NULL
       ORDER BY id ASC`
    )
    .all();
  const slotTaken = db.prepare(
    `SELECT 1 AS x FROM death_awards
     WHERE celeb_id = ? AND player_id = ? AND season_id = ? AND id <> ?`
  );
  const fill = db.prepare(`UPDATE death_awards SET season_id = ? WHERE id = ?`);
  const del = db.prepare(`DELETE FROM death_awards WHERE id = ?`);
  for (const row of nullRows) {
    if (slotTaken.get(row.celeb_id, row.player_id, activeId, row.id)) del.run(row.id);
    else fill.run(activeId, row.id);
  }
}

function ensureAwardSeason(db) {
  const cols = tableCols(db, "death_awards");
  if (cols.size && !cols.has("season_id")) {
    db.exec(`ALTER TABLE death_awards ADD COLUMN season_id INTEGER`);
  }
}

function ensureUnlinkedAck(db) {
  const cols = tableCols(db, "pick_drafts");
  if (cols.size && !cols.has("unlinked_ack")) {
    db.exec(`ALTER TABLE pick_drafts ADD COLUMN unlinked_ack INTEGER NOT NULL DEFAULT 0`);
  }
}

function recreateCelebPartialIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_celebs_wiki_url_norm
      ON celebs(wiki_url_norm) WHERE wiki_url_norm IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_celebs_wikidata_id
      ON celebs(wikidata_id) WHERE wikidata_id IS NOT NULL;
  `);
}

function rebuildCelebs(db) {
  const file = mainDbFile(db);
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)");
  if (Array.isArray(checkpoint) && checkpoint.some((row) => Number(row.busy) !== 0)) {
    throw new Error(
      "migrate: wal_checkpoint(TRUNCATE) was busy; refusing to rebuild celebs without a consistent backup"
    );
  }
  const dest = `${file}.pre-rebuild-${new Date().toISOString()}.sqlite`;
  try {
    fs.copyFileSync(file, dest);
  } catch (err) {
    throw new Error(
      `migrate: backup copy failed (${file} -> ${dest}): ${err.message}. Rebuild aborted.`
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  if (Number(db.pragma("foreign_keys", { simple: true })) !== 0) {
    throw new Error(
      "migrate: PRAGMA foreign_keys=OFF did not take effect; refusing to rebuild celebs"
    );
  }

  const colList = CELEB_COLUMNS.map(([name]) => name).join(", ");
  const ddl = CELEB_COLUMNS.map(([name, type]) => `${name} ${type}`).join(",\n  ");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureCelebColumns(db);
    db.exec(`DROP TABLE IF EXISTS celebs_new`);
    db.exec(`CREATE TABLE celebs_new (\n  ${ddl}\n)`);
    db.exec(`INSERT INTO celebs_new (${colList}) SELECT ${colList} FROM celebs`);
    db.exec(`DROP TABLE celebs`);
    db.exec(`ALTER TABLE celebs_new RENAME TO celebs`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {
      /* transaction already closed */
    }
    try {
      db.exec("PRAGMA foreign_keys = ON");
    } catch (_) {
      /* best effort so the connection does not stay unconstrained */
    }
    throw err;
  }

  db.exec("PRAGMA foreign_keys = ON");
  if (Number(db.pragma("foreign_keys", { simple: true })) !== 1) {
    throw new Error("migrate: PRAGMA foreign_keys=ON failed after celebs rebuild");
  }
  recreateCelebPartialIndexes(db);
}

function applyUpgrades(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const userVersion = Number(db.pragma("user_version", { simple: true })) || 0;
    const seasonBefore = tableCols(db, "seasons");
    // Flag vor dem ADD COLUMN: DEFAULT 0 wäre sonst nicht von einem echten 0 zu unterscheiden.
    const liveAddedThisRun = seasonBefore.size > 0 && !seasonBefore.has("live");
    if (seasonBefore.size) {
      if (!seasonBefore.has("start_date")) db.exec(`ALTER TABLE seasons ADD COLUMN start_date TEXT`);
      if (!seasonBefore.has("live")) {
        db.exec(`ALTER TABLE seasons ADD COLUMN live INTEGER NOT NULL DEFAULT 0`);
      }
      if (!seasonBefore.has("announce_channel_id")) {
        db.exec(`ALTER TABLE seasons ADD COLUMN announce_channel_id TEXT`);
      }
      // F06: Deathpool-Versandkanal (nach dem 01.01. der neue deathpool-{YEAR}-Kanal),
      // getrennt vom Anmeldungskanal (announce_channel_id).
      if (!seasonBefore.has("deathpool_channel_id")) {
        db.exec(`ALTER TABLE seasons ADD COLUMN deathpool_channel_id TEXT`);
      }
      if (!seasonBefore.has("announce_note")) {
        db.exec(`ALTER TABLE seasons ADD COLUMN announce_note TEXT`);
      }
      if (!seasonBefore.has("phase")) db.exec(`ALTER TABLE seasons ADD COLUMN phase TEXT`);
    }

    ensureCelebColumns(db);

    const reviewCols = tableCols(db, "celeb_review_queue");
    if (reviewCols.size && !reviewCols.has("proposed_candidates")) {
      db.exec(`ALTER TABLE celeb_review_queue ADD COLUMN proposed_candidates TEXT`);
    }
    if (reviewCols.size && !reviewCols.has("season_id")) {
      db.exec(`ALTER TABLE celeb_review_queue ADD COLUMN season_id INTEGER`);
    }

    const pickCols = tableCols(db, "picks");
    if (pickCols.size && !pickCols.has("age_at_pick")) {
      db.exec(`ALTER TABLE picks ADD COLUMN age_at_pick INTEGER`);
    }

    ensureAwardSeason(db);

    const seenCols = tableCols(db, "wiki_seen");
    if (seenCols.size && !seenCols.has("qid")) db.exec(`ALTER TABLE wiki_seen ADD COLUMN qid TEXT`);
    const annCols = tableCols(db, "announced_deaths");
    if (annCols.size && !annCols.has("qid")) db.exec(`ALTER TABLE announced_deaths ADD COLUMN qid TEXT`);

    ensureUnlinkedAck(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS celeb_review_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        celeb_id INTEGER NOT NULL UNIQUE,
        proposed_wiki_url TEXT,
        proposed_age INTEGER,
        proposed_lang TEXT,
        proposed_candidates TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS death_awards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        celeb_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        points INTEGER NOT NULL,
        awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS celeb_url_wait (
        admin_user_id TEXT PRIMARY KEY,
        celeb_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pick_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        season_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        unlinked_ack INTEGER NOT NULL DEFAULT 0,
        UNIQUE (player_id, season_id),
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
        FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pick_draft_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        raw_name TEXT NOT NULL,
        wiki_url TEXT,
        wiki_norm TEXT,
        qid TEXT,
        proposed_age INTEGER,
        candidates_json TEXT,
        link_status TEXT NOT NULL DEFAULT 'pending',
        FOREIGN KEY (draft_id) REFERENCES pick_drafts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pending_pastes (
        discord_user_id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS season_point_snapshots (
        season_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        base_points INTEGER NOT NULL DEFAULT 0,
        bonus_points INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        snapshotted_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (season_id, player_id),
        FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
    `);

    ensureUnlinkedAck(db);
    ensureAwardSeason(db);
    const reviewAfter = tableCols(db, "celeb_review_queue");
    if (reviewAfter.size && !reviewAfter.has("proposed_candidates")) {
      db.exec(`ALTER TABLE celeb_review_queue ADD COLUMN proposed_candidates TEXT`);
    }
    if (reviewAfter.size && !reviewAfter.has("season_id")) {
      db.exec(`ALTER TABLE celeb_review_queue ADD COLUMN season_id INTEGER`);
    }

    // Duplicate-Heilung vor dem phase-NULL-Backfill: eine gerade deaktivierte
    // Zeile ist inaktiv und bekommt archived, statt mit der alten active-Rolle
    // running/setup zu bleiben. Bereits gesetzte Phasen bleiben stehen.
    healDuplicateActive(db);
    healNullPhases(db, liveAddedThisRun);
    healStartDates(db);
    healNullAwardSeasons(db);

    if (tableExists(db, "celebs")) {
      dropUniqueNameKeyIndexes(db);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_celebs_name_key ON celebs(name_key)`);
      recreateCelebPartialIndexes(db);
    }

    if (tableCols(db, "celeb_review_queue").has("season_id")) {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_review_season_status ON celeb_review_queue(season_id, status)`
      );
    }
    if (tableCols(db, "death_awards").has("season_id")) {
      db.exec(`DROP INDEX IF EXISTS idx_death_awards_celeb_player`);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_death_awards_celeb_player_season
        ON death_awards(celeb_id, player_id, season_id)
      `);
    }
    // Erst nach der Duplicate-Heilung, sonst scheitert der partielle Unique-Index.
    if (tableExists(db, "seasons")) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_seasons_one_active
        ON seasons(active) WHERE active = 1
      `);
    }

    if (userVersion < 1) {
      db.exec(`
        UPDATE celebs
        SET death_announced_at = COALESCE(death_detected_at, datetime('now'))
        WHERE is_alive = 0 AND death_announced_at IS NULL
      `);
      db.exec(`PRAGMA user_version = 1`);
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (_) {
      /* transaction already closed */
    }
    throw err;
  }
}

function migrate(db) {
  db.exec("PRAGMA busy_timeout = 10000");
  if (legacyNameKeyUnique(db)) rebuildCelebs(db);
  applyUpgrades(db);
}

module.exports = { SCHEMA, migrate };
