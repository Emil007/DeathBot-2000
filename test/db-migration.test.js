const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-m2-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmpRoot;

const { SCHEMA, migrate } = require("../src/db/schema");

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function withDb(setup, fn) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "case-"));
  const file = path.join(dir, "bot.sqlite");
  const db = new Database(file);
  try {
    if (setup) db.exec(setup);
    return fn(db, file, dir);
  } finally {
    try {
      db.close();
    } catch (_) {
      /* already closed */
    }
  }
}

function colNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function userVersion(db) {
  return Number(db.pragma("user_version", { simple: true }));
}

function backupsOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.pre-rebuild-`) && name.endsWith(".sqlite"));
}

function indexByName(db, table, name) {
  return db.prepare(`PRAGMA index_list(${table})`).all().find((idx) => idx.name === name);
}

function seasonCore(db) {
  return db
    .prepare(
      `SELECT id, year, start_date, live, phase, active FROM seasons ORDER BY id ASC`
    )
    .all();
}

const PLAYERS = `
CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  discord_user_id TEXT NOT NULL UNIQUE,
  base_points INTEGER NOT NULL DEFAULT 0
);
`;

const MIN_CELEBS = `
CREATE TABLE celebs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  is_alive INTEGER NOT NULL DEFAULT 1,
  death_detected_at TEXT
);
`;

const PARENTS = `${PLAYERS}${MIN_CELEBS}`;

test("rebuild keeps QID, picks, and the active season; second migrate does not restamp", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    CREATE TABLE players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      discord_user_id TEXT NOT NULL UNIQUE,
      base_points INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE celebs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      age_at_pick INTEGER,
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
      death_list_url TEXT
    );
    CREATE TABLE picks (
      player_id INTEGER NOT NULL,
      celeb_id INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      PRIMARY KEY (player_id, celeb_id, season_id),
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
      FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
    );
  `;

  withDb(setup, (db, file) => {
    db.pragma("journal_mode = WAL");
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase)
       VALUES (1, 2026, 1, '2026-01-01', 1, 'running')`
    ).run();
    db.prepare(
      `INSERT INTO players (id, display_name, discord_user_id, base_points)
       VALUES (1, 'Ada', 'ada', 40)`
    ).run();
    db.prepare(
      `INSERT INTO celebs (
         id, name, name_key, is_alive, wikidata_id, death_list_url, wiki_confirmed, exclude_from_auto
       ) VALUES (1, 'Ada Lovelace', 'ada lovelace', 1, 'Q7259', 'https://en.wikipedia.org/wiki/Deaths_in_2026', 1, 0)`
    ).run();
    db.prepare(
      `INSERT INTO celebs (
         id, name, name_key, is_alive, death_detected_at, wikidata_id, death_list_url
       ) VALUES (2, 'Gone', 'gone', 0, '2026-03-04 05:06:07', 'Q99', 'https://example.test/gone')`
    ).run();
    db.prepare(`INSERT INTO picks (player_id, celeb_id, season_id) VALUES (1, 1, 1)`).run();

    const seasonBefore = seasonCore(db);
    const aliveBefore = db.prepare(`SELECT * FROM celebs WHERE id = 1`).get();
    const deadBefore = db.prepare(`SELECT * FROM celebs WHERE id = 2`).get();
    const picksBefore = db
      .prepare(`SELECT player_id, celeb_id, season_id FROM picks`)
      .all();

    migrate(db);

    const aliveAfter = db.prepare(`SELECT * FROM celebs WHERE id = 1`).get();
    for (const key of Object.keys(aliveBefore)) {
      assert.strictEqual(aliveAfter[key], aliveBefore[key], `alive.${key}`);
    }
    assert.strictEqual(aliveAfter.death_announced_at, null);
    assert.strictEqual(aliveAfter.retract_pending, 0);
    assert.strictEqual(aliveAfter.wikidata_id, "Q7259");
    assert.strictEqual(
      aliveAfter.death_list_url,
      "https://en.wikipedia.org/wiki/Deaths_in_2026"
    );

    const deadAfter = db.prepare(`SELECT * FROM celebs WHERE id = 2`).get();
    for (const key of Object.keys(deadBefore)) {
      assert.strictEqual(deadAfter[key], deadBefore[key], `dead.${key}`);
    }
    assert.strictEqual(deadAfter.death_announced_at, "2026-03-04 05:06:07");
    assert.strictEqual(deadAfter.wikidata_id, "Q99");
    assert.strictEqual(deadAfter.death_list_url, "https://example.test/gone");

    assert.deepStrictEqual(
      db.prepare(`SELECT player_id, celeb_id, season_id FROM picks`).all(),
      picksBefore
    );
    assert.deepStrictEqual(seasonCore(db), seasonBefore);
    assert.strictEqual(seasonCore(db).length, 1);
    assert.strictEqual(userVersion(db), 1);
    assert.strictEqual(Number(db.pragma("foreign_keys", { simple: true })), 1);
    assert.strictEqual(Number(db.pragma("busy_timeout", { simple: true })), 10000);

    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'celebs'`)
      .get().sql;
    assert.doesNotMatch(sql, /name_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

    const copies = backupsOf(file);
    assert.strictEqual(copies.length, 1);
    const backup = new Database(path.join(path.dirname(file), copies[0]), { readonly: true });
    try {
      const backupSql = backup
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'celebs'`)
        .get().sql;
      assert.match(backupSql, /name_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
      assert.strictEqual(
        backup.prepare(`SELECT wikidata_id, death_list_url FROM celebs WHERE id = 1`).get()
          .wikidata_id,
        "Q7259"
      );
      assert.strictEqual(
        backup.prepare(`SELECT death_list_url FROM celebs WHERE id = 1`).get().death_list_url,
        "https://en.wikipedia.org/wiki/Deaths_in_2026"
      );
    } finally {
      backup.close();
    }

    const fresh = new Database(":memory:");
    try {
      fresh.exec(SCHEMA);
      migrate(fresh);
      assert.deepStrictEqual(colNames(db, "celebs").sort(), colNames(fresh, "celebs").sort());
    } finally {
      fresh.close();
    }

    const nameKey = indexByName(db, "celebs", "idx_celebs_name_key");
    assert.ok(nameKey);
    assert.strictEqual(nameKey.unique, 0);
    const oneActive = indexByName(db, "seasons", "idx_seasons_one_active");
    assert.ok(oneActive);
    assert.strictEqual(oneActive.unique, 1);

    const inserted = db
      .prepare(
        `INSERT INTO celebs (name, name_key, is_alive, death_detected_at)
         VALUES ('Later', 'later', 0, '2026-08-08 00:00:00')`
      )
      .run();
    migrate(db);

    assert.strictEqual(
      db.prepare(`SELECT wikidata_id FROM celebs WHERE id = 1`).get().wikidata_id,
      "Q7259"
    );
    assert.strictEqual(seasonCore(db).length, 1);
    assert.deepStrictEqual(seasonCore(db), seasonBefore);
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE id = ?`).get(inserted.lastInsertRowid)
        .death_announced_at,
      null
    );
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE id = 2`).get().death_announced_at,
      "2026-03-04 05:06:07"
    );
    assert.strictEqual(backupsOf(file).length, 1);
    assert.strictEqual(userVersion(db), 1);
    assert.strictEqual(db.prepare(`SELECT base_points FROM players WHERE id = 1`).get().base_points, 40);

    assert.doesNotThrow(() => {
      db.prepare(
        `INSERT INTO celebs (name, name_key, wikidata_id) VALUES ('Alias', 'ada lovelace', NULL)`
      ).run();
    });
    assert.throws(() => {
      db.prepare(`INSERT INTO celebs (name, name_key, wikidata_id) VALUES ('Dup', 'dup', 'Q7259')`).run();
    }, /UNIQUE/);
    assert.throws(() => {
      db.prepare(`INSERT INTO picks (player_id, celeb_id, season_id) VALUES (1, 99999, 1)`).run();
    }, /FOREIGN KEY/);
    const nextId = db.prepare(`INSERT INTO celebs (name, name_key) VALUES ('Next', 'next')`).run();
    assert.ok(Number(nextId.lastInsertRowid) > 2);
  });
});

test("fresh SCHEMA migrate sets version 1 and does not open a season or a backup", () => {
  withDb(null, (db, file) => {
    db.exec(SCHEMA);
    migrate(db);
    assert.strictEqual(userVersion(db), 1);
    assert.deepStrictEqual(backupsOf(file), []);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM seasons`).get().c, 0);
    assert.ok(colNames(db, "celebs").includes("death_announced_at"));
    assert.ok(colNames(db, "celebs").includes("retract_pending"));
    assert.ok(colNames(db, "pick_drafts").includes("unlinked_ack"));
    assert.ok(colNames(db, "pending_pastes").includes("body"));
    const oneActive = indexByName(db, "seasons", "idx_seasons_one_active");
    assert.strictEqual(oneActive.unique, 1);
    assert.match(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_seasons_one_active'`).get().sql,
      /WHERE active = 1/
    );
    db.prepare(`INSERT INTO pending_pastes (discord_user_id, body) VALUES ('u', 'paste')`).run();
    assert.strictEqual(db.prepare(`SELECT body FROM pending_pastes WHERE discord_user_id = 'u'`).get().body, "paste");
  });
});

