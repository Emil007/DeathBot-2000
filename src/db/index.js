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

  // Prefer unconfirmed provisional with same name (still in review) — safe to reuse
  let celeb =
    db
      .prepare(
        `SELECT * FROM celebs WHERE name_key = ? AND wiki_confirmed = 0 ORDER BY id ASC LIMIT 1`
      )
      .get(key) || null;

  if (!celeb) {
    celeb =
      db
        .prepare(
          `SELECT c.* FROM celebs c
           INNER JOIN celeb_aka a ON a.celeb_id = c.id
           WHERE lower(a.alias) = lower(?) AND c.wiki_confirmed = 0
           LIMIT 1`
        )
        .get(name) || null;
  }

  // Confirmed same-name exists → do NOT reuse (homonym risk). New provisional for review.
  const confirmedSameName = db
    .prepare(`SELECT id FROM celebs WHERE name_key = ? AND wiki_confirmed = 1 LIMIT 1`)
    .get(key);

  if (celeb) {
    let ageConflict = null;
    if (
      age != null &&
      celeb.age_at_pick != null &&
      Number(age) !== Number(celeb.age_at_pick)
    ) {
      ageConflict = { existing: celeb.age_at_pick, incoming: Number(age) };
    }
    db.prepare(
      `UPDATE celebs SET
        name = COALESCE(?, name),
        sheet_age_hint = COALESCE(?, sheet_age_hint),
        age_at_pick = COALESCE(age_at_pick, ?),
        description = COALESCE(?, description)
       WHERE id = ?`
    ).run(name, age ?? null, age ?? null, description || null, celeb.id);
    if (nameKey(name) !== celeb.name_key) {
      db.prepare("INSERT OR IGNORE INTO celeb_aka (celeb_id, alias) VALUES (?, ?)").run(
        celeb.id,
        name
      );
    }
    celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celeb.id);
    return { celeb, ageConflict, created: false, possibleHomonym: false };
  }

  const info = db
    .prepare(
      `INSERT INTO celebs (
         name, name_key, age_at_pick, sheet_age_hint, description, is_alive,
         wiki_confirmed, manual_only, exclude_from_auto
       ) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1)`
    )
    .run(name, key, age ?? null, age ?? null, description || null);
  return {
    celeb: db.prepare("SELECT * FROM celebs WHERE id = ?").get(info.lastInsertRowid),
    ageConflict: null,
    created: true,
    possibleHomonym: Boolean(confirmedSameName),
  };
}

function findCelebByWikiNorm(norm) {
  if (!norm) return null;
  return db.prepare("SELECT * FROM celebs WHERE wiki_url_norm = ?").get(norm);
}

function findCelebByWikidataId(qid) {
  if (!qid) return null;
  return db.prepare("SELECT * FROM celebs WHERE wikidata_id = ?").get(qid);
}

function enqueueReview(celebId, proposal) {
  const candidatesJson = proposal?.candidates
    ? JSON.stringify(proposal.candidates.slice(0, 5))
    : null;
  db.prepare(
    `INSERT INTO celeb_review_queue (
       celeb_id, proposed_wiki_url, proposed_age, proposed_lang, proposed_candidates, status, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
     ON CONFLICT(celeb_id) DO UPDATE SET
       proposed_wiki_url = excluded.proposed_wiki_url,
       proposed_age = excluded.proposed_age,
       proposed_lang = excluded.proposed_lang,
       proposed_candidates = COALESCE(excluded.proposed_candidates, celeb_review_queue.proposed_candidates),
       status = 'pending',
       updated_at = datetime('now')`
  ).run(
    celebId,
    proposal?.wikiUrl || null,
    proposal?.proposedAge ?? null,
    proposal?.lang || null,
    candidatesJson
  );
  db.prepare(
    `UPDATE celebs SET exclude_from_auto = 1, wiki_confirmed = 0 WHERE id = ? AND manual_only = 0`
  ).run(celebId);
}

