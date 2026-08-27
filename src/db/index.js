const fs = require("fs");
const Database = require("better-sqlite3");
const { SCHEMA, migrate } = require("./schema");

let db = null;

function openDb(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupsDir, { recursive: true });
  fs.mkdirSync(config.restoreDir, { recursive: true });

  db = new Database(config.dbPath);
  db.exec(SCHEMA);
  migrate(db);
  ensureActiveSeason();
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function reopenDb(config) {
  closeDb();
  return openDb(config);
}

function ensureActiveSeason() {
  const active = db.prepare("SELECT id FROM seasons WHERE active = 1 LIMIT 1").get();
  if (active) return active.id;
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const info = db
    .prepare(
      `INSERT INTO seasons (year, active, start_date, live) VALUES (?, 1, ?, 0)`
    )
    .run(year, start);
  return info.lastInsertRowid;
}

function getActiveSeason() {
  const row = db.prepare("SELECT * FROM seasons WHERE active = 1 LIMIT 1").get();
  if (!row) return db.prepare("SELECT * FROM seasons WHERE id = ?").get(ensureActiveSeason());
  return row;
}

function isLive() {
  return !!getActiveSeason().live;
}

function setSeasonStartDate(startDate) {
  const s = getActiveSeason();
  db.prepare("UPDATE seasons SET start_date = ? WHERE id = ?").run(startDate, s.id);
  return getActiveSeason();
}

function setSeasonLive(live) {
  const s = getActiveSeason();
  db.prepare("UPDATE seasons SET live = ? WHERE id = ?").run(live ? 1 : 0, s.id);
  return getActiveSeason();
}

function nameKey(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreForAge(age) {
  if (age == null || Number.isNaN(age)) return 0;
  return Math.max(1, 100 - Number(age));
}

function upsertPlayer({ displayName, discordUserId }) {
  const existing = db
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(discordUserId));
  if (existing) {
    db.prepare("UPDATE players SET display_name = ? WHERE id = ?").run(displayName, existing.id);
    return db.prepare("SELECT * FROM players WHERE id = ?").get(existing.id);
  }
  const info = db
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES (?, ?, 0)")
    .run(displayName, String(discordUserId));
  return db.prepare("SELECT * FROM players WHERE id = ?").get(info.lastInsertRowid);
}

function findOrCreateCeleb({ name, age, description }) {
  const key = nameKey(name);
  let celeb = db.prepare("SELECT * FROM celebs WHERE name_key = ?").get(key);
  if (celeb) {
    db.prepare(
      `UPDATE celebs SET
        name = COALESCE(?, name),
        age_at_pick = COALESCE(?, age_at_pick),
        description = COALESCE(?, description)
       WHERE id = ?`
    ).run(name, age ?? null, description || null, celeb.id);
    return db.prepare("SELECT * FROM celebs WHERE id = ?").get(celeb.id);
  }
  const info = db
    .prepare(
      `INSERT INTO celebs (name, name_key, age_at_pick, description, is_alive)
       VALUES (?, ?, ?, ?, 1)`
    )
    .run(name, key, age ?? null, description || null);
  return db.prepare("SELECT * FROM celebs WHERE id = ?").get(info.lastInsertRowid);
}

function setPick(playerId, celebId, seasonId) {
  db.prepare(
    `INSERT OR IGNORE INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)`
  ).run(playerId, celebId, seasonId);
}

function getAliveCelebsForAuto() {
  return db
    .prepare(`SELECT * FROM celebs WHERE is_alive = 1 AND exclude_from_auto = 0`)
    .all();
}

function getAkas(celebId) {
  return db.prepare("SELECT alias FROM celeb_aka WHERE celeb_id = ?").all(celebId).map((r) => r.alias);
}

function getBlacklist(celebId) {
  return db
    .prepare("SELECT term FROM celeb_blacklist WHERE celeb_id = ?")
    .all(celebId)
    .map((r) => r.term);
}

function getWinnersForCeleb(celebId, seasonId) {
  return db
    .prepare(
      `SELECT p.* FROM players p
       INNER JOIN picks pk ON pk.player_id = p.id
       WHERE pk.celeb_id = ? AND pk.season_id = ?`
    )
    .all(celebId, seasonId);
}

/**
 * Mark dead + award points using age_at_pick (100-age).
 * @param {{ confirmed: boolean, source: string, diedAt?: string, wikiUrl?: string }} opts
 */