test("old file gains announced, retract, unlinked_ack, and pending_pastes", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
    CREATE TABLE pick_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (player_id, season_id)
    );
  `;
  withDb(setup, (db, file) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase)
       VALUES (1, 2026, 1, '2026-01-01', 1, 'running')`
    ).run();
    db.prepare(`INSERT INTO celebs (id, name, name_key, is_alive) VALUES (1, 'A', 'a', 1)`).run();
    db.prepare(
      `INSERT INTO pick_drafts (id, player_id, season_id, status) VALUES (4, 9, 1, 'draft')`
    ).run();
    const before = seasonCore(db);
    migrate(db);
    assert.deepStrictEqual(seasonCore(db), before);
    assert.strictEqual(backupsOf(file).length, 0);
    assert.strictEqual(
      db.prepare(`SELECT retract_pending, death_announced_at FROM celebs WHERE id = 1`).get()
        .retract_pending,
      0
    );
    assert.strictEqual(
      db.prepare(`SELECT unlinked_ack FROM pick_drafts WHERE id = 4`).get().unlinked_ack,
      0
    );
    assert.ok(tableReady(db, "pending_pastes"));
    assert.strictEqual(userVersion(db), 1);
  });
});

function tableReady(db, name) {
  return !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

test("NULL and empty start_date become 1 January and active stays", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase) VALUES
       (1, 2026, 1, NULL, 1, 'running'),
       (2, 2025, 0, '', 0, 'setup')`
    ).run();
    const errors = [];
    const orig = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      migrate(db);
    } finally {
      console.error = orig;
    }
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(seasonCore(db), [
      { id: 1, year: 2026, start_date: "2026-01-01", live: 1, phase: "running", active: 1 },
      { id: 2, year: 2025, start_date: "2025-01-01", live: 0, phase: "setup", active: 0 },
    ]);
  });
});

test("invalid start_date resets to that row's year and valid ISO stays byte-identical", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase) VALUES
       (1, 2027, 0, '01.01.2027', 0, 'announced'),
       (2, 2024, 0, '2027/01/01', 0, 'archived'),
       (3, 2029, 0, '2027-1-1', 0, 'setup'),
       (4, 2027, 0, '2027-02-29', 0, 'archived'),
       (5, 2030, 0, '2027-02-31', 0, 'archived'),
       (6, 2028, 0, '2028-02-29', 0, 'archived'),
       (7, 2026, 1, '2026-01-01', 1, 'running'),
       (8, 2026, 0, '2026-11-14', 0, 'archived')`
    ).run();
    const errors = [];
    const orig = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };
    try {
      migrate(db);
      assert.deepStrictEqual(seasonCore(db), [
        { id: 1, year: 2027, start_date: "2027-01-01", live: 0, phase: "announced", active: 0 },
        { id: 2, year: 2024, start_date: "2024-01-01", live: 0, phase: "archived", active: 0 },
        { id: 3, year: 2029, start_date: "2029-01-01", live: 0, phase: "setup", active: 0 },
        { id: 4, year: 2027, start_date: "2027-01-01", live: 0, phase: "archived", active: 0 },
        { id: 5, year: 2030, start_date: "2030-01-01", live: 0, phase: "archived", active: 0 },
        { id: 6, year: 2028, start_date: "2028-02-29", live: 0, phase: "archived", active: 0 },
        { id: 7, year: 2026, start_date: "2026-01-01", live: 1, phase: "running", active: 1 },
        { id: 8, year: 2026, start_date: "2026-11-14", live: 0, phase: "archived", active: 0 },
      ]);
      const log = errors.join("\n");
      for (const bad of ["01.01.2027", "2027/01/01", "2027-1-1", "2027-02-29", "2027-02-31"]) {
        assert.ok(log.includes(bad), bad);
        assert.match(log, /invalid start_date/);
      }
      assert.ok(!log.includes("2028-02-29"));
      assert.ok(!log.includes("2026-11-14"));
      assert.ok(!/haha|oops|lol|😜|🙂/i.test(log));
      errors.length = 0;
      migrate(db);
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(
        db.prepare(`SELECT start_date FROM seasons WHERE id = 7`).get().start_date,
        "2026-01-01"
      );
      assert.strictEqual(
        db.prepare(`SELECT start_date FROM seasons WHERE id = 6`).get().start_date,
        "2028-02-29"
      );
    } finally {
      console.error = orig;
    }
  });
});