function nextPendingReview() {
  return db
    .prepare(
      `SELECT q.*, c.name AS celeb_name, c.sheet_age_hint, c.age_at_pick, c.wiki_url, c.manual_only,
              c.wikidata_id
       FROM celeb_review_queue q
       INNER JOIN celebs c ON c.id = q.celeb_id
       WHERE q.status = 'pending'
       ORDER BY q.id ASC
       LIMIT 1`
    )
    .get();
}

function countPendingReviews() {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM celeb_review_queue WHERE status = 'pending'`)
    .get().c;
}

function countUnconfirmedSeasonCelebs() {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT c.id) AS c
       FROM celebs c
       INNER JOIN picks pk ON pk.celeb_id = c.id
       INNER JOIN seasons s ON s.id = pk.season_id AND s.active = 1
       WHERE c.wiki_confirmed = 0`
    )
    .get().c;
}

function markReviewStatus(celebId, status) {
  db.prepare(
    `UPDATE celeb_review_queue SET status = ?, updated_at = datetime('now') WHERE celeb_id = ?`
  ).run(status, celebId);
}

function setUrlWait(adminUserId, celebId, expiresAtIso) {
  db.prepare(
    `INSERT INTO celeb_url_wait (admin_user_id, celeb_id, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(admin_user_id) DO UPDATE SET
       celeb_id = excluded.celeb_id,
       expires_at = excluded.expires_at`
  ).run(String(adminUserId), celebId, expiresAtIso);
}

function getUrlWait(adminUserId) {
  return db
    .prepare(`SELECT * FROM celeb_url_wait WHERE admin_user_id = ?`)
    .get(String(adminUserId));
}

function clearUrlWait(adminUserId) {
  db.prepare(`DELETE FROM celeb_url_wait WHERE admin_user_id = ?`).run(String(adminUserId));
}

