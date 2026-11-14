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
  // F05-Reparatur (einmalig, idempotent): vor dem Fix ließ `/go` aktive Zeilen
  // mit live=1 + phase='setup' zurück, weil setSeasonLive `phase` nie setzte.
  // Diese Bestandszeilen auf 'running' heben — danach matcht kein weiterer Lauf.
  db.exec(
    `UPDATE seasons SET phase='running' WHERE active=1 AND live=1 AND phase='setup'`
  );
  ensureActiveSeason();
  try {
    repairAnnouncedBursts();
  } catch (e) {
    console.warn("[db] announced-burst repair skipped:", e.message);
  }
  // NOTE: pruneJunkAnnouncements() is deliberately NOT part of startup anymore.
  // It is destructive (hard-deletes rows) and was running on every boot.
  // Cleanup is now an explicit opt-in script with a dry-run default:
  //   node scripts/prune-junk-announcements.js [--apply] [--force]
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
  try {
    return openDb(config);
  } catch (e) {
    // One best-effort retry before giving up — a transient FS hiccup right
    // after (re)storing a DB should not leave the bot without a database.
    console.warn("[db] reopen failed, retrying once:", e.message);
    return openDb(config);
  }
}

function ensureActiveSeason() {
  const active = db.prepare("SELECT id FROM seasons WHERE active = 1 LIMIT 1").get();
  if (active) return active.id;
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const info = db
    .prepare(
      `INSERT INTO seasons (year, active, start_date, live, phase) VALUES (?, 1, ?, 0, 'setup')`
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

// F05: setSeasonLive hält live UND phase konsistent. Vorher wurde nur `live`
// gesetzt — `/go` ließ die aktive Zeile mit live=1 + phase='setup' zurück und
// `activateAnnouncedSeason` verweigerte den Wechsel („Aktive Saison ist nicht
// running"). Jetzt: live=true => phase 'running' (wenn setup/NULL); live=false =>
// 'setup' (wenn 'running'). announced/archived werden nie überschrieben.
function setSeasonLive(live) {
  const s = getActiveSeason();
  let phase = s.phase;
  if (live) {
    if (phase === "setup" || phase == null) phase = "running";
  } else {
    if (phase === "running") phase = "setup";
  }
  db.prepare("UPDATE seasons SET live = ?, phase = ? WHERE id = ?").run(
    live ? 1 : 0,
    phase,
    s.id
  );
  return getActiveSeason();
}

// ---- M3: Zwei-Saison-API ----

function getAnnouncedSeason() {
  return db
    .prepare(
      `SELECT * FROM seasons WHERE phase = 'announced' ORDER BY year DESC, id DESC LIMIT 1`
    )
    .get() || null;
}

function openAnnouncedSeason({ year, startDate, channelId, note }) {
  const run = db.transaction(() => {
    const announced = getAnnouncedSeason();
    if (announced) {
      if (Number(announced.year) === Number(year)) {
        db.prepare(
          `UPDATE seasons SET announce_channel_id = ?, announce_note = ?, start_date = ? WHERE id = ?`
        ).run(channelId, note || null, startDate || `${year}-01-01`, announced.id);
        return { season: getAnnouncedSeason(), created: false };
      }
      throw new Error("Es existiert bereits eine angekündigte Saison (anderes Jahr).");
    }
    const clash = db
      .prepare(`SELECT id FROM seasons WHERE year = ? AND phase IN ('running','setup','archived') LIMIT 1`)
      .get(year);
    if (clash) throw new Error(`Jahr ${year} ist bereits belegt (phase läuft/archiviert).`);
    const info = db
      .prepare(
        `INSERT INTO seasons (year, active, start_date, live, phase, announce_channel_id, announce_note)
         VALUES (?, 0, ?, 0, 'announced', ?, ?)`
      )
      .run(year, startDate || `${year}-01-01`, channelId || null, note || null);
    return {
      season: db.prepare("SELECT * FROM seasons WHERE id = ?").get(info.lastInsertRowid),
      created: true,
    };
  });
  return run();
}

function setSeasonAnnounce(seasonId, { channelId, note }) {
  const row = db.prepare("SELECT * FROM seasons WHERE id = ?").get(seasonId);
  if (!row || row.phase !== "announced") throw new Error("Nur eine announced-Saison darf Kanal/Note tragen.");
  db.prepare("UPDATE seasons SET announce_channel_id = ?, announce_note = ? WHERE id = ?").run(
    channelId || null,
    note ?? row.announce_note,
    seasonId
  );
  return db.prepare("SELECT * FROM seasons WHERE id = ?").get(seasonId);
}

function archiveRunningSeason(seasonId) {
  const info = db
    .prepare(
      `UPDATE seasons SET active = 0, live = 0, phase = 'archived' WHERE id = ? AND active = 1 AND phase = 'running'`
    )
    .run(seasonId);
  if (info.changes !== 1) throw new Error("Saison kann nicht archiviert werden (nicht running/active).");
  return db.prepare("SELECT * FROM seasons WHERE id = ?").get(seasonId);
}

function activateAnnouncedSeason() {
  return db.transaction(() => {
    const announced = getAnnouncedSeason();
    if (!announced) throw new Error("Keine announced-Saison vorhanden.");
    const running = getActiveSeason();
    if (!running) throw new Error("Keine aktive Saison vorhanden.");
    if (running.id === announced.id) throw new Error("Announced und aktiv sind dieselbe Saison.");
    if (running.phase !== "running") throw new Error("Aktive Saison ist nicht running — Wechsel verweigert.");

    // Snapshot des 2026er-Kontostands pro Spieler
    const players = db.prepare("SELECT * FROM players").all();
    const insSnap = db.prepare(
      `INSERT INTO season_point_snapshots (season_id, player_id, base_points, bonus_points, total)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of players) {
      const bonusPoints = db
        .prepare(
          `SELECT COALESCE(SUM(b.points * pb.times), 0) AS s FROM player_bonuses pb
           INNER JOIN bonuses b ON b.id = pb.bonus_id WHERE pb.player_id = ?`
        )
        .get(p.id).s;
      insSnap.run(running.id, p.id, p.base_points, bonusPoints, p.base_points + bonusPoints);
    }

    archiveRunningSeason(running.id);

    const info = db
      .prepare(
        `UPDATE seasons SET active = 1, live = 1, phase = 'running' WHERE id = ? AND phase = 'announced' AND active = 0 AND live = 0`
      )
      .run(announced.id);
    if (info.changes !== 1) throw new Error("Announced-Saison konnte nicht aktiviert werden.");

    // 2027-only-Celebs (bestätigt, nicht manuell, Pick in announced, KEIN Pick in archivierter Saison) freigeben
    db.exec(`
      UPDATE celebs
      SET exclude_from_auto = 0
      WHERE wiki_confirmed = 1
        AND manual_only = 0
        AND exclude_from_auto = 1
        AND id IN (SELECT celeb_id FROM picks WHERE season_id = ${announced.id})
        AND id NOT IN (SELECT celeb_id FROM picks WHERE season_id = ${running.id});
    `);

    db.prepare("UPDATE players SET base_points = 0").run();
    db.prepare("DELETE FROM player_bonuses").run();

    return {
      archived: db.prepare("SELECT * FROM seasons WHERE id = ?").get(running.id),
      activated: db.prepare("SELECT * FROM seasons WHERE id = ?").get(announced.id),
    };
  })();
}

// Derselbe Normalisierungs-Schlüssel wie in src/discord/pick-parse.js (nameKey),
// damit die Duplikat-Erkennung ACROSS DMs gegen die EXAKT gleiche Regel läuft
// wie innerhalb einer Paste (beide bauen Akzente ab/assozieren ASCII gleich).
// Duplikat-/Dedup-Logik für Draft-Einträge hängt an diesem einen Schlüssel.
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

function enqueueReview(celebId, proposal, { seasonId } = {}) {
  const celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  // Running-Celeb-Schutz: bestätigte oder in der aktiven (running) Saison
  // gepickte Celebs werden nicht entvalidiert und nicht eingereiht.
  if (celeb && (celeb.wiki_confirmed === 1 || celebHasRunningPick(celebId))) {
    return { queued: false, reason: "running-celeb" };
  }
  const candidatesJson = proposal?.candidates
    ? JSON.stringify(proposal.candidates.slice(0, 5))
    : null;
  const activeId = getActiveSeason().id;
  const effSeasonId = seasonId == null ? activeId : seasonId;

  // ON CONFLICT: vorhandene Zeile nur übernehmen, wenn (a) gleiche Saison oder
  // (b) Legacy-NULL-Zeile und neue ID ist die aktive Saison.
  const existing = db
    .prepare("SELECT season_id FROM celeb_review_queue WHERE celeb_id = ?")
    .get(celebId);
  let qSeason = existing?.season_id ?? null;
  let allow = true;
  if (existing) {
    if (qSeason === effSeasonId) allow = true;
    else if (qSeason == null && effSeasonId === activeId) allow = true;
    else allow = false;
  }
  if (!allow) return { queued: false, reason: "other-season" };

  // Immer die Saison mitschreiben (effSeasonId): Die aktive Saison bekommt ihre
  // Id, announced/andere ihre eigene. NULL-Zeilen aus alten Releases werden von
  // ON CONFLICT auf die aktuelle effSeasonId gehoben, damit sie nach einem
  // Saisonwechsel nicht das /go blocken (F3).
  db.prepare(
    `INSERT INTO celeb_review_queue (
       celeb_id, proposed_wiki_url, proposed_age, proposed_lang, proposed_candidates, status, season_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
     ON CONFLICT(celeb_id) DO UPDATE SET
       proposed_wiki_url = excluded.proposed_wiki_url,
       proposed_age = excluded.proposed_age,
       proposed_lang = excluded.proposed_lang,
       proposed_candidates = COALESCE(excluded.proposed_candidates, celeb_review_queue.proposed_candidates),
       status = 'pending',
       season_id = excluded.season_id,
       updated_at = datetime('now')`
  ).run(
    celebId,
    proposal?.wikiUrl || null,
    proposal?.proposedAge ?? null,
    proposal?.lang || null,
    candidatesJson,
    effSeasonId
  );
  // Flags nur im wirklich neuen/aktualisierten Fall setzen (nicht der
  // running-celeb-Schutz gegriffen hat):
  const row = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (row && !celebHasRunningPick(celebId) && row.wiki_confirmed !== 1) {
    db.prepare(
      `UPDATE celebs SET exclude_from_auto = 1, wiki_confirmed = 0 WHERE id = ? AND manual_only = 0`
    ).run(celebId);
  }
  return { queued: true };
}

/** Hat der Celeb einen Pick in der aktiven Saison? */
function celebHasRunningPick(celebId) {
  const activeId = getActiveSeason().id;
  const row = db
    .prepare("SELECT 1 AS x FROM picks WHERE celeb_id = ? AND season_id = ? LIMIT 1")
    .get(celebId, activeId);
  return !!row;
}

function nextPendingReview(seasonId) {
  if (seasonId == null) {
    const activeId = getActiveSeason().id;
    return db
      .prepare(
        `SELECT q.*, c.name AS celeb_name, c.sheet_age_hint, c.age_at_pick, c.wiki_url, c.manual_only,
                c.wikidata_id
         FROM celeb_review_queue q
         INNER JOIN celebs c ON c.id = q.celeb_id
         WHERE q.status = 'pending' AND (q.season_id IS NULL OR q.season_id = ?)
         ORDER BY q.id ASC
         LIMIT 1`
      )
      .get(activeId);
  }
  return db
    .prepare(
      `SELECT q.*, c.name AS celeb_name, c.sheet_age_hint, c.age_at_pick, c.wiki_url, c.manual_only,
              c.wikidata_id
       FROM celeb_review_queue q
       INNER JOIN celebs c ON c.id = q.celeb_id
       WHERE q.status = 'pending' AND q.season_id = ?
       ORDER BY q.id ASC
       LIMIT 1`
    )
    .get(seasonId);
}

function countPendingReviews({ seasonId, blockingLive } = {}) {
  if (blockingLive) {
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM celeb_review_queue
         WHERE status = 'pending' AND (season_id IS NULL OR season_id = (SELECT id FROM seasons WHERE active = 1))`
      )
      .get().c;
  }
  if (seasonId != null) {
    return db
      .prepare(`SELECT COUNT(*) AS c FROM celeb_review_queue WHERE status = 'pending' AND season_id = ?`)
      .get(seasonId).c;
  }
  // Default-/Pool-Pfad (seasonId fehlt, nicht blockingLive): dieselbe Bedingung
  // wie nextPendingReview(null) — `season_id IS NULL OR season_id = <aktive Saison>`.
  // Nur so zählt der laufende Pool konsistent zu dem, was /review dann auch
  // liefert. announced-Zeilen (z.B. 2027) zählen hier NICHT mit (F12).
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM celeb_review_queue
       WHERE status = 'pending' AND (season_id IS NULL OR season_id = (SELECT id FROM seasons WHERE active = 1))`
    )
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
      `INSERT OR IGNORE INTO picks (player_id, celeb_id, season_id, age_at_pick)
       SELECT player_id, ?, season_id, age_at_pick FROM picks WHERE celeb_id = ?`
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
    // Copy awards only when canonical lacks that player (unique celeb+player+season)
    db.prepare(
      `INSERT OR IGNORE INTO death_awards (celeb_id, player_id, points, awarded_at, season_id)
       SELECT ?, d.player_id, d.points, d.awarded_at, d.season_id
       FROM death_awards d
       WHERE d.celeb_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM death_awards x
           WHERE x.celeb_id = ? AND x.player_id = d.player_id AND
                 (x.season_id IS d.season_id OR x.season_id = d.season_id)
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
  // R2-1/F4: announced-Eigenschaft des EINGEHENDEN (2027er) Celebs VOR dem
  // Merge einfrieren — der Merge löscht dessen Queue-Zeile, und nach dem
  // Merge zeigt celebId auf den kanonischen (2026er) Celeb ohne announced-Queue.
  const preQueue = db
    .prepare("SELECT season_id FROM celeb_review_queue WHERE celeb_id = ?")
    .get(celebId);
  const incomingAnnounced = !!(
    preQueue?.season_id &&
    db.prepare("SELECT phase FROM seasons WHERE id = ?").get(preQueue.season_id)?.phase === "announced"
  );

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

  // Nach dem Merge neu lesen: die kanonische Zeile kann eine eigene Queue-Zeile
  // oder ein bestätigter 2026er-Celeb sein (F4). announced gilt auch, wenn die
  // EINGEHENDE Karte announced war (R2-1) — sonst verliert der 2027er-Confirm
  // seine Saison-Zuordnung und läuft fälschlich den 2026er-Branch.
  const qAfter = db
    .prepare("SELECT season_id FROM celeb_review_queue WHERE celeb_id = ?")
    .get(celebId);
  const isAnnounced =
    incomingAnnounced ||
    !!(
      qAfter?.season_id &&
      db.prepare("SELECT phase FROM seasons WHERE id = ?").get(qAfter.season_id)?.phase === "announced"
    );

  if (manualOnly) {
    if (isAnnounced) {
      db.prepare(
        `UPDATE celebs SET
           manual_only = 1,
           wiki_confirmed = 1,
           exclude_from_auto = 1,
           wiki_url = NULL,
           wiki_url_norm = NULL,
           wikidata_id = NULL
         WHERE id = ?`
      ).run(celebId);
    } else {
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
    }
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
    if (isAnnounced) {
      const canonical = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
      const inRunning = celebHasRunningPick(celebId);
      // Bestätigung einer 2027er-Karte darf einen bereits bestätigten 2026er-
      // Celeb NICHT dauerhaft aus dem Auto-Match nehmen (F4): Wenn die
      // kanonische Zeile schon bestätigt ist UND einen laufenden Pick hat,
      // ist sie fertig — das 2027er-Alter liegt separat auf picks.age_at_pick.
      if (canonical.wiki_confirmed === 1 && inRunning) {
        markReviewStatus(celebId, "done");
        clearUrlWaitForCeleb(celebId);
        return canonical;
      }
      // announced-Queue: bestätigt, bleibt außerhalb des 2026er-Auto-Match,
      // Celeb-Alter wird NICHT überschrieben (2027-Alter liegt auf picks.age_at_pick).
      db.prepare(
        `UPDATE celebs SET
           manual_only = 0,
           wiki_confirmed = 1,
           exclude_from_auto = 1,
           wiki_url = ?,
           wiki_url_norm = ?,
           wiki_url_de = COALESCE(?, wiki_url_de),
           wikidata_id = COALESCE(?, wikidata_id)
         WHERE id = ?`
      ).run(finalUrl, finalNorm, finalDe, wikidataId || null, celebId);
      // R2-3/F15: Confirm allein (ohne Alter-Button) muss das Alter trotzdem
      // an picks.age_at_pick bringen — sonst bleibt der Dezember-Score 0.
      // COALESCE fill-if-empty: ein bewusst per Alter-Button gepflegtes Alter
      // wird NICHT überschrieben.
      if (age != null) {
        const ann = db
          .prepare("SELECT id FROM seasons WHERE phase = 'announced' AND live = 0")
          .get();
        if (ann) {
          db.prepare(
            `UPDATE picks SET age_at_pick = COALESCE(age_at_pick, ?)
             WHERE celeb_id = ? AND season_id = ?`
          ).run(age, celebId, ann.id);
        }
      }
    } else {
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

/**
 * Undo a bad death hit and/or void a pick without restarting the season.
 * - Always excludes from auto-match
 * - Retracts death awards if currently marked dead
 * - Optionally removes all season picks for this celeb (cheat / invalid pick)
 */
function invalidateCeleb(celebId, { removePicks = false } = {}) {
  const celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb) return null;

  let retract = null;
  if (!celeb.is_alive) {
    retract = retractDeath(celebId);
  }

  setExcludeFromAuto(celebId, true);

  let picksRemoved = 0;
  if (removePicks) {
    const season = getActiveSeason();
    const info = db
      .prepare("DELETE FROM picks WHERE celeb_id = ? AND season_id = ?")
      .run(celebId, season.id);
    picksRemoved = info.changes || 0;
  }

  return {
    celeb: db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId),
    retracted: Boolean(retract),
    awardsUndone: retract?.awards?.length || 0,
    picksRemoved,
  };
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

/** Setze picks.age_at_pick (nur wenn vorhandene Zeile). */
function setPickAgeAtPick(playerId, celebId, seasonId, age) {
  db.prepare(
    `UPDATE picks SET age_at_pick = COALESCE(?, age_at_pick) WHERE player_id = ? AND celeb_id = ? AND season_id = ?`
  ).run(age ?? null, playerId, celebId, seasonId);
}

// ---- M3: Draft-API (2027er Tipp-Assistent) ----

function assertAnnouncedSeason(seasonId) {
  const s = db.prepare("SELECT phase, live FROM seasons WHERE id = ?").get(seasonId);
  if (!s || s.phase !== "announced" || s.live !== 0) {
    throw new Error("Draft-Operation nur auf der announced-Saison erlaubt.");
  }
  return s;
}

function getOrCreateDraft(playerId, seasonId) {
  assertAnnouncedSeason(seasonId);
  const existing = db
    .prepare("SELECT * FROM pick_drafts WHERE player_id = ? AND season_id = ?")
    .get(playerId, seasonId);
  if (existing) {
    if (existing.status !== "draft") return existing; // finalized bleibt geschlossen
    return existing;
  }
  const info = db
    .prepare(
      `INSERT INTO pick_drafts (player_id, season_id, status, updated_at)
       VALUES (?, ?, 'draft', datetime('now'))`
    )
    .run(playerId, seasonId);
  return db.prepare("SELECT * FROM pick_drafts WHERE id = ?").get(info.lastInsertRowid);
}

function addDraftNames(draftId, names, opts = {}) {
  const draft = db.prepare("SELECT * FROM pick_drafts WHERE id = ?").get(draftId);
  if (!draft) throw new Error("Draft nicht gefunden.");
  if (draft.status !== "draft") throw new Error("Draft bereits finalisiert.");
  const existingCount = db
    .prepare("SELECT COUNT(*) c FROM pick_draft_entries WHERE draft_id = ?")
    .get(draftId).c;
  // Globales Karten-Limit pro Spieler (& pro Draft): auch über mehrere DMs
  // verteilte Namen dürfen das Limit nicht überschreiten — nicht nur pro Paste.
  const maxNames = Number.isFinite(Number(opts.maxNames)) ? Number(opts.maxNames) : 50;
  const maxPos = db
    .prepare("SELECT COALESCE(MAX(position), 0) AS m FROM pick_draft_entries WHERE draft_id = ?")
    .get(draftId).m;
  // F10: Bestands-Dedup. Eine zweite DM derselben Person (per nameKey wie in
  // parsePickList) darf KEINE zweite Zeile anlegen — Doppelte zählen über alle
  // Direktnachrichten, nicht nur innerhalb einer Paste. Die betroffenen
  // Rohstrings werden als `duplicates` zurückgegeben, damit die DM sie nennt.
  const entries = db
    .prepare("SELECT raw_name FROM pick_draft_entries WHERE draft_id = ?")
    .all(draftId);
  const existingKeys = new Set(entries.map((r) => nameKey(r.raw_name)).filter(Boolean));
  const duplicates = [];
  const stmt = db.prepare(
    `INSERT INTO pick_draft_entries (draft_id, position, raw_name, link_status)
     VALUES (?, ?, ?, 'pending')`
  );
  let pos = maxPos;
  let added = 0;
  for (const name of names) {
    const k = nameKey(name);
    if (!k) continue;
    if (existingKeys.has(k)) {
      duplicates.push(name);
      continue;
    }
    if (existingCount + added >= maxNames) break;
    existingKeys.add(k);
    pos += 1;
    stmt.run(draftId, pos, name);
    added += 1;
  }
  db.prepare("UPDATE pick_drafts SET updated_at = datetime('now') WHERE id = ?").run(draftId);
  // truncated: es blieben Namen wegen des GLOBALEN Limits draußen (nur
  // `entfernen` schafft Platz — ganze Liste, keine „mehrere Meldungen").
  // Duplikate zählen hier NICHT als truncated — sie werden separat gemeldet.
  const processed = added + duplicates.length;
  return { added, duplicates, truncated: processed < names.length, limit: maxNames };
}

/** Maximale Namen in einem Draft (Karte selbst, 25 eingebettete Felder -> Sicherheit). */
const MAX_DRAFT_NAME_CHARS = 600;

/** Maximale Gesamtlänge aller rohen Namen (Discord-Limit + UI-Handling). */
function draftCharBudget(draftId) {
  const row = db
    .prepare("SELECT COALESCE(SUM(LENGTH(raw_name)), 0) AS total FROM pick_draft_entries WHERE draft_id = ?")
    .get(draftId);
  return row ? row.total : 0;
}

function removeDraftEntry(entryId) {
  const info = db.prepare("DELETE FROM pick_draft_entries WHERE id = ?").run(entryId);
  return info.changes > 0;
}

function replaceDraftEntryName(entryId, rawName) {
  const info = db
    .prepare(
      `UPDATE pick_draft_entries SET raw_name = ?, link_status = 'pending', wiki_url = NULL,
       wiki_norm = NULL, qid = NULL, proposed_age = NULL, candidates_json = NULL, position = position
       WHERE id = ?`
    )
    .run(rawName, entryId);
  return info.changes > 0;
}

function setDraftEntryLinked(
  entryId,
  { wikiUrl, wikiNorm, qid, proposedAge, linkStatus, candidatesJson } = {}
) {
  // candidates_json NICHT via COALESCE: ein neuer eindeutiger Kandidat muss einen
  // alten mehrdeutigen Satz ersetzen, sonst waehlt der User aus veralteten Daten (F7).
  // qid NICHT coalescen (R2-2): wenn der Aufrufer explizit ein qid mitgibt
  // (auch null = "keins"), ersetzt es die alte Zuordnung. Eine neue URL-Linkung
  // ohne Wikidata-QID darf die vorige Person NICHT stehen lassen — sonst findet
  // finalizeDraft über das alte qid die falsche Person.
  const hasQid = qid !== undefined; // undefined = nicht Teil des Updates
  db.prepare(
    `UPDATE pick_draft_entries SET
       wiki_url = COALESCE(?, wiki_url),
       wiki_norm = COALESCE(?, wiki_norm),
       qid = CASE WHEN ? = 1 THEN ? ELSE qid END,
       proposed_age = COALESCE(?, proposed_age),
       candidates_json = ?,
       link_status = COALESCE(?, link_status)
     WHERE id = ?`
  ).run(
    wikiUrl ?? null,
    wikiNorm ?? null,
    hasQid ? 1 : 0,
    qid ?? null,
    proposedAge ?? null,
    candidatesJson ?? null,
    linkStatus ?? null,
    entryId
  );
}

function listDraftEntries(draftId) {
  return db
    .prepare("SELECT * FROM pick_draft_entries WHERE draft_id = ? ORDER BY position ASC")
    .all(draftId);
}

function getDraftForPlayer(playerId, seasonId) {
  return db
    .prepare("SELECT * FROM pick_drafts WHERE player_id = ? AND season_id = ?")
    .get(playerId, seasonId) || null;
}

/**
 * Celeb für eine announced-Saison verknüpfen: bestehende bestätigte/running-Pick-
 * Zeile wiederverwenden ohne Flags/Alter zu ändern; sonst neue/offene Zeile.
 */
function linkCelebForAnnouncedSeason({ name, age, qid, wikiNorm }) {
  if (qid) {
    const byQ = findCelebByWikidataId(qid);
    if (byQ) return { celeb: byQ, reuse: true };
  }
  if (wikiNorm) {
    const byN = findCelebByWikiNorm(wikiNorm);
    if (byN) return { celeb: byN, reuse: true };
  }
  const found = findOrCreateCeleb({ name, age });
  // Wenn diese Zeile schon bestätigt ist ODER einen running-Pick hat: reuse
  if (found.celeb.wiki_confirmed === 1 || celebHasRunningPick(found.celeb.id)) {
    return { celeb: found.celeb, reuse: true };
  }
  return { celeb: found.celeb, reuse: found.celeb.wiki_confirmed === 1 && found.celeb.exclude_from_auto === 0 };
}

function finalizeDraft(playerId, seasonId) {
  assertAnnouncedSeason(seasonId);
  return db.transaction(() => {
    const draft = db
      .prepare("SELECT * FROM pick_drafts WHERE player_id = ? AND season_id = ?")
      .get(playerId, seasonId);
    if (!draft) throw new Error("Kein Draft vorhanden.");
    if (draft.status === "finalized") return { locked: true };

    const entries = listDraftEntries(draft.id);
    for (const e of entries) {
      if (e.link_status === "ambiguous" || e.link_status === "pending") {
        return { blocked: true, entryId: e.id };
      }
    }
    if (!entries.length) return { blocked: true, entryId: null, reason: "empty" };

    clearPicksForPlayer(playerId, seasonId);
    const reviewIds = [];
    let added = 0;
    for (const e of entries) {
      const { celeb, reuse } = linkCelebForAnnouncedSeason({
        name: e.raw_name,
        age: e.proposed_age ?? null,
        qid: e.qid || null,
        wikiNorm: e.wiki_norm || null,
      });
      setPick(playerId, celeb.id, seasonId);
      if (e.proposed_age != null) {
        db.prepare(
          `UPDATE picks SET age_at_pick = ? WHERE player_id = ? AND celeb_id = ? AND season_id = ?`
        ).run(e.proposed_age, playerId, celeb.id, seasonId);
      }
      added++;
      // F24: Jeder noch unbestätigte Celeb ohne laufenden Pick in die Review —
      // unabhängig davon, ob eine QID/norm-Wiederverwendung stattfand (eine
      // unbestätigte Zeile braucht zur Freischaltung wiki_confirmed=1).
      if (celeb.wiki_confirmed !== 1 && !celebHasRunningPick(celeb.id)) {
        reviewIds.push(celeb.id);
      }
    }
    db.prepare("UPDATE pick_drafts SET status = 'finalized', updated_at = datetime('now') WHERE id = ?")
      .run(draft.id);
    return { reviewIds: [...new Set(reviewIds)], added };
  })();
}

function unlockDraftForPlayer(playerId, seasonId) {
  assertAnnouncedSeason(seasonId);
  return db.transaction(() => {
    const draft = db
      .prepare("SELECT * FROM pick_drafts WHERE player_id = ? AND season_id = ?")
      .get(playerId, seasonId);
    if (!draft) return { error: "no-draft" };
    if (draft.status !== "finalized") return { error: "not-locked" };
    db.prepare(
      `UPDATE pick_drafts SET status = 'draft', updated_at = datetime('now') WHERE id = ?`
    ).run(draft.id);
    clearPicksForPlayer(playerId, seasonId);
    return { unlocked: true };
  })();
}

function getAnnouncedSeasonPicksForPlayer(playerId, seasonId) {
  return db
    .prepare(
      `SELECT pk.*, c.name AS celeb_name, c.wiki_url, c.is_alive, c.died_at
       FROM picks pk JOIN celebs c ON c.id = pk.celeb_id
       WHERE pk.player_id = ? AND pk.season_id = ?
       ORDER BY c.name COLLATE NOCASE`
    )
    .all(playerId, seasonId);
}

/**
 * Ungewarnete Pre-Start-Tode in announced-Picks: Celebs, die vor dem
 * Saisonstart gestorben sind, aber noch NICHT in pick_death_warnings stehen.
 * Liefert Zeilen für den DM-Versand in announced Season (live=0).
 *
 * F14b: died_at trägt seit F14a das echte Wiki-Todesdatum (entry.day/month/
 * year), nicht den Erkennungstag. Ein Wiki-Todestag vor dem Saisonstart gilt
 * also auch dann als Vor-Start-Tod, wenn er erst NACH dem Start erkannt wurde
 * (z.B. 20.12. erkannt am 2.1.). OHNE Wiki-Datum (died_at IS NULL) zählt nur
 * ein Tod als Vor-Start, der auch tatsächlich VOR dem Start erkannt wurde
 * (death_detected_at < start) — sonst würde jeder nach dem Start erkannte,
 * datumslose Tod fälschlich als Vor-Start-Tod gewarnt.
 */
function getAnnouncedPreStartDeathsUnwarned(seasonId) {
  const season = db.prepare("SELECT * FROM seasons WHERE id = ?").get(seasonId);
  if (!season || season.live !== 0) return [];
  return db
    .prepare(
      `SELECT pk.player_id, pk.celeb_id, c.name AS celeb_name, c.died_at AS celeb_died_at,
              c.death_detected_at AS celeb_detected_at,
              u.discord_user_id AS user_discord_id, w.season_id AS warned_season
       FROM picks pk
       JOIN celebs c ON c.id = pk.celeb_id
       LEFT JOIN players u ON u.id = pk.player_id
       LEFT JOIN pick_death_warnings w
         ON w.season_id = pk.season_id AND w.player_id = pk.player_id AND w.celeb_id = pk.celeb_id
       WHERE pk.season_id = ?
         AND c.is_alive = 0
         AND (
           (c.died_at IS NOT NULL AND c.died_at <= ?)
           OR
           (c.died_at IS NULL AND c.death_detected_at IS NOT NULL AND c.death_detected_at < ?)
         )
         AND w.season_id IS NULL`
    )
    .all(seasonId, season.start_date, season.start_date);
}

function markAnnouncedDeathWarned(seasonId, playerId, celebId) {
  db.prepare(
    `INSERT OR IGNORE INTO pick_death_warnings (season_id, player_id, celeb_id)
     VALUES (?, ?, ?)`
  ).run(seasonId, playerId, celebId);
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

/**
 * R2-8: lebende Celebs, die in der ANNOUNCED-Saison (2027) gepickt wurden —
 * auch wenn sie NICHT im 2026er-Auto-Pool stehen (exclude_from_auto=1). Sie
 * müssen vor dem Saisonstart auf Tode geprüft werden, sonst stirbt jemand im
 * Dezember unbemerkt und wird am 1.1. als „Vorjahrestod” verworfen.
 */
function getAliveCelebsForAnnounced() {
  const ann = db
    .prepare(`SELECT id FROM seasons WHERE phase = 'announced' AND live = 0`)
    .get();
  if (!ann) return [];
  return db
    .prepare(
      `SELECT DISTINCT c.* FROM celebs c
       JOIN picks pk ON pk.celeb_id = c.id
       WHERE c.is_alive = 1
         AND pk.season_id = ?`
    )
    .all(ann.id);
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
  return db.transaction((cid, o) => {
    const celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(cid);
    if (!celeb || !celeb.is_alive) return { celeb, awards: [], score: 0 };

    const season = getActiveSeason();
    const winners = getWinnersForCeleb(cid, season.id);
    const now = new Date().toISOString();
    const diedAt = o.diedAt || now.slice(0, 10);

    // F14: seit der Fix vergeht diedAt das echte Wiki-Todesdatum (entry.day/
    // month/year), nicht den Erkennungstag. Ein Tod VOR dem Saisonstart darf
    // deshalb KEINE Punkte in der aktiven Saison gewinnen — auch wenn er erst
    // NACH dem Start entdeckt wird (z.B. 20.12. in der Jan-Liste). Der Tod wird
    // trotzdem vermerkt (is_alive=0), damit getAnnouncedPreStartDeathsUnwarned
    // bzw. die Pre-Start-Warnung den Einreicher erreichen kann.
    const seasonStart = season?.start_date;
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    const preStart =
      Boolean(o.diedAt) &&
      Boolean(seasonStart) &&
      isoRe.test(String(o.diedAt)) &&
      isoRe.test(String(seasonStart)) &&
      String(o.diedAt) < String(seasonStart);

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
        o.wikiUrl || null,
        o.confirmed ? 1 : 0,
        now,
        o.source || "wiki",
        cid
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
        o.wikiUrl || null,
        o.wikiUrl || null,
        o.confirmed ? 1 : 0,
        now,
        o.source || "wiki",
        cid
      );
    }

    const awards = [];
    let firstScore = 0;
    let effAge = celeb.age_at_pick;
    for (const w of winners) {
      // Alter: Pick-Alter (2027-Ziel) zuerst, sonst Celeb-Alter (2026/legacy)
      const pick = db
        .prepare("SELECT age_at_pick FROM picks WHERE celeb_id = ? AND player_id = ? AND season_id = ?")
        .get(cid, w.id, season.id);
      const age = pick?.age_at_pick ?? celeb.age_at_pick;
      const score = scoreForAge(age);
      // Vor-Start-Tod: 0 Punkte (keine DB-Gutschrift, kein death_award),
      // aber der Winner taucht weiterhin im Result auf (Punkte 0) — so kann
      // der Aufrufer zwischen „kein Winner“ und „Winner ohne Punkte“ unterscheiden.
      const awardPoints = preStart ? 0 : score;
      if (awards.length === 0) {
        firstScore = awardPoints;
        effAge = age;
      }
      if (awardPoints > 0) {
        const existing = db
          .prepare(
            `SELECT id FROM death_awards WHERE celeb_id = ? AND player_id = ? AND season_id = ?`
          )
          .get(cid, w.id, season.id);
        if (!existing) {
          db.prepare("UPDATE players SET base_points = base_points + ? WHERE id = ?").run(awardPoints, w.id);
          db.prepare(
            `INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (?, ?, ?, ?)`
          ).run(cid, w.id, awardPoints, season.id);
        }
      }
      awards.push({
        player: w,
        points: awardPoints,
        total: playerTotal(w.id),
      });
    }

    return {
      celeb: db.prepare("SELECT * FROM celebs WHERE id = ?").get(cid),
      awards,
      score: firstScore,
      age: effAge,
    };
  })(celebId, opts);
}

function retractDeath(celebId) {
  const celeb = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb || celeb.is_alive) return null;

  // Nur die AKTIVE Saison anfassen: Die 2026er-Punkte liegen nach dem Wechsel im
  // Snapshot, ein aktiver Fehltreffer darf nur die Laufzeit-Gutschrift zurückholen.
  const season = getActiveSeason();
  const awards = db
    .prepare("SELECT * FROM death_awards WHERE celeb_id = ? AND season_id = ?")
    .all(celebId, season.id);

  for (const a of awards) {
    db.prepare("UPDATE players SET base_points = base_points - ? WHERE id = ?").run(
      a.points,
      a.player_id
    );
  }
  db.prepare("DELETE FROM death_awards WHERE celeb_id = ? AND season_id = ?").run(
    celebId,
    season.id
  );
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

/**
 * Jahresauswertung einer archivierten Saison: Punktestände aus dem Snapshot,
 * Todesfälle (via death_awards) und Treffer pro Spieler. Für den automatischen
 * Jahreswechsel (1.1., Mitternacht).
 */
function seasonReview(seasonId) {
  const season = db.prepare("SELECT * FROM seasons WHERE id = ?").get(seasonId);
  if (!season) return null;

  const snapRows = db
    .prepare(
      `SELECT s.*, p.display_name FROM season_point_snapshots s
       INNER JOIN players p ON p.id = s.player_id
       WHERE s.season_id = ?`
    )
    .all(seasonId);

  const awardRows = db
    .prepare(
      `SELECT da.*, c.name AS celeb_name, p.display_name FROM death_awards da
       INNER JOIN celebs c ON c.id = da.celeb_id
       INNER JOIN players p ON p.id = da.player_id
       WHERE da.season_id = ?`
    )
    .all(seasonId);

  const byPlayer = {};
  for (const s of snapRows) {
    byPlayer[s.player_id] = { name: s.display_name, total: s.total, points: s.base_points + s.bonus_points, hits: 0 };
  }
  for (const a of awardRows) {
    if (!byPlayer[a.player_id]) byPlayer[a.player_id] = { name: a.display_name, total: 0, points: 0, hits: 0 };
    byPlayer[a.player_id].hits++;
  }
  const rows = Object.values(byPlayer)
    .map((r) => ({ ...r, total: r.total || 0 }))
    .sort((a, b) => b.total - a.total || b.hits - a.hits);
  return { season, rows, deaths: awardRows.length };
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
    `INSERT OR IGNORE INTO wiki_seen (entry_id, lang, text, url, qid) VALUES (?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    entry.lang || null,
    entry.text || null,
    entry.url || null,
    entry.qid || null
  );
}

/** Non-recent marker for entries handled by a seed (never actually posted). */
const ANNOUNCED_EPOCH = "1970-01-01 00:00:00";

function markWikiAnnounced(entryId, at = null, qid = null) {
  // Stamp only the FIRST successful announce. Re-scrapes (restart seed, re-poll)
  // must never refresh announced_at, otherwise the daily summary counts every
  // known entry as "new since yesterday" after every container restart.
  const existing = db
    .prepare("SELECT announced_at, qid FROM wiki_seen WHERE entry_id = ?")
    .get(entryId);
  if (existing?.announced_at) return;
  const ts = at || db.prepare("SELECT datetime('now') AS t").get().t;
  db.prepare(
    `UPDATE wiki_seen SET announced_at = ?, qid = COALESCE(?, qid) WHERE entry_id = ?`
  ).run(ts, qid, entryId);
  db.prepare(
    `INSERT OR IGNORE INTO announced_deaths (entry_id, name, url, lang, qid, announced_at)
     SELECT entry_id, text, url, lang, COALESCE(?, qid), ? FROM wiki_seen WHERE entry_id = ?`
  ).run(qid, ts, entryId);
}

/**
 * Identitäten der zuletzt angekündigten Karten für den Dedup vor dem Posten.
 * @param {string} sinceIso Datum/Fenster (z.B. 14 Tage alt)
 * @returns {{ qids: Set<string>, humanNames: Set<string> }}
 */
function recentAnnouncedIdentities(sinceIso) {
  const rows = db
    .prepare("SELECT qid, lang, url, name FROM announced_deaths WHERE announced_at >= ?")
    .all(sinceIso);
  const qids = new Set();
  const humanNames = new Set();
  for (const r of rows) {
    if (r.qid) qids.add(r.qid);
    if (r.name) humanNames.add(String(r.name).toLowerCase());
  }
  return { qids, humanNames };
}

function seedAllWikiSeen(entries) {
  const tx = db.transaction((list) => {
    for (const e of list) {
      markWikiSeen(e);
      // Stamp every entry WITHOUT an announced_at with an EPOCH date rather than
      // "now": a seed means "these entries already existed before live mode,
      // don't re-post them". They must never show up in the daily summary as
      // new, and never be re-announced. Entries that already have an
      // announced_at keep it untouched.
      const row = db
        .prepare("SELECT announced_at FROM wiki_seen WHERE entry_id = ?")
        .get(e.id);
      if (!row?.announced_at) markWikiAnnounced(e.id, ANNOUNCED_EPOCH);
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

/**
 * One-time startup repair: pre-fix restart seeds stamped announced_at=now() for
 * every row en-masse, which flooded the daily summary with thousands of "new"
 * entries after each restart. Real Discord announces cannot exceed ~5/s (rate
 * limit), so a same-second group larger than `limit` is a safe seed-pollution
 * marker. Restamp those rows to the EPOCH marker (still marked "announced", so
 * never re-posted, but permanently outside the 26h summary window).
 *
 * The EPOCH marker itself is excluded from the burst scan: seed rows share the
 * EPOCH timestamp by design, so counting them every boot just re-stamps the
 * same value (churn) and risks touching genuinely legitimate data. Only real
 * same-second timestamps that exceed the limit are treated as pollution.
 */
function repairAnnouncedBursts(limit = 20) {
  const bursts = db
    .prepare(
      `SELECT announced_at AS ts, COUNT(*) AS c
       FROM announced_deaths
       WHERE announced_at IS NOT NULL
         AND announced_at != ?
       GROUP BY announced_at
       HAVING COUNT(*) > ?`
    )
    .all(ANNOUNCED_EPOCH, limit);
  if (!bursts.length) return 0;
  let fixed = 0;
  for (const b of bursts) {
    db.prepare(`UPDATE announced_deaths SET announced_at = ? WHERE announced_at = ?`).run(
      ANNOUNCED_EPOCH,
      b.ts
    );
    db.prepare(`UPDATE wiki_seen SET announced_at = ? WHERE announced_at = ?`).run(
      ANNOUNCED_EPOCH,
      b.ts
    );
    fixed += b.c;
  }
  console.log(new Date().toISOString(), `[db] repaired ${fixed} seed-burst announced rows`);
  return fixed;
}

/**
 * Announcements that point to Wikipedia LIST/NAV pages (the Oct 2026 EN wiki
 * split exposed them: "Previous months" div-col, footer navboxes, "List of days
 * of the year" etc.). Those are never real person biographies and were
 * mistakenly announced during the 08-Oct junk storm.
 *
 * Opt-in cleanup via `scripts/prune-junk-announcements.js` — intentionally NOT
 * on the startup path (destructive: deletes rows on every boot).
 */
// entry_id format is "<lang>:/wiki/<path>" (e.g. en:/wiki/Deaths_in_1977).
const junkRE =
  /^[a-z]{2}:\/wiki\/(Deaths_in_|Nekrolog|List_of_days|List_of_deaths|Lists_of_deaths|List_of_births|Lists_of_births|Category:|Template:|Help:|Wikipedia:|Portal:)/i;

function junkAnnouncementIds() {
  return db
    .prepare(`SELECT entry_id FROM announced_deaths`)
    .all()
    .map((r) => r.entry_id)
    .filter((id) => junkRE.test(id));
}

/** Dry-run counter — how many junk announcements exist (no write). */
function countJunkAnnouncements() {
  return junkAnnouncementIds().length;
}

/**
 * Delete junk list-page announcements (both announced_deaths + wiki_seen rows).
 * Records a meta marker so the opt-in script won't silently re-run; `--force`
 * in the script bypasses that guard. Safe: a re-scraped list page is re-seeded
 * to EPOCH (announced marker) and never re-announced.
 */
function pruneJunkAnnouncements() {
  const ids = junkAnnouncementIds();
  if (!ids.length) return 0;
  const del = db.transaction((list) => {
    for (const id of list) {
      db.prepare(`DELETE FROM announced_deaths WHERE entry_id = ?`).run(id);
      db.prepare(`DELETE FROM wiki_seen WHERE entry_id = ?`).run(id);
    }
  });
  del(ids);
  setMeta("junk_prune_last_run", new Date().toISOString());
  console.log(
    new Date().toISOString(),
    `[db] pruned ${ids.length} junk list-page announcements`
  );
  return ids.length;
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
  db.prepare("UPDATE seasons SET active = 0, live = 0, phase = 'archived' WHERE id = ?").run(
    old.id
  );
  const y = year || new Date().getFullYear();
  const start = startDate || `${y}-01-01`;
  const info = db
    .prepare(
      `INSERT INTO seasons (year, active, start_date, live, phase) VALUES (?, 1, ?, 0, 'setup')`
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

function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(key), value == null ? "" : String(value));
}

function getMeta(key) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(String(key));
  return row ? row.value : null;
}

/** Extra counts for /status */
function statusSnapshot() {
  const season = getActiveSeason();
  const celebsAlive = db
    .prepare(`SELECT COUNT(*) AS c FROM celebs WHERE is_alive = 1`)
    .get().c;
  const celebsDead = db
    .prepare(`SELECT COUNT(*) AS c FROM celebs WHERE is_alive = 0`)
    .get().c;
  const autoWatch = db
    .prepare(
      `SELECT COUNT(*) AS c FROM celebs
       WHERE is_alive = 1 AND exclude_from_auto = 0 AND manual_only = 0 AND wiki_confirmed = 1`
    )
    .get().c;
  const excluded = db
    .prepare(`SELECT COUNT(*) AS c FROM celebs WHERE exclude_from_auto = 1`)
    .get().c;
  const unconfirmedDead = db
    .prepare(
      `SELECT COUNT(*) AS c FROM celebs
       WHERE is_alive = 0 AND death_confirmed = 0`
    )
    .get().c;
  const recentPoolDeaths = db
    .prepare(
      `SELECT name, died_at, death_source, death_detected_at FROM celebs
       WHERE is_alive = 0
       ORDER BY COALESCE(death_detected_at, died_at) DESC
       LIMIT 8`
    )
    .all();
  const recentAnnounced = db
    .prepare(
      `SELECT name, url, lang, announced_at FROM announced_deaths
       ORDER BY announced_at DESC LIMIT 8`
    )
    .all();
  const wikiSeenEn = db
    .prepare(`SELECT COUNT(*) AS c FROM wiki_seen WHERE lang = 'en'`)
    .get().c;
  const wikiSeenDe = db
    .prepare(`SELECT COUNT(*) AS c FROM wiki_seen WHERE lang = 'de'`)
    .get().c;
  let lastPoll = null;
  try {
    const raw = getMeta("last_poll");
    if (raw) lastPoll = JSON.parse(raw);
  } catch {
    lastPoll = null;
  }
  return {
    season,
    players: db.prepare("SELECT COUNT(*) AS c FROM players").get().c,
    picks: db
      .prepare(`SELECT COUNT(*) AS c FROM picks WHERE season_id = ?`)
      .get(season.id).c,
    celebsAlive,
    celebsDead,
    autoWatch,
    excluded,
    unconfirmedDead,
    pendingReviews: countPendingReviews(),
    unconfirmedCelebs: countUnconfirmedSeasonCelebs(),
    wikiSeen: db.prepare("SELECT COUNT(*) AS c FROM wiki_seen").get().c,
    wikiSeenEn,
    wikiSeenDe,
    announcedTotal: db.prepare("SELECT COUNT(*) AS c FROM announced_deaths").get().c,
    recentPoolDeaths,
    recentAnnounced,
    lastPoll,
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
  // M3 Zwei-Saison
  getAnnouncedSeason,
  openAnnouncedSeason,
  setSeasonAnnounce,
  archiveRunningSeason,
  activateAnnouncedSeason,
  assertAnnouncedSeason,
  getOrCreateDraft,
  addDraftNames,
  removeDraftEntry,
  replaceDraftEntryName,
  setDraftEntryLinked,
  listDraftEntries,
  getDraftForPlayer,
  linkCelebForAnnouncedSeason,
  finalizeDraft,
  unlockDraftForPlayer,
  getAnnouncedSeasonPicksForPlayer,
  getAnnouncedPreStartDeathsUnwarned,
  markAnnouncedDeathWarned,
  seasonReview,
  setPickAgeAtPick,
  celebHasRunningPick,
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
  getAliveCelebsForAnnounced,
  getAkas,
  getBlacklist,
  addAka,
  removeAka,
  addBlacklist,
  removeBlacklist,
  setExcludeFromAuto,
  invalidateCeleb,
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
  recentAnnouncedIdentities,
  seedAllWikiSeen,
  repairAnnouncedBursts,
  countJunkAnnouncements,
  pruneJunkAnnouncements,
  deathsSinceHours,
  recordPhraseUse,
  recentPhraseHashes,
  clearSeasonForNewYear,
  statsSnapshot,
  statusSnapshot,
  setMeta,
  getMeta,
};