function applyDeath(celebId, opts = {}) {
  const celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb || !celeb.is_alive) return { celeb, awards: [], score: 0 };

  const season = getActiveSeason();
  const age = celeb.age_at_pick;
  const score = scoreForAge(age);
  const winners = getWinnersForCeleb(celebId, season.id);
  const now = new Date().toISOString();
  const diedAt = opts.diedAt || now.slice(0, 10);

  db.prepare(
    `UPDATE celebs SET
      is_alive = 0,
      died_at = ?,
      wiki_url = COALESCE(?, wiki_url),
      death_confirmed = ?,
      death_detected_at = ?,
      death_source = ?
     WHERE id = ?`
  ).run(
    diedAt,
    opts.wikiUrl || null,
    opts.confirmed ? 1 : 0,
    now,
    opts.source || "wiki",
    celebId
  );

  const awards = [];
  for (const w of winners) {
    if (score > 0) {
      db.prepare("UPDATE players SET base_points = base_points + ? WHERE id = ?").run(score, w.id);
      db.prepare(
        `INSERT INTO death_awards (celeb_id, player_id, points) VALUES (?, ?, ?)`
      ).run(celebId, w.id, score);
    }
    awards.push({
      player: w,
      points: score,
      total: playerTotal(w.id),
    });
  }

  return {
    celeb: db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId),
    awards,
    score,
    age,
  };
}

function retractDeath(celebId) {
  const celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb || celeb.is_alive) return null;

  const awards = db
    .prepare("SELECT * FROM death_awards WHERE celeb_id = ?")
    .all(celebId);

  for (const a of awards) {
    db.prepare("UPDATE players SET base_points = base_points - ? WHERE id = ?").run(
      a.points,
      a.player_id
    );
  }
  db.prepare("DELETE FROM death_awards WHERE celeb_id = ?").run(celebId);
  db.prepare(
    `UPDATE celebs SET
      is_alive = 1,
      died_at = NULL,
      death_confirmed = 0,
      death_detected_at = NULL,
      death_source = NULL
     WHERE id = ?`
  ).run(celebId);

  return {
    celeb: db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId),
    awards,
  };
}

function confirmDeath(celebId) {
  db.prepare("UPDATE celebs SET death_confirmed = 1 WHERE id = ?").run(celebId);
}

function getUnconfirmedDeaths() {
  return db
    .prepare(
      `SELECT * FROM celebs
       WHERE is_alive = 0 AND death_confirmed = 0 AND exclude_from_auto = 0`
    )
    .all();
}

/** @deprecated use applyDeath */
function markCelebDead(celebId, diedAt, wikiUrl) {
  applyDeath(celebId, {
    confirmed: true,
    source: "manual",
    diedAt,
    wikiUrl,
  });
}

function addPoints(playerId, points) {
  db.prepare("UPDATE players SET base_points = base_points + ? WHERE id = ?").run(points, playerId);
}

function setPoints(playerId, points) {
  db.prepare("UPDATE players SET base_points = ? WHERE id = ?").run(points, playerId);
}

function playerTotal(playerId) {
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  if (!player) return 0;
  const bonuses = db
    .prepare(
      `SELECT b.points, pb.times FROM player_bonuses pb
       INNER JOIN bonuses b ON b.id = pb.bonus_id
       WHERE pb.player_id = ?`
    )
    .all(playerId);
  const bonusSum = bonuses.reduce((s, b) => s + b.points * b.times, 0);
  return player.base_points + bonusSum;
}

function listScores() {
  const players = db.prepare("SELECT * FROM players").all();
  return players
    .map((p) => ({
      ...p,
      total: playerTotal(p.id),
      pickCount: db
        .prepare(
          `SELECT COUNT(*) AS c FROM picks pk
           INNER JOIN seasons s ON s.id = pk.season_id AND s.active = 1
           WHERE pk.player_id = ?`
        )
        .get(p.id).c,
    }))
    .filter((p) => p.pickCount > 0)
    .sort((a, b) => b.total - a.total);
}

function getPlayerPicks(discordUserId) {
  const player = db.prepare("SELECT * FROM players WHERE discord_user_id = ?").get(String(discordUserId));
  if (!player) return null;
  const season = getActiveSeason();
  const picks = db
    .prepare(
      `SELECT c.* FROM celebs c
       INNER JOIN picks pk ON pk.celeb_id = c.id
       WHERE pk.player_id = ? AND pk.season_id = ?
       ORDER BY c.name COLLATE NOCASE`
    )
    .all(player.id, season.id);
  return { player, picks, total: playerTotal(player.id) };
}

