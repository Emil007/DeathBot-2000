# DeathBot-2000 — Review der Pakete M1–M5 gegen Plan v2

Stand: 2026-11-14. Geprüft am Quellstand in `scratch/grok-review/` (nicht am Live-Container). Zwei Befunde sind mit einer temporären SQLite nachgestellt (`SCHEMA`/`migrate` und der Award-Index).

## 1. Zusammenfassung

| Kategorie | Anzahl |
|-----------|--------|
| FEHLER | 24 (2 kritisch, 16 hoch, 6 mittel) |
| VERBESSERUNG | 3 |
| UNKLAR | 0 |

Geprüft und in Ordnung, deshalb hier kein Befund:

- `getActiveSeason` und `getAnnouncedSeason` sind nicht vertauscht. Scoring, Import, `/go`, Poller und `applyDeath` bleiben auf der aktiven Zeile; Assistent, `/picks` und `finalizeDraft` auf der announced-Zeile.
- `openAnnouncedSeason` lässt eine zweite announced-Saison und ein Re-Open von `running`/`setup`/`archived` werfen und fasst die running-Zeile nicht an.
- `activateAnnouncedSeason` läuft in einer Transaktion (Snapshot, `archiveRunningSeason`, Live-Schaltung, Exclude-Flip nur 2027-only, `base_points = 0`, Boni weg, keine Deletes an Picks/Celebs/Awards).
- `assertWipeAllowed` und `assertActivateDateAllowed` tun, was M5 beschreibt. `confirm` ohne leeren Setup löscht nichts. Der Assistent konsumiert keine Guild-Nachrichten (`msg.guildId`), und `messageCreate` ignoriert `author.bot` — keine DM-Schleife, kein Draft-Timer.
- `kind: "scan"` wird verworfen, leeres `CHANNEL_LOG` ist ein No-Op, die Queue hält 1 s Abstand. `wiki-poll.js` importiert `log.js` nicht für Scan-Zähler.

Die grünen Tests sehen das nicht: sie öffnen eine frische Datei, in der `CREATE TABLE` die neuen Spalten schon enthält, und sie legen nie zwei `death_awards` für dasselbe Paar in zwei Saisons an. Die Live-DB hat die Spalten nicht. `openDb` führt `SCHEMA` **vor** `migrate` aus.

## 2. Findings

### F1 — Live-Start bricht ab, bevor `migrate` die Spalten anlegt

- **Kategorie:** FEHLER
- **Schwere:** kritisch
- **Ort:** `src/db/schema.js:66-67` und `src/db/schema.js:121-122`, aufgerufen aus `src/db/index.js:13-14` (`db.exec(SCHEMA)` vor `migrate`)
- **Wirkung:** Auf der laufenden NAS-DB existiert `celeb_review_queue` ohne `season_id`. `CREATE TABLE IF NOT EXISTS` ändert die Tabelle nicht, der folgende Index schon:

```sql
CREATE INDEX IF NOT EXISTS idx_review_season_status
  ON celeb_review_queue(season_id, status);
```

Nachgestellt mit einer DB in der Form vor M3: `SQLITE_ERROR: no such column: season_id`. `exec` wirft, `migrate` läuft nicht, `phase` wird nicht nachgezogen, der Prozess kommt nicht hoch. Derselbe Index auf `death_awards(…, season_id)` liegt direkt dahinter.

- **Fix:** Beide Indizes aus dem String `SCHEMA` nehmen und erst am Ende von `migrate` anlegen, nachdem die `ADD COLUMN`s durch sind.