test("two active seasons: keep the live=1 row, do not insert, do not touch its other fields", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase) VALUES
       (4, 2026, 1, '2026-01-01', 0, 'setup'),
       (8, 2027, 1, '2027-06-02', 1, 'running')`
    ).run();
    migrate(db);
    assert.deepStrictEqual(seasonCore(db), [
      { id: 4, year: 2026, start_date: "2026-01-01", live: 0, phase: "setup", active: 0 },
      { id: 8, year: 2027, start_date: "2027-06-02", live: 1, phase: "running", active: 1 },
    ]);
    assert.throws(() => {
      db.prepare(`UPDATE seasons SET active = 1 WHERE id = 4`).run();
    }, /UNIQUE/);
  });
});

test("two active seasons without live=1: keep the smallest id and leave phase/year/start/live", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase) VALUES
       (4, 2026, 1, '2026-04-04', 1, 'running'),
       (8, 2027, 1, '2027-01-01', 1, 'announced')`
    ).run();
    migrate(db);
    assert.deepStrictEqual(seasonCore(db), [
      { id: 4, year: 2026, start_date: "2026-04-04", live: 1, phase: "running", active: 1 },
      { id: 8, year: 2027, start_date: "2027-01-01", live: 1, phase: "announced", active: 0 },
    ]);
  });
});

