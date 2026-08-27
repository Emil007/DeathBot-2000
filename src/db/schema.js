const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  live INTEGER NOT NULL DEFAULT 0,
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
  wiki_confirmed INTEGER NOT NULL DEFAULT 0,
  manual_only INTEGER NOT NULL DEFAULT 0,
  exclude_from_auto INTEGER NOT NULL DEFAULT 0,
  death_confirmed INTEGER NOT NULL DEFAULT 0,
  death_detected_at TEXT,
  death_source TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_celebs_wiki_url_norm
  ON celebs(wiki_url_norm) WHERE wiki_url_norm IS NOT NULL;

CREATE TABLE IF NOT EXISTS celeb_review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  celeb_id INTEGER NOT NULL UNIQUE,
  proposed_wiki_url TEXT,
  proposed_age INTEGER,
  proposed_lang TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS picks (
  player_id INTEGER NOT NULL,
  celeb_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  PRIMARY KEY (player_id, celeb_id, season_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
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
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wiki_seen (
  entry_id TEXT PRIMARY KEY,
  lang TEXT,
  text TEXT,
  url TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  announced_at TEXT
);

CREATE TABLE IF NOT EXISTS announced_deaths (
  entry_id TEXT PRIMARY KEY,
  name TEXT,
  url TEXT,
  lang TEXT,
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

function migrate(db) {
  const cols = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

  const seasonCols = cols("seasons");
  if (!seasonCols.has("start_date")) db.exec(`ALTER TABLE seasons ADD COLUMN start_date TEXT`);
  if (!seasonCols.has("live")) db.exec(`ALTER TABLE seasons ADD COLUMN live INTEGER NOT NULL DEFAULT 0`);

  const celebCols = cols("celebs");
  const addCeleb = (name, ddl) => {
    if (!celebCols.has(name)) db.exec(`ALTER TABLE celebs ADD COLUMN ${ddl}`);
  };
  addCeleb("death_confirmed", "death_confirmed INTEGER NOT NULL DEFAULT 0");
  addCeleb("death_detected_at", "death_detected_at TEXT");
  addCeleb("death_source", "death_source TEXT");
  addCeleb("wiki_confirmed", "wiki_confirmed INTEGER NOT NULL DEFAULT 0");
  addCeleb("manual_only", "manual_only INTEGER NOT NULL DEFAULT 0");
  addCeleb("wiki_url_norm", "wiki_url_norm TEXT");
  addCeleb("wiki_url_de", "wiki_url_de TEXT");
  addCeleb("sheet_age_hint", "sheet_age_hint INTEGER");

  // Drop unique on name_key if present (SQLite: rebuild when legacy unique index exists)
  const indexes = db.prepare(`PRAGMA index_list(celebs)`).all();
  for (const idx of indexes) {
    if (idx.unique && idx.name && !idx.name.startsWith("sqlite_autoindex")) {
      const info = db.prepare(`PRAGMA index_info(${idx.name})`).all();
      if (info.length === 1 && info[0].name === "name_key") {
        db.exec(`DROP INDEX IF EXISTS ${idx.name}`);
      }
    }
  }
  // sqlite_autoindex from UNIQUE column constraint — rebuild table once
  const meta = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='celebs'`).get();
  if (meta?.sql && /name_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(meta.sql)) {
    db.exec(`
      BEGIN;
      CREATE TABLE celebs_new (
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
        wiki_confirmed INTEGER NOT NULL DEFAULT 0,
        manual_only INTEGER NOT NULL DEFAULT 0,
        exclude_from_auto INTEGER NOT NULL DEFAULT 0,
        death_confirmed INTEGER NOT NULL DEFAULT 0,
        death_detected_at TEXT,
        death_source TEXT
      );
      INSERT INTO celebs_new (
        id, name, name_key, age_at_pick, sheet_age_hint, description, is_alive, died_at,
        wiki_url, wiki_url_norm, wiki_url_de, wiki_confirmed, manual_only, exclude_from_auto,
        death_confirmed, death_detected_at, death_source
      )
      SELECT
        id, name, name_key, age_at_pick, sheet_age_hint, description, is_alive, died_at,
        wiki_url, wiki_url_norm, wiki_url_de, wiki_confirmed, manual_only, exclude_from_auto,
        death_confirmed, death_detected_at, death_source
      FROM celebs;
      DROP TABLE celebs;
      ALTER TABLE celebs_new RENAME TO celebs;
      COMMIT;
    `);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_celebs_wiki_url_norm
      ON celebs(wiki_url_norm) WHERE wiki_url_norm IS NOT NULL;

    CREATE TABLE IF NOT EXISTS celeb_review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      celeb_id INTEGER NOT NULL UNIQUE,
      proposed_wiki_url TEXT,
      proposed_age INTEGER,
      proposed_lang TEXT,
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
  `);
}

module.exports = { SCHEMA, migrate };