```js
// am Ende von migrate(), nach den ALTER TABLE
const reviewCols = cols("celeb_review_queue");
const awardCols = cols("death_awards");
if (reviewCols.has("season_id")) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_review_season_status
    ON celeb_review_queue(season_id, status)`);
}
if (awardCols.has("season_id")) {
  db.exec(`DROP INDEX IF EXISTS idx_death_awards_celeb_player`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_death_awards_celeb_player_season
    ON death_awards(celeb_id, player_id, season_id)`);
}
```

### F2 — Zweite Saison-Gutschrift ist unique-verboten und wird beim nächsten Start gelöscht

- **Kategorie:** FEHLER
- **Schwere:** kritisch
- **Ort:** `src/db/schema.js:324-340`; Wirkung in `src/db/index.js:1020-1084`
- **Wirkung:** `migrate` legt bei **jedem** Start den alten Index neu an und löscht vorher Dubletten ohne Saison:

```324:340:src/db/schema.js
  db.exec(`
    DELETE FROM death_awards
    WHERE id NOT IN (
      SELECT MIN(id) FROM death_awards GROUP BY celeb_id, player_id
    );
  `);
  // ...
    CREATE UNIQUE INDEX IF NOT EXISTS idx_death_awards_celeb_player
      ON death_awards(celeb_id, player_id);
```

Nachgestellt an einer frischen DB nach `SCHEMA` + `migrate`: beide Indizes existieren, `INSERT` der 2027er-Zeile für dasselbe `(celeb_id, player_id)` wirft `UNIQUE constraint failed: death_awards.celeb_id, death_awards.player_id`. Das `DELETE … GROUP BY celeb_id, player_id` behält nur `MIN(id)` — die 2026er-Zeile — und wirft die 2027er-Gutschrift weg.

`applyDeath` schreibt `season_id` korrekt, setzt `is_alive = 0` und `base_points` aber **vor** dem Insert und ohne Transaktion. Schlägt der Index fehl, ist die Person tot, die Punkte sind erhöht, die Award-Zeile fehlt, und der nächste Lauf kehrt bei `!is_alive` sofort zurück.

- **Fix:** Den Block `DELETE … GROUP BY celeb_id, player_id` und `CREATE UNIQUE INDEX idx_death_awards_celeb_player` aus `migrate` entfernen. Den alten Index bei jedem Start droppen (siehe F1). `applyDeath` in `db.transaction` packen, sodass Tod, Punkte und Insert zusammen zurückrollen.

### F3 — 2026er-Reviews bleiben `season_id NULL` und blocken nach dem Wechsel `/go`

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/db/index.js:345-386`
- **Wirkung:** Der Zweig für die aktive Saison schreibt `season_id` weder im `INSERT` noch im `ON CONFLICT`. Import-Reviews bleiben `NULL`. `countPendingReviews({ blockingLive: true })` zählt `season_id IS NULL OR season_id = aktive Id`. Nach dem Wechsel ist die aktive Id 2027, die alten NULL-Zeilen zählen weiter mit und lassen sich durch Re-Enqueue nicht auf die 2026er-Id stempeln — der Plan verlangt genau dieses Stempeln, damit sie danach aus dem Blocker fallen.
- **Fix:** Immer `season_id` mitschreiben. Der `allow`-Check davor bleibt.

```js
db.prepare(
  `INSERT INTO celeb_review_queue (
     celeb_id, proposed_wiki_url, proposed_age, proposed_lang, proposed_candidates,
     status, season_id, updated_at
   ) VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
   ON CONFLICT(celeb_id) DO UPDATE SET
     proposed_wiki_url = excluded.proposed_wiki_url,
     proposed_age = excluded.proposed_age,
     proposed_lang = excluded.proposed_lang,
     proposed_candidates = COALESCE(excluded.proposed_candidates, celeb_review_queue.proposed_candidates),
     status = 'pending',
     season_id = excluded.season_id,
     updated_at = datetime('now')`
).run(celebId, proposal?.wikiUrl || null, proposal?.proposedAge ?? null,
      proposal?.lang || null, candidatesJson, effSeasonId);
```

Den zweiten Zweig (Insert ohne `season_id`) streichen.

### F4 — Confirm einer 2027er-Karte kann einen 2026er-Celeb dauerhaft aus dem Auto-Match nehmen

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/db/index.js:567-630`
- **Wirkung:** `isAnnounced` wird **vor** `mergeCelebs` gelesen. Bestätigt der Admin eine URL, deren QID schon der bestätigte 2026er-Celeb ist, merget der Code auf diese Zeile und führt danach den announced-Zweig aus: `exclude_from_auto = 1`. Der Flip in `activateAnnouncedSeason` (`src/db/index.js:189-197`) setzt das Flag nur zurück, wenn der Celeb **keinen** Pick in der archivierten Saison hat. Wer in beiden Jahren gepickt ist, bleibt ausgeschlossen. Ab dem Confirm fehlt die Person im 2026er-Deathpool, und der 1.1. holt sie nicht zurück.
- **Fix:** Nach dem Merge neu lesen. Den announced-Update nur anwenden, wenn die kanonische Zeile keinen Pick in `phase = 'running'` hat und nicht schon `wiki_confirmed = 1` war.

```js
const canonical = db.prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
const inRunning = celebHasRunningPick(celebId);
if (isAnnounced && canonical.wiki_confirmed === 1 && inRunning) {
  markReviewStatus(celebId, "done");
  return canonical;
}
```

### F5 — Import schreibt Todespunkte ohne `season_id`

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/commands/import.js:61-73`
- **Wirkung:** Für schon tote Celebs prüft der Code `death_awards` nur über `(celeb_id, player_id)` und inserted ohne `season_id`. Eine 2026er-Zeile unterdrückt damit die 2027er-Gutschrift. Fehlt eine Zeile, entsteht ein NULL-Key. `applyDeath` sucht später mit `season_id` der aktiven Saison, findet den NULL-Key nicht und kann noch einmal punkten.
- **Fix:**

```js
const seasonId = season.id;
const existing = db.getDb().prepare(
  `SELECT 1 FROM death_awards WHERE celeb_id = ? AND player_id = ? AND season_id = ?`
).get(celeb.id, player.id, seasonId);
// ...
db.getDb().prepare(
  `INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (?, ?, ?, ?)`
).run(celeb.id, player.id, score, seasonId);
```

### F6 — `retractDeath` bucht jede Saison auf das aktuelle Konto zurück

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/db/index.js:1106-1116`
- **Wirkung:** Die Funktion liest und löscht **alle** `death_awards` des Celebs und zieht die Punkte von `players.base_points` ab. Nach `activateAnnouncedSeason` steht der Kontostand auf 0, die 2026er-Punkte liegen im Snapshot. `/resurrect` auf einen Dezember-Fehltreffer zieht die archivierten Punkte aus dem 2027er-Konto (negativ) und löscht die Archivzeile.
- **Fix:** Nur die aktive Saison anfassen.

```js
const season = getActiveSeason();
const awards = db.prepare(
  `SELECT * FROM death_awards WHERE celeb_id = ? AND season_id = ?`
).all(celebId, season.id);
// base_points wie bisher je Zeile
db.prepare(`DELETE FROM death_awards WHERE celeb_id = ? AND season_id = ?`)
  .run(celebId, season.id);
```

### F7 — Mehrdeutige Tipps können nie aufgelöst werden

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/db/index.js:884-893`, Aufruf `src/discord/pick-assistant.js:341-349` und `:141-146`
- **Wirkung:** `resolvePendingSynchronous` übergibt `candidates_json`. `setDraftEntryLinked` kennt das Feld nicht, die Spalte bleibt `NULL`. `buildPickSelect` und `handlePickInteraction` parsen `[]`, das Menü erscheint nicht, `link_status` ist `ambiguous`. `finalizeDraft` blockt `fertig` dauerhaft. Prominente Namen mit zwei QIDs sind der Normalfall, den der Plan mit `pka:pick:<entryId>` abdecken will.
- **Fix:** Die Spalte im `UPDATE` setzen (nicht `COALESCE`, sonst bleibt ein alter Kandidat stehen):

```js
function setDraftEntryLinked(entryId, { wikiUrl, wikiNorm, qid, proposedAge, linkStatus, candidatesJson }) {
  db.prepare(
    `UPDATE pick_draft_entries SET
       wiki_url = ?, wiki_norm = ?, qid = ?, proposed_age = ?,
       candidates_json = ?, link_status = ?
     WHERE id = ?`
  ).run(wikiUrl ?? null, wikiNorm ?? null, qid ?? null, proposedAge ?? null,
        candidatesJson ?? null, linkStatus ?? "pending", entryId);
}
```

Aufrufer: `candidatesJson: JSON.stringify(proposal.candidates || [])`.

### F8 — Wikipedia-Fehler lässt den Eintrag `pending` und blockt `fertig`

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/pick-assistant.js:361-364`
- **Wirkung:** `catch (e)` verschattet den Eintrag. `e.id` ist `undefined`, `setDraftEntryLinked` trifft keine Zeile, `link_status` bleibt `pending`. Der Plan sagt: Fehler → `unlinked`, `logError`, nächster Name. `fertig` bricht an jedem hängengebliebenen `pending` ab. Es gibt keinen zweiten Poll, der das nachzieht.
- **Fix:**

```js
} catch (err) {
  console.warn("[pick] propose failed", e.raw_name, err.message);
  db.setDraftEntryLinked(e.id, { linkStatus: "unlinked", candidatesJson: null });
  await logError(ctx.client, ctx.config, err, { where: "pick propose", userId });
}
```

### F9 — Zweite DM während der Auflösung wird verworfen, die Namen bleiben `pending`

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/pick-assistant.js:316-318` und `:327-330`
- **Wirkung:** `tryConsumePickMessage` hängt die Namen an und ruft `resolvePendingSynchronous` mit `void` auf. Ist der User in `busyUsers`, kehrt die Funktion sofort zurück. Die Schleife hat ihre Einträge schon am Anfang gelesen und sieht die neuen Zeilen nicht. Die Namen bleiben `pending`, `fertig` blockt. Der Plan verlangt eine Queue pro User, die `pending` der Reihe nach abarbeitet, nicht ein Drop.
- **Fix:** Bei belegtem User ein Rerun-Flag setzen und nach dem Durchlauf noch einmal alle `pending` lesen.

```js
const rerun = new Set();
async function resolvePendingSynchronous(ctx, channel, userId, season, draftId) {
  if (busyUsers.has(userId)) { rerun.add(userId); return; }
  busyUsers.add(userId);
  try {
    do {
      rerun.delete(userId);
      for (const e of db.listDraftEntries(draftId)) {
        if (e.link_status !== "pending") continue;
        // proposeWikiForName wie bisher, Name für Name
      }
    } while (rerun.has(userId));
  } finally {
    busyUsers.delete(userId);
  }
}
```

### F10 — `entfernen` / `ändern` gehen nach `fertig` noch, die Picks nicht

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/pick-assistant.js:237-261` und `:264-286`; `removeDraftEntry` / `replaceDraftEntryName` prüfen `status` nicht (`src/db/index.js:868-881`)
- **Wirkung:** `finalizeDraft` hat die Picks der announced-Saison schon geschrieben und den Draft auf `finalized` gesetzt. `entfernen 3` löscht nur die Draft-Zeile. Der Spieler sieht eine kürzere Liste, `applyDeath` zahlt den Pick weiter. Der Plan friert die Liste mit `fertig` ein, solange die announced-Saison die Zielsaison ist.
- **Fix:** In beiden Message-Zweigen, vor der Mutation:

```js
if (draft.status !== "draft") {
  await msg.reply("Deine Liste ist eingefroren.");
  return true;
}
```

Dieselbe Prüfung in `removeDraftEntry` und `replaceDraftEntryName`, analog zu `addDraftNames`.

### F11 — `/picks` wirft für jeden, der noch keine `players`-Zeile hat

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/pick-assistant.js:86-95`, aufgerufen aus `src/discord/commands/picks.js:41`
- **Wirkung:** `player` ist `const` und wird im `if` neu zugewiesen. `db.prepare` gibt es nicht (`prepare` hängt an `getDb()`). Beides wirft, sobald der User nicht schon aus 2026 in `players` steht. Genau die Neuanmeldung, die das Embed beschreibt, trifft diesen Pfad. Die DM-Liste (`upsertPlayer` in `tryConsumePickMessage`) ist davon nicht betroffen.
- **Fix:**

```js
let player = db.getDb().prepare(
  "SELECT * FROM players WHERE discord_user_id = ?"
).get(String(userId));
if (!player) {
  player = db.upsertPlayer({
    displayName: String(userId),
    discordUserId: String(userId),
  });
}
```

Besser den Anzeigenamen aus `interaction.user` / `msg.author` durchreichen.

### F12 — Admin ohne `ViewChannel` wird abgewiesen, wenn er Mitglied der Guild ist

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/membership.js:27-33`
- **Wirkung:** Fehlt `ViewChannel`, kommt sofort `{ ok: false, reason: "not-member" }`. Der Admin-Fallback in Zeile 40 und 46 läuft nur, wenn `members.fetch` wirft oder kein Member zurückkommt. Der Plan lässt `config.adminId` ohne `ViewChannel` durch, solange die announced-Saison `live = 0` ist und einen Kanal hat — sonst ist der Flow vor dem ersten fremden Teilnehmer nicht prüfbar.
- **Fix:**

```js
const member = await channel.guild.members.fetch(userId);
const perms = channel.permissionsFor(member);
const isAdmin = String(userId) === String(config.adminId);
if (isAdmin || perms?.has("ViewChannel")) return { ok: true, season };
return { ok: false, reason: "not-member" };
```

### F13 — `/season start_date` verschiebt die laufende 2026er-Altersbasis

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/commands/season.js:52-55` (`setSeasonStartDate` ohne Phasenprüfung, `src/db/index.js:81-84`)
- **Wirkung:** M4 verlangt: bei `phase = running` und `live = 1` verweigern. Das 2027er-Datum setzt nur `openAnnouncedSeason`. Ein `/season start_date:2027-01-01` im November schreibt `seasons.start_date` der aktiven Zeile. Daran hängen Alter, `isDeathValidForSeason` und der Poller (`seasonStartDate: getActiveSeason().start_date`).
- **Fix:**

```js
const current = db.getActiveSeason();
if (current.phase === "running" && current.live) {
  await msg.reply("Startdatum der laufenden Saison ist fest. 2027 setzt `/announce-season`.");
  return;
}
```

### F14 — Buttons der 2027er-Review verlassen die announced-Queue

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/celeb-review.js:307`, `:347-361`, `:374`, `:393-406`, `:465-477`
- **Wirkung:** `queueCelebsForReview` und `/review` ohne Argument starten mit `seasonId` der announced-Zeile. Jeder Folgeaufruf von `sendNextReview(ctx, channel)` lässt `seasonId` weg. `nextPendingReview(null)` liest nur `season_id IS NULL` oder die **aktive** Id. Die nächste Karte ist eine 2026er-Karte, oder der Text „Warteschlange leer“, während 2027er-Karten `pending` bleiben. Die bleiben `exclude_from_auto = 1` und werden am 1.1. nicht freigeschaltet (`wiki_confirmed` fehlt).

`skip` löscht die Zeile und ruft `enqueueReview(celebId, …)` **ohne** `seasonId` auf. Die neue Zeile hat `season_id NULL` (F3) und fällt aus `/review` der Anmeldung heraus, zählt aber in `blockingLive`.

`crev:url`, die Kandidatenwahl und `tryConsumeReviewUrl` rufen `enqueueReview` ebenfalls ohne `seasonId` auf und rechnen `lookupUrl` mit `getActiveSeason().start_date` (2026-01-01). Für eine announced-Zeile liefert der Konfliktcheck `other-season`, der Vorschlag wird nicht gespeichert, die UI sagt trotzdem „Gewählt“.

- **Fix:** Hilfsfunktion, die die Queue-Zeile liest und überall durchreicht:

```js
function seasonForQueue(celebId) {
  const q = db.getDb().prepare(
    "SELECT season_id FROM celeb_review_queue WHERE celeb_id = ?"
  ).get(celebId);
  if (!q?.season_id) return { season: db.getActiveSeason(), seasonId: null };
  const season = db.getDb().prepare("SELECT * FROM seasons WHERE id = ?").get(q.season_id);
  return { season, seasonId: q.season_id };
}
```

`enqueueReview(..., { seasonId })`, `lookupUrl(..., season.start_date)`, und `sendNextReview(..., { season, seasonId })` nach confirm, skip, pick, url und Paste. `skip` darf die Zeile nicht löschen und neu mit der aktiven Id anlegen; `status` hinten anstellen und `season_id` lassen.

### F15 — Admin-Alter und Confirm schreiben das 2027er-Alter nicht auf die Picks

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/celeb-review.js:275` (`setCelebAge`) und `src/db/index.js:617-630` (announced-Zweig von `applyWikiConfirm` setzt `celebs.age_at_pick` absichtlich nicht)
- **Wirkung:** Fallstrick 11: das maßgebliche Alter liegt auf `picks.age_at_pick` der announced-Saison. `applyDeath` nimmt `pick.age_at_pick ?? celeb.age_at_pick`. Der Alter-Button schreibt nur die Celeb-Spalte und verweigert, sobald irgendein `death_awards` existiert (auch 2026). Ein gesetztes Pick-Alter gewinnt, die Korrektur ändert den 2027er-Score nicht. Fehlt `P569`, bleibt der Pick `NULL` und der Score 0, obwohl der Admin ein Alter eingetippt hat.
- **Fix:** Im announced-Zweig und im Alter-Button, statt `setCelebAge`:

```js
if (isAnnounced) {
  db.getDb().prepare(
    `UPDATE picks SET age_at_pick = ? WHERE celeb_id = ? AND season_id = ?`
  ).run(age, celebId, q.season_id);
}
```

`setCelebAge` nur, wenn die Queue-Saison aktiv oder `NULL` ist.

### F16 — `planAnnouncements` unterdrückt echte Tote, deren `isHuman` nicht `true` ist

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/wiki/announce-dedup.js:83-94`; ausgelöst durch `src/wiki/death-brief.js:418-420` und `src/jobs/wiki-poll.js:376-388`
- **Wirkung:** Regel 4 gilt für `isHuman === false` oder `redName && isHuman !== true`. Der Code schickt **alles**, was nicht `isHuman === true` ist, in denselben Namensabgleich. Wikidata-Fehler werden in `fetchDeathBrief` geschluckt (`isHuman` bleibt `null`, `resolved.error` bleibt `null`), Regel 1 vertagt sie also nicht. Ein zweiter Mensch im selben Lauf oder in `history.humanNames` mit demselben `normName` wird gebunden und nicht gepostet. Regel 3 schützt nur `isHuman === true`. Josef-Mašín-Fälle und jeder Namensvetter ohne P31 verschwinden.

Zusätzlich füllt `recentAnnouncedIdentities` (`src/db/index.js:1312-1322`) `humanNames` mit **jedem** `announced_deaths.name`, auch Bands. Eine frühere Nicht-Personen-Karte unterdrückt die nächste Karte gleichen Namens.

- **Fix:** In Pass 2 nur die Regel-4-Menge nehmen, den Rest posten:

```js
const rule4 = e.resolved?.isHuman === false || (e.redName && e.resolved?.isHuman !== true);
if (!rule4) { post.push(e); continue; }
```

`recentAnnouncedIdentities` soll Namen nur liefern, wenn die Zeile als Mensch bekannt ist (beim Stempeln `is_human` mitschreiben, oder den Namens-Set nur aus Einträgen füllen, die in diesem Lauf als Mensch gepostet wurden). Bis die Spalte da ist: `humanNames` leer lassen und nur `postedHumanNames` dieses Laufs benutzen — lieber eine doppelte Band-Karte als ein verschluckter Tod.

### F17 — DE/EN-Doppel ohne gemeinsames QID bleiben: keine Langlinks-API, keine Regel 5

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/wiki/scraper-de.js:17-31`, `src/jobs/wiki-poll.js:226`, `src/wiki/announce-dedup.js` (kein `enSitelink`)
- **Wirkung:** `resolveEnglishArticle` existiert in `page-lookup.js` nicht. Der Poll hängt weiter an `li.interlanguage-link` im HTML. Ein HTTP-200 ohne diesen Knoten gilt als „kein EN“, die Zeile geht nach `newDeOnly`. Gemeinsames QID fängt das in Pass 1 ab. Fehlt das QID auf einer Seite — der Live-Fall aus F04, wenn die HTML-Brücke den Sitelink nicht sieht — postet Regel 3 beide Menschen. Regel 5 (DE bindet an die EN-Id aus `enSitelink`, auch ohne QID) ist nicht implementiert. `deferredDeEn` hilft nur, wenn das HTML den Link schon gefunden hat; diese DE-Zeilen erreichen `planAnnouncements` gar nicht (`deferredIds`).
- **Fix:** In `page-lookup.js` `resolveEnglishArticle(userAgent, germanUrl)` mit `prop=langlinks&lllang=en&redirects=1`. HTTP- und Netzfehler werfen, Seite ohne `en` ergibt `null`. `resolveSisterUrl` nicht verwenden. In `runWikiPollInner` diese Funktion statt `deData.resolveEnglish` aufrufen. Das aufgelöste EN-Ziel am Entry ablegen (`enSitelink`) und in `planAnnouncements` vor dem Posten binden:

```js
if (e.lang === "de" && e.resolved?.enSitelink) {
  const winner = entries.find((x) => x.id === e.resolved.enSitelink);
  if (winner || historyEnIds.has(e.resolved.enSitelink)) {
    bind.push({ loserId: e.id, winnerId: e.resolved.enSitelink, reason: "sitelink" });
    continue;
  }
}
```

`historyEnIds`: EN-`entry_id`s aus `announced_deaths` der letzten 14 Tage, die schon `announced_at` haben. Der bestehende `deferredDeEn`-Nachzug (Stempeln erst nach `announced_at` des Gewinners) bleibt.

### F18 — `scope:pool` öffnet den 2026er-Pool nicht

- **Kategorie:** FEHLER
- **Schwere:** hoch
- **Ort:** `src/discord/commands/review.js:14-22`
- **Wirkung:** `parseSlash` gibt `[]` zurück, und der Befehl hat keine `scope`-Option. Slash `/review scope:pool` kann die Option nicht senden. Als Prefix ist `scope:pool` truthy, `Number("pool")` ist `NaN`, und `NaN ?? …` bleibt `NaN`. Die Zählung `season_id = NaN` ist 0, die Antwort ist „Warteschlange leer“, obwohl 2026er-Karten da sind. Während die Anmeldung läuft, kommt der Admin über den dokumentierten Aufruf nicht an den laufenden Pool. `!review pool` (ohne `scope:`) trifft den Pool-Zweig; das ist nicht das Beispiel im Befehl.
- **Fix:** Option anlegen und `pool` nicht durch `Number` schicken.

```js
options: [{ name: "scope", description: "next oder pool", type: "STRING", required: false }],
parseSlash(interaction) {
  const s = interaction.options.getString("scope");
  return s ? [`scope:${s}`] : [];
},
// in run:
const token = scope ? scope.split(":")[1] : null;
const wantPool = token === "pool" || args.includes("pool");
const effSeasonId = wantPool ? null : (announced ? announced.id : null);
```

`nextPendingReview(null)` ist der Pool (`NULL` oder aktive Id). `countPendingReviews` für die Antwort muss dasselbe Prädikat benutzen, nicht alle `pending`.

### F19 — Link-Feld fällt auf die Research-URL zurück

- **Kategorie:** FEHLER
- **Schwere:** mittel
- **Ort:** `src/discord/announce.js:237-246`
- **Wirkung:** `isHuman === true` verlinkt die Personenseite. Sonst die Liste, wenn `listUrl` gesetzt ist. Der `else`-Zweig verlinkt `brief.url || entry.url`. Das ist bei Rotlink/Band genau die Research-Seite, die F05 aus dem Feld haben wollte — sobald `listUrl` fehlt (Brücken-Eintrag aus `wiki-poll.js:276-287` kopiert `listUrl` nicht). `linkMode: "list"` setzt niemand. Umgekehrt: `isHuman == null` und gesetztes `listUrl` ersetzt einen vorhandenen Personenartikel durch die Todesliste, obwohl der Plan die Personen-URL auch ohne `pageMissing` zulässt.
- **Fix:**

```js
const personLink = (brief.isHuman === true || (brief.isHuman == null && !brief.pageMissing && !entry.redName))
  && !brief.pageMissing;
if (personLink) linkValue = `[Wikipedia](${brief.url || entry.url})`;
else if (entry.listUrl) linkValue = `[Wikipedia-Liste](${entry.listUrl})`;
else linkValue = "Kein eigener Wikipedia-Artikel";
```

Brücken-Einträge: `listUrl: d.listUrl` am Objekt `bridged` setzen.

### F20 — Notfall-Wipe legt eine Saison ohne `phase` an

- **Kategorie:** FEHLER
- **Schwere:** mittel
- **Ort:** `src/db/index.js:1459-1468`
- **Wirkung:** `assertWipeAllowed` lässt den Wipe nur ohne `running` und ohne announced zu. `clearSeasonForNewYear` setzt die alte Zeile nur `active = 0` (Phase bleibt `setup`) und inserted die neue Zeile ohne `phase`. Danach wirft `openAnnouncedSeason` für dasselbe Jahr („bereits belegt“, die alte Zeile ist noch `setup`), und `activateAnnouncedSeason` wirft „Aktive Saison ist nicht running“. Der Notfallpfad kann die nächste Runde nicht mehr eröffnen.
- **Fix:**

```js
db.prepare(
  `UPDATE seasons SET active = 0, live = 0, phase = 'archived' WHERE id = ?`
).run(old.id);
db.prepare(
  `INSERT INTO seasons (year, active, start_date, live, phase) VALUES (?, 1, ?, 0, 'setup')`
).run(y, start);
```

### F21 — Die zwei erlaubten Log-Zeilen aus M2 fehlen

- **Kategorie:** FEHLER
- **Schwere:** mittel
- **Ort:** `src/jobs/wiki-poll.js:411-423` (Bind ohne `logEvent`) und `:470-473` (Deathpool-`catch` nur `console.error` + `ops.noteError`)
- **Wirkung:** Unterdrückte Karten und der eine Deathpool-Fehler pro Treffer kommen nicht in `CHANNEL_LOG`. Scan-Zähler bleiben zu Recht auf stdout. `bind` trägt auch kein `reason` (`qid` | `sitelink` | `nonperson-name`), das der Plan pro Karte verlangt.
- **Fix:** Nach dem erfolgreichen Stempeln eines Verlierers einmal `logEvent({ kind: "announce-suppress", summary, detail: reason })`. Im Deathpool-`catch` `logError(client, config, err, { where: "deathpool " + m.celeb.name })`. `reason` in `planAnnouncements` an jedes `bind`-Objekt setzen. Kein Log für `defer` und keine Zeile „gescraped N“.

### F22 — Zwei Kandidaten ohne zwei QIDs gelten als eindeutig verknüpft

- **Kategorie:** FEHLER
- **Schwere:** mittel
- **Ort:** `src/discord/pick-assistant.js:30-35`
- **Wirkung:** `ambiguous` nur bei `distinctQids.size >= 2`. Zwei Treffer ohne QID, oder einer mit und einer ohne, werden `linked` und nehmen `proposal.wikiUrl` (der erste Treffer). Der Spieler bekommt kein Menü. Der Plan: zwei verschiedene QIDs sind ambiguous; fehlende QID ist nicht automatisch derselbe Mensch.
- **Fix:**

```js
if (cands.length >= 2) return { linkStatus: "ambiguous" };
```

Eine QID und ein zweiter Treffer ohne QID ist weiterhin eine Wahl, kein stilles Verknüpfen.

### F23 — `repost` mit neuem Kanal speichert den Kanal nicht

- **Kategorie:** FEHLER
- **Schwere:** mittel
- **Ort:** `src/discord/commands/announce-season.js:135-137`
- **Wirkung:** `setSeasonAnnounce` läuft nur, wenn `note` sich ändert. Ein Repost mit anderem `announce_channel` postet das Embed dorthin, `announce_channel_id` bleibt der alte. `canParticipate` prüft weiter den ersten Kanal.
- **Fix:**

```js
const chanChanged = chanId !== announced.announce_channel_id;
if (chanChanged || (note && note !== announced.announce_note)) {
  db.setSeasonAnnounce(announced.id, {
    channelId: chanId,
    note: note ?? announced.announce_note,
  });
}
```

`setSeasonAnnounce` darf `channelId || null` nicht schreiben, wenn der Aufrufer den Kanal weglässt — sonst löscht ein Notiz-Update den Kanal (`src/db/index.js:136-138`).

### F24 — QID-Treffer auf eine unbestätigte Zeile kommt nicht in die Review

- **Kategorie:** FEHLER
- **Schwere:** mittel
- **Ort:** `src/db/index.js:912-915` und `:963-965`
- **Wirkung:** Jeder QID- oder `wiki_norm`-Treffer setzt `reuse: true`. `reviewIds` enthält nur `!reuse && wiki_confirmed === 0`. Eine unbestätigte Zeile mit QID wird nicht eingereiht. Nach dem Wechsel zählt `countUnconfirmedSeasonCelebs` sie (Pick in der dann aktiven Saison, `wiki_confirmed = 0`), der Exclude-Flip verlangt `wiki_confirmed = 1`. Die Person läuft nie im Auto-Match. Der Plan: `reviewIds` sind alle, die danach noch unbestätigt sind und keinen running-Pick haben.
- **Fix:**

```js
if (celeb.wiki_confirmed !== 1 && !celebHasRunningPick(celeb.id)) {
  reviewIds.push(celeb.id);
}
```

`reuse` nur noch als „Flags nicht anfassen“ in `linkCelebForAnnouncedSeason` verwenden, nicht als Filter für die Queue.

### F25 — Kein Fortschritt „3/12“ bei langen Listen

- **Kategorie:** VERBESSERUNG
- **Schwere:** niedrig
- **Ort:** `src/discord/pick-assistant.js:326-379`
- **Wirkung:** 25 Namen sind mehrere Minuten (`proposeWikiForName`, 350 ms plus Suche). Die DM bleibt stumm, bis am Ende ein Embed kommt. Der Plan sagt: die Auflösung editiert „3/12“. Discord-Ack ist hier kein Slash-Token, die Liste wirkt aber hängend, und eine zweite Nachricht läuft in F9.
- **Fix:** Vor der Schleife eine Nachricht senden und pro Namen `edit` auf `Aufgelöst ${i}/${entries.length}: ${e.raw_name}`.

### F26 — Fehlgeschlagenes Embed und danach die Erfolgsmeldung

- **Kategorie:** VERBESSERUNG
- **Schwere:** niedrig
- **Ort:** `src/discord/commands/announce-season.js:192-218`
- **Wirkung:** Schlägt `channel.send` fehl, antwortet der `catch` mit dem Fehler, und der Code läuft weiter in `logEvent` plus „Saison angekündigt“. Die Zeile ist committed (richtig), der Admin liest danach den Erfolg. Fehlt der Kanal ganz (`channel` null), gibt es weder `logError` noch eine Fehlermeldung.
- **Fix:** `send` in ein `try`, bei Fehler nur die Fehlermeldung und `return` nach `logError`. Erfolg-Reply nur, wenn der Send geklappt hat oder bewusst übersprungen wurde.

### F27 — Mitgliedschaft: jeder Fetch-Fehler außer 10007 ist „kein Mitglied“

- **Kategorie:** VERBESSERUNG
- **Schwere:** niedrig
- **Ort:** `src/discord/membership.js:36-47`
- **Wirkung:** 429, Timeout oder fehlende Rechte am Fetch fallen in den letzten `return not-member` (Admin ausgenommen). Eine kurze Discord-Störung lehnt jede Anmeldung ab, ohne Log. Der Plan unterscheidet „Unknown Member“ und einen verpassten Fetch.
- **Fix:** Im `catch` für alles außer 10007 `{ ok: false, reason: "channel" }` oder einen eigenen Grund `unavailable` zurückgeben, `logError` einmal, und in `tryConsumePickMessage` dafür keine Ablehnungs-DM schicken (sonst eine DM pro Tipp während der Störung).

## 3. MUSS vor Deploy gefixt werden

Nur kritisch und hoch. Mittel und Verbesserung blockieren den November-Start nicht, F20 aber den Notfall-Wipe und F17 die Doppelkarten.

1. **F1** — `SCHEMA`-Indizes auf noch nicht migrierte Spalten. Der Bot startet auf der Live-DB nicht.
2. **F2** — Alter Unique-Index und `DELETE` ohne `season_id`. 2027 zahlt dieselbe Person kein zweites Mal, und ein Neustart löscht die zweite Gutschrift.
3. **F3** — Aktive Reviews ohne `season_id`. Nach dem Wechsel blocken sie `/go`.
4. **F4** — Announced-Confirm setzt `exclude_from_auto = 1` auf den gemergten 2026er-Celeb.
5. **F5** — Import-Awards ohne `season_id`.
6. **F6** — `retractDeath` über alle Saisons auf das aktuelle Konto.
7. **F7** — `candidates_json` wird nie geschrieben. Mehrdeutige Tipps sind nicht finalisierbar.
8. **F8** — Wiki-Fehler lässt `pending` stehen.
9. **F9** — Zweite DM während der Auflösung bleibt `pending`.
10. **F10** — `entfernen`/`ändern` nach `fertig` ändern die Picks nicht.
11. **F11** — `/picks` wirft für neue Spieler.
12. **F12** — Admin ohne `ViewChannel` kommt nicht in den Assistenten.
13. **F13** — `/season start_date` überschreibt den 2026er-Stichtag.
14. **F14** — Review-Buttons verlassen die 2027er-Queue; `skip` macht daraus eine NULL-Zeile.
15. **F15** — 2027er-Alter landet nicht auf `picks.age_at_pick`.
16. **F16** — Dedup verschluckt Tote mit `isHuman == null` bei Namensgleichheit.
17. **F17** — DE→EN weiter über HTML, Regel 5 fehlt. Doppelkarten ohne gemeinsames QID bleiben.
18. **F18** — `scope:pool` zeigt eine leere Queue.