function findCelebByName(query) {
  const key = nameKey(query);
  let celeb = db.prepare("SELECT * FROM celebs WHERE name_key = ?").get(key);
  if (celeb) return [celeb];
  return db
    .prepare(`SELECT * FROM celebs WHERE name_key LIKE ? ORDER BY name COLLATE NOCASE LIMIT 10`)
    .all(`%${key}%`);
}

function isWikiSeen(entryId) {
  return !!db.prepare("SELECT 1 FROM wiki_seen WHERE entry_id = ?").get(entryId);
}

function markWikiSeen(entry) {
  db.prepare(
    `INSERT OR IGNORE INTO wiki_seen (entry_id, lang, text, url) VALUES (?, ?, ?, ?)`
  ).run(entry.id, entry.lang || null, entry.text || null, entry.url || null);
}

function markWikiAnnounced(entryId) {
  db.prepare(`UPDATE wiki_seen SET announced_at = datetime('now') WHERE entry_id = ?`).run(entryId);
  db.prepare(
    `INSERT OR REPLACE INTO announced_deaths (entry_id, name, url, lang, announced_at)
     SELECT entry_id, text, url, lang, datetime('now') FROM wiki_seen WHERE entry_id = ?`
  ).run(entryId);
}

function seedAllWikiSeen(entries) {
  const tx = db.transaction((list) => {
    for (const e of list) {
      markWikiSeen(e);
      markWikiAnnounced(e.id);
    }
  });
  tx(entries);
}

function deathsSinceHours(hours) {
  return db
    .prepare(
      `SELECT * FROM announced_deaths
       WHERE announced_at >= datetime('now', ?)
       ORDER BY announced_at ASC`
    )
    .all(`-${hours} hours`);
}

function recordPhraseUse(hash) {
  db.prepare(
    `INSERT OR REPLACE INTO phrase_history (phrase_hash, used_at) VALUES (?, datetime('now'))`
  ).run(hash);
}

function recentPhraseHashes(limit = 80) {
  return new Set(
    db
      .prepare(`SELECT phrase_hash FROM phrase_history ORDER BY used_at DESC LIMIT ?`)
      .all(limit)
      .map((r) => r.phrase_hash)
  );
}

function clearSeasonForNewYear(year, startDate) {
  const old = getActiveSeason();
  db.prepare("UPDATE seasons SET active = 0 WHERE id = ?").run(old.id);
  const y = year || new Date().getFullYear();
  const start = startDate || `${y}-01-01`;
  const info = db
    .prepare(
      `INSERT INTO seasons (year, active, start_date, live) VALUES (?, 1, ?, 0)`
    )
    .run(y, start);
  db.prepare("UPDATE players SET base_points = 0").run();
  db.prepare("DELETE FROM player_bonuses").run();
  return { oldSeason: old, newSeasonId: info.lastInsertRowid, startDate: start };
}

function statsSnapshot() {
  return {
    players: db.prepare("SELECT COUNT(*) AS c FROM players").get().c,
    celebs: db.prepare("SELECT COUNT(*) AS c FROM celebs").get().c,
    picks: db.prepare("SELECT COUNT(*) AS c FROM picks").get().c,
    wiki_seen: db.prepare("SELECT COUNT(*) AS c FROM wiki_seen").get().c,
    season: getActiveSeason(),
  };
}

module.exports = {
  openDb,
  getDb,
  closeDb,
  reopenDb,
  ensureActiveSeason,
  getActiveSeason,
  isLive,
  setSeasonStartDate,
  setSeasonLive,
  nameKey,
  scoreForAge,
  upsertPlayer,
  findOrCreateCeleb,
  setPick,
  getAliveCelebsForAuto,
  getAkas,
  getBlacklist,
  getWinnersForCeleb,
  applyDeath,
  retractDeath,
  confirmDeath,
  getUnconfirmedDeaths,
  markCelebDead,
  addPoints,
  setPoints,
  playerTotal,
  listScores,
  getPlayerPicks,
  findCelebByName,
  isWikiSeen,
  markWikiSeen,
  markWikiAnnounced,
  seedAllWikiSeen,
  deathsSinceHours,
  recordPhraseUse,
  recentPhraseHashes,
  clearSeasonForNewYear,
  statsSnapshot,
};