test("live added in this run is not a phase source", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date) VALUES
       (1, 2026, 1, '2026-01-01'),
       (2, 2025, 0, '2025-06-15')`
    ).run();
    migrate(db);
    assert.deepStrictEqual(seasonCore(db), [
      { id: 1, year: 2026, start_date: "2026-01-01", live: 0, phase: "running", active: 1 },
      { id: 2, year: 2025, start_date: "2025-06-15", live: 0, phase: "archived", active: 0 },
    ]);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM seasons`).get().c, 2);
  });
});

test("existing live column fills NULL phases and is not rewritten", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase) VALUES
       (5, 2026, 1, '2026-01-01', 1, NULL),
       (6, 2023, 0, '2023-01-01', 0, NULL)`
    ).run();
    migrate(db);
    assert.deepStrictEqual(seasonCore(db), [
      { id: 5, year: 2026, start_date: "2026-01-01", live: 1, phase: "running", active: 1 },
      { id: 6, year: 2023, start_date: "2023-01-01", live: 0, phase: "archived", active: 0 },
    ]);
  });

  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase)
       VALUES (5, 2026, 1, '2026-01-01', 0, NULL)`
    ).run();
    migrate(db);
    assert.deepStrictEqual(seasonCore(db), [
      { id: 5, year: 2026, start_date: "2026-01-01", live: 0, phase: "setup", active: 1 },
    ]);
  });
});

test("death stamp runs once below user_version 1, including a column that already exists", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PLAYERS}
    CREATE TABLE celebs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      is_alive INTEGER NOT NULL DEFAULT 1,
      death_detected_at TEXT,
      death_announced_at TEXT
    );
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase)
       VALUES (1, 2026, 1, '2026-01-01', 1, 'running')`
    ).run();
    db.prepare(
      `INSERT INTO celebs (id, name, name_key, is_alive, death_detected_at, death_announced_at)
       VALUES (1, 'Dead', 'dead', 0, '2024-05-06 07:08:09', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO celebs (id, name, name_key, is_alive, death_detected_at, death_announced_at)
       VALUES (2, 'Live', 'live', 1, '2020-01-01 00:00:00', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO celebs (id, name, name_key, is_alive, death_detected_at, death_announced_at)
       VALUES (3, 'Stamped', 'stamped', 0, '1999-01-01 00:00:00', '1999-09-09 09:09:09')`
    ).run();
    assert.strictEqual(userVersion(db), 0);
    migrate(db);
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE id = 1`).get().death_announced_at,
      "2024-05-06 07:08:09"
    );
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE id = 2`).get().death_announced_at,
      null
    );
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE id = 3`).get().death_announced_at,
      "1999-09-09 09:09:09"
    );
    assert.strictEqual(userVersion(db), 1);
    const later = db
      .prepare(
        `INSERT INTO celebs (name, name_key, is_alive, death_detected_at)
         VALUES ('After', 'after', 0, '2026-12-12 12:12:12')`
      )
      .run();
    migrate(db);
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE id = ?`).get(later.lastInsertRowid)
        .death_announced_at,
      null
    );
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM seasons`).get().c, 1);
  });
});

