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
  name_key TEXT NOT NULL UNIQUE,
  age_at_pick INTEGER,
  description TEXT,
  is_alive INTEGER NOT NULL DEFAULT 1,
  died_at TEXT,
  wiki_url TEXT,
  exclude_from_auto INTEGER NOT NULL DEFAULT 0,
  death_confirmed INTEGER NOT NULL DEFAULT 0,
  death_detected_at TEXT,
  death_source TEXT
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
  if (!seasonCols.has("start_date")) {
    db.exec(`ALTER TABLE seasons ADD COLUMN start_date TEXT`);
  }
  if (!seasonCols.has("live")) {
    db.exec(`ALTER TABLE seasons ADD COLUMN live INTEGER NOT NULL DEFAULT 0`);
  }

  const celebCols = cols("celebs");
  if (!celebCols.has("death_confirmed")) {
    db.exec(`ALTER TABLE celebs ADD COLUMN death_confirmed INTEGER NOT NULL DEFAULT 0`);
  }
  if (!celebCols.has("death_detected_at")) {
    db.exec(`ALTER TABLE celebs ADD COLUMN death_detected_at TEXT`);
  }
  if (!celebCols.has("death_source")) {
    db.exec(`ALTER TABLE celebs ADD COLUMN death_source TEXT`);
  }

  db.exec(`
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