function mergeCelebs(canonicalId, duplicateId) {
  if (canonicalId === duplicateId) return canonicalId;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO picks (player_id, celeb_id, season_id)
       SELECT player_id, ?, season_id FROM picks WHERE celeb_id = ?`
    ).run(canonicalId, duplicateId);
    db.prepare(`DELETE FROM picks WHERE celeb_id = ?`).run(duplicateId);
    db.prepare(
      `INSERT OR IGNORE INTO celeb_aka (celeb_id, alias)
       SELECT ?, alias FROM celeb_aka WHERE celeb_id = ?`
    ).run(canonicalId, duplicateId);
    const dup = db.prepare("SELECT name FROM celebs WHERE id = ?").get(duplicateId);
    if (dup?.name) {
      db.prepare("INSERT OR IGNORE INTO celeb_aka (celeb_id, alias) VALUES (?, ?)").run(
        canonicalId,
        dup.name
      );
    }
    // Copy awards only when canonical lacks that player (unique celeb+player)
    db.prepare(
      `INSERT OR IGNORE INTO death_awards (celeb_id, player_id, points, awarded_at)
       SELECT ?, d.player_id, d.points, d.awarded_at
       FROM death_awards d
       WHERE d.celeb_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM death_awards x
           WHERE x.celeb_id = ? AND x.player_id = d.player_id
         )`
    ).run(canonicalId, duplicateId, canonicalId);
    db.prepare(`DELETE FROM death_awards WHERE celeb_id = ?`).run(duplicateId);
    db.prepare(`DELETE FROM celeb_review_queue WHERE celeb_id = ?`).run(duplicateId);
    db.prepare(`DELETE FROM celeb_url_wait WHERE celeb_id = ?`).run(duplicateId);
    // Prefer keeping EN wiki / QID from either side
    const can = db.prepare("SELECT * FROM celebs WHERE id = ?").get(canonicalId);
    const other = db.prepare("SELECT * FROM celebs WHERE id = ?").get(duplicateId);
    if (other) {
      const wikidataId = can.wikidata_id || other.wikidata_id;
      let wikiUrl = can.wiki_url;
      let wikiNorm = can.wiki_url_norm;
      let wikiDe = can.wiki_url_de;
      if (other.wiki_url_norm?.startsWith("en:") && !can.wiki_url_norm?.startsWith("en:")) {
        wikiUrl = other.wiki_url;
        wikiNorm = other.wiki_url_norm;
        if (can.wiki_url_norm?.startsWith("de:")) wikiDe = can.wiki_url;
      } else if (other.wiki_url_norm?.startsWith("de:") && !wikiDe) {
        wikiDe = other.wiki_url;
      }
      db.prepare(
        `UPDATE celebs SET
           wikidata_id = COALESCE(?, wikidata_id),
           wiki_url = COALESCE(?, wiki_url),
           wiki_url_norm = COALESCE(?, wiki_url_norm),
           wiki_url_de = COALESCE(?, wiki_url_de)
         WHERE id = ?`
      ).run(wikidataId, wikiUrl, wikiNorm, wikiDe, canonicalId);
    }
    db.prepare(`DELETE FROM celebs WHERE id = ?`).run(duplicateId);
  });
  tx();
  return canonicalId;
}

function applyWikiConfirm(celebId, { wikiUrl, wikiNorm, wikiUrlDe, wikidataId, age, manualOnly }) {
  // Identity: Wikidata QID first, then wiki_url_norm
  if (wikidataId) {
    const byQ = findCelebByWikidataId(wikidataId);
    if (byQ && byQ.id !== celebId) {
      celebId = mergeCelebs(byQ.id, celebId);
    }
  }
  const existing = wikiNorm ? findCelebByWikiNorm(wikiNorm) : null;
  if (existing && existing.id !== celebId) {
    celebId = mergeCelebs(existing.id, celebId);
  }

  if (manualOnly) {
    db.prepare(
      `UPDATE celebs SET
         manual_only = 1,
         wiki_confirmed = 1,
         exclude_from_auto = 1,
         wiki_url = NULL,
         wiki_url_norm = NULL,
         wikidata_id = NULL,
         age_at_pick = COALESCE(?, age_at_pick, sheet_age_hint)
       WHERE id = ?`
    ).run(age ?? null, celebId);
  } else {
    const row = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
    let finalUrl = wikiUrl || null;
    let finalNorm = wikiNorm || null;
    let finalDe = wikiUrlDe || null;
    if (wikiNorm?.startsWith("de:")) {
      finalDe = wikiUrl || finalDe;
      if (row?.wiki_url_norm?.startsWith("en:")) {
        finalUrl = row.wiki_url;
        finalNorm = row.wiki_url_norm;
      }
    } else if (wikiNorm?.startsWith("en:") && row?.wiki_url_norm?.startsWith("de:") && !finalDe) {
      finalDe = row.wiki_url;
    }
    db.prepare(
      `UPDATE celebs SET
         manual_only = 0,
         wiki_confirmed = 1,
         exclude_from_auto = 0,
         wiki_url = ?,
         wiki_url_norm = ?,
         wiki_url_de = COALESCE(?, wiki_url_de),
         wikidata_id = COALESCE(?, wikidata_id),
         age_at_pick = COALESCE(?, age_at_pick, sheet_age_hint)
       WHERE id = ?`
    ).run(
      finalUrl,
      finalNorm,
      finalDe,
      wikidataId || null,
      age ?? null,
      celebId
    );
  }
  markReviewStatus(celebId, "done");
  clearUrlWaitForCeleb(celebId);
  return db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
}

function clearUrlWaitForCeleb(celebId) {
  db.prepare(`DELETE FROM celeb_url_wait WHERE celeb_id = ?`).run(celebId);
}

function setCelebAge(celebId, age) {
  const awards = db
    .prepare("SELECT COUNT(*) AS c FROM death_awards WHERE celeb_id = ?")
    .get(celebId).c;
  if (awards > 0) {
    return { ok: false, reason: "awards_exist", awards };
  }
  db.prepare("UPDATE celebs SET age_at_pick = ? WHERE id = ?").run(age, celebId);
  return { ok: true, celeb: db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId) };
}

function clearPicksForPlayer(playerId, seasonId) {
  db.prepare("DELETE FROM picks WHERE player_id = ? AND season_id = ?").run(playerId, seasonId);
}

function addAka(celebId, alias) {
  db.prepare("INSERT OR IGNORE INTO celeb_aka (celeb_id, alias) VALUES (?, ?)").run(
    celebId,
    alias.trim()
  );
}

function removeAka(celebId, alias) {
  db.prepare("DELETE FROM celeb_aka WHERE celeb_id = ? AND alias = ?").run(celebId, alias.trim());
}

function addBlacklist(celebId, term) {
  db.prepare("INSERT OR IGNORE INTO celeb_blacklist (celeb_id, term) VALUES (?, ?)").run(
    celebId,
    term.trim()
  );
}

function removeBlacklist(celebId, term) {
  db.prepare("DELETE FROM celeb_blacklist WHERE celeb_id = ? AND term = ?").run(
    celebId,
    term.trim()
  );
}

function setExcludeFromAuto(celebId, exclude) {
  db.prepare("UPDATE celebs SET exclude_from_auto = ? WHERE id = ?").run(exclude ? 1 : 0, celebId);
}

function listBonuses() {
  return db.prepare("SELECT * FROM bonuses ORDER BY name COLLATE NOCASE").all();
}

function upsertBonus({ id, name, description, points }) {
  db.prepare(
    `INSERT INTO bonuses (id, name, description, points) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, points = excluded.points`
  ).run(id, name, description || null, points);
}

function awardBonus(playerId, bonusId) {
  const bonus = db.prepare("SELECT * FROM bonuses WHERE id = ?").get(bonusId);
  if (!bonus) throw new Error("Bonus not found");
  const row = db
    .prepare("SELECT * FROM player_bonuses WHERE player_id = ? AND bonus_id = ?")
    .get(playerId, bonusId);
  if (row) {
    db.prepare(
      "UPDATE player_bonuses SET times = times + 1 WHERE player_id = ? AND bonus_id = ?"
    ).run(playerId, bonusId);
  } else {
    db.prepare(
      "INSERT INTO player_bonuses (player_id, bonus_id, times) VALUES (?, ?, 1)"
    ).run(playerId, bonusId);
  }
  return bonus;
}

function revokeBonus(playerId, bonusId) {
  const row = db
    .prepare("SELECT * FROM player_bonuses WHERE player_id = ? AND bonus_id = ?")
    .get(playerId, bonusId);
  if (!row) return null;
  if (row.times <= 1) {
    db.prepare("DELETE FROM player_bonuses WHERE player_id = ? AND bonus_id = ?").run(
      playerId,
      bonusId
    );
  } else {
    db.prepare(
      "UPDATE player_bonuses SET times = times - 1 WHERE player_id = ? AND bonus_id = ?"
    ).run(playerId, bonusId);
  }
  return db.prepare("SELECT * FROM bonuses WHERE id = ?").get(bonusId);
}

function unlinkPlayer(discordUserId) {
  const player = db.prepare("SELECT * FROM players WHERE discord_user_id = ?").get(String(discordUserId));
  if (!player) return null;
  const season = getActiveSeason();
  db.prepare("DELETE FROM picks WHERE player_id = ? AND season_id = ?").run(player.id, season.id);
  return player;
}

function resolvePlayerFromMessage(msg, token) {
  const mention = msg.mentions.users.first();
  if (mention) {
    return db.prepare("SELECT * FROM players WHERE discord_user_id = ?").get(mention.id);
  }
  if (!token) return null;
  return (
    db.prepare("SELECT * FROM players WHERE discord_user_id = ?").get(token) ||
    db.prepare("SELECT * FROM players WHERE display_name LIKE ? COLLATE NOCASE").get(token)
  );
}

function setPick(playerId, celebId, seasonId) {
  db.prepare(
    `INSERT OR IGNORE INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)`
  ).run(playerId, celebId, seasonId);
}

function getAliveCelebsForAuto() {
  return db
    .prepare(
      `SELECT * FROM celebs
       WHERE is_alive = 1
         AND exclude_from_auto = 0
         AND manual_only = 0
         AND wiki_confirmed = 1`
    )
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

  // Never overwrite a confirmed biography URL with a death-list link
  if (celeb.wiki_confirmed) {
    db.prepare(
      `UPDATE celebs SET
        is_alive = 0,
        died_at = ?,
        death_list_url = COALESCE(?, death_list_url),
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
  } else {
    db.prepare(
      `UPDATE celebs SET
        is_alive = 0,
        died_at = ?,
        wiki_url = COALESCE(?, wiki_url),
        death_list_url = COALESCE(?, death_list_url),
        death_confirmed = ?,
        death_detected_at = ?,
        death_source = ?
       WHERE id = ?`
    ).run(
      diedAt,
      opts.wikiUrl || null,
      opts.wikiUrl || null,
      opts.confirmed ? 1 : 0,
      now,
      opts.source || "wiki",
      celebId
    );
  }

  const awards = [];
  for (const w of winners) {
    if (score > 0) {
      const existing = db
        .prepare(`SELECT id FROM death_awards WHERE celeb_id = ? AND player_id = ?`)
        .get(celebId, w.id);
      if (!existing) {
        db.prepare("UPDATE players SET base_points = base_points + ? WHERE id = ?").run(score, w.id);
        db.prepare(
          `INSERT INTO death_awards (celeb_id, player_id, points) VALUES (?, ?, ?)`
        ).run(celebId, w.id, score);
      }
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
  if (celeb.wiki_confirmed) {
    db.prepare(
      `UPDATE celebs SET
        is_alive = 1,
        died_at = NULL,
        death_list_url = NULL,
        death_confirmed = 0,
        death_detected_at = NULL,
        death_source = NULL
       WHERE id = ?`
    ).run(celebId);
  } else {
    db.prepare(
      `UPDATE celebs SET
        is_alive = 1,
        died_at = NULL,
        wiki_url = NULL,
        death_list_url = NULL,
        death_confirmed = 0,
        death_detected_at = NULL,
        death_source = NULL
       WHERE id = ?`
    ).run(celebId);
  }

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

function findPlayerByQuery(query) {
  if (!query) return null;
  const q = String(query).trim();
  if (/^\d{16,20}$/.test(q)) {
    return db.prepare("SELECT * FROM players WHERE discord_user_id = ?").get(q) || null;
  }
  return (
    db
      .prepare(
        `SELECT * FROM players WHERE display_name = ? COLLATE NOCASE LIMIT 1`
      )
      .get(q) ||
    db
      .prepare(
        `SELECT * FROM players WHERE display_name LIKE ? COLLATE NOCASE LIMIT 1`
      )
      .get(`%${q}%`) ||
    null
  );
}

/** All celebs in DB with how many active-season picks. */
function listAllCelebs() {
  const season = getActiveSeason();
  return db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM picks pk
          WHERE pk.celeb_id = c.id AND pk.season_id = ?) AS pick_count
       FROM celebs c
       ORDER BY c.is_alive ASC, c.name COLLATE NOCASE`
    )
    .all(season.id);
}

function findCelebByName(query) {
  const key = nameKey(query);
  const exact = db.prepare("SELECT * FROM celebs WHERE name_key = ?").all(key);
  if (exact.length) return exact;
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
  findCelebByWikiNorm,
  findCelebByWikidataId,
  enqueueReview,
  nextPendingReview,
  countPendingReviews,
  countUnconfirmedSeasonCelebs,
  markReviewStatus,
  setUrlWait,
  getUrlWait,
  clearUrlWait,
  mergeCelebs,
  applyWikiConfirm,
  setCelebAge,
  clearPicksForPlayer,
  setPick,
  getAliveCelebsForAuto,
  getAkas,
  getBlacklist,
  addAka,
  removeAka,
  addBlacklist,
  removeBlacklist,
  setExcludeFromAuto,
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
  findPlayerByQuery,
  listAllCelebs,
  findCelebByName,
  listBonuses,
  upsertBonus,
  awardBonus,
  revokeBonus,
  unlinkPlayer,
  resolvePlayerFromMessage,
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