test("user_version above 1 is left alone and does not stamp", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase)
       VALUES (1, 2026, 1, '2026-01-01', 1, 'running')`
    ).run();
    db.prepare(
      `INSERT INTO celebs (name, name_key, is_alive) VALUES ('Dead', 'dead', 0)`
    ).run();
    db.exec(`PRAGMA user_version = 4`);
    migrate(db);
    assert.strictEqual(userVersion(db), 4);
    assert.strictEqual(
      db.prepare(`SELECT death_announced_at FROM celebs WHERE name = 'Dead'`).get()
        .death_announced_at,
      null
    );
  });
});

test("NULL death_awards.season_id fills the one active season or deletes a taken slot", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
    CREATE TABLE death_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      celeb_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      points INTEGER NOT NULL,
      season_id INTEGER,
      awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (celeb_id) REFERENCES celebs(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase) VALUES
       (3, 2024, 0, '2024-01-01', 0, 'archived'),
       (7, 2026, 1, '2026-01-01', 1, 'running')`
    ).run();
    db.prepare(
      `INSERT INTO players (id, display_name, discord_user_id, base_points)
       VALUES (1, 'Ada', 'ada', 50)`
    ).run();
    db.prepare(
      `INSERT INTO celebs (id, name, name_key) VALUES (1, 'A', 'a'), (2, 'B', 'b'), (3, 'C', 'c')`
    ).run();
    db.prepare(
      `INSERT INTO death_awards (id, celeb_id, player_id, points, season_id) VALUES
       (10, 1, 1, 5, NULL),
       (11, 2, 1, 7, 7),
       (12, 2, 1, 9, NULL),
       (13, 3, 1, 4, NULL),
       (14, 3, 1, 8, NULL)`
    ).run();
    migrate(db);
    const rows = db
      .prepare(`SELECT id, celeb_id, player_id, points, season_id FROM death_awards ORDER BY id`)
      .all();
    assert.deepStrictEqual(rows, [
      { id: 10, celeb_id: 1, player_id: 1, points: 5, season_id: 7 },
      { id: 11, celeb_id: 2, player_id: 1, points: 7, season_id: 7 },
      { id: 13, celeb_id: 3, player_id: 1, points: 4, season_id: 7 },
    ]);
    assert.strictEqual(db.prepare(`SELECT base_points FROM players WHERE id = 1`).get().base_points, 50);
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM seasons`).get().c, 2);
    assert.ok(indexByName(db, "death_awards", "idx_death_awards_celeb_player_season"));
    assert.throws(() => {
      db.prepare(
        `INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (1, 1, 1, 7)`
      ).run();
    }, /UNIQUE/);

    db.prepare(
      `INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (1, 1, 3, NULL)`
    ).run();
    migrate(db);
    assert.strictEqual(
      db.prepare(`SELECT COUNT(*) AS c FROM death_awards WHERE celeb_id = 1 AND player_id = 1`).get().c,
      1
    );
    assert.strictEqual(db.prepare(`SELECT base_points FROM players WHERE id = 1`).get().base_points, 50);
    assert.strictEqual(
      db.prepare(`SELECT points FROM death_awards WHERE celeb_id = 1 AND player_id = 1`).get().points,
      5
    );
  });
});

test("NULL award season is not guessed onto an archived season and no season is inserted", () => {
  const setup = `
    CREATE TABLE seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      live INTEGER NOT NULL DEFAULT 0,
      phase TEXT
    );
    ${PARENTS}
    CREATE TABLE death_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      celeb_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      points INTEGER NOT NULL,
      season_id INTEGER
    );
  `;
  withDb(setup, (db) => {
    db.prepare(
      `INSERT INTO seasons (id, year, active, start_date, live, phase)
       VALUES (3, 2024, 0, '2024-01-01', 0, 'archived')`
    ).run();
    db.prepare(
      `INSERT INTO players (id, display_name, discord_user_id, base_points) VALUES (1, 'Ada', 'ada', 50)`
    ).run();
    db.prepare(`INSERT INTO celebs (id, name, name_key) VALUES (1, 'A', 'a')`).run();
    db.prepare(
      `INSERT INTO death_awards (id, celeb_id, player_id, points, season_id) VALUES (10, 1, 1, 5, NULL)`
    ).run();
    migrate(db);
    assert.deepStrictEqual(
      db.prepare(`SELECT id, celeb_id, player_id, points, season_id FROM death_awards`).all(),
      [{ id: 10, celeb_id: 1, player_id: 1, points: 5, season_id: null }]
    );
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM seasons`).get().c, 1);
    assert.strictEqual(db.prepare(`SELECT active FROM seasons WHERE id = 3`).get().active, 0);
    assert.strictEqual(db.prepare(`SELECT base_points FROM players WHERE id = 1`).get().base_points, 50);
  });
});
