# DeathBot-2000 — Implementierungs- und Architekturplan (v2, Stand 2026-11-14, Zwei-Saison-Modell)

Stand: 2026-11-14, v2. Ersetzt den Plan v1 an dieser Stelle. Grundlage: `ANFORDERUNGEN.md`, `ANALYSE-DB.md`, `AUFGABE-ZWEI-SAISON.md`, Quellstand im Workspace (`src/`, `test/`, `scripts/`). Pfade sind Repo-Pfade (`docker-compose.yml` liegt im Repo-Root, nicht unter `scratch/`).

Stack und Betrieb, unverändert: Node 20, discord.js 14, better-sqlite3, Docker auf der WD-NAS, öffentliches Repo `github.com/Emil007/DeathBot-2000`, Bot „Gregg#0124“. Live-DB: Saison 2026, `start_date` 2026-01-01, `live = 1`.

Bestehende Bausteine, die dieser Plan erweitert: `src/db/index.js` (`getActiveSeason`, `clearSeasonForNewYear`, `findOrCreateCeleb`, `setPick`, `clearPicksForPlayer`, `enqueueReview`, `applyWikiConfirm`, `applyDeath`, `findCelebByWikiNorm`, `findCelebByWikidataId`, `mergeCelebs`, `upsertPlayer`, `scoreForAge`, `markWikiAnnounced`), `src/wiki/page-lookup.js` (`proposeWikiForName`, `lookupUrl`, `normalizeWikiUrl`, `getPageMeta`, `isPersonPage`), `src/discord/celeb-review.js`, `src/discord/commands/import.js` (`tryConsumePaste`, Chunks bis `done`/`fertig`/`end`), `src/discord/commands/new-year.js`, `src/discord/commands/go.js` (`countPendingReviews`), `src/discord/msg-adapter.js`, `src/discord/admin-notify.js`, `src/config.js`.

`mergeCelebs` bleibt die Identität der **Pool-Celebs**. Der All-Deaths-Feed dedupliziert darüber nicht. `announced_deaths` / `wiki_seen` sind ein anderes Modell (Entry-IDs, kein Celeb) und bekommen keine `season_id`.

### Entschieden am 2026-11-14 (Zwei-Saison-Modell)

Fragen 1–11 aus v1: Empfehlung übernommen, siehe Abschnitt 4.1. Frage 12 ist entschieden und widerspricht dem v1-Default. Daraus folgt, und das ist der Bauplan:

1. **Saison 2026 läuft weiter live** (`active = 1`, `live = 1`, `phase = running`, Start `2026-01-01`) bis zum Abschluss am oder nach dem 2027-01-01. Kills, Punkte, Rücksetzungen (`retractDeath`), Tagesbericht und All-Deaths laufen auf dieser Zeile weiter. `getActiveSeason()` bleibt ihr Zeiger.
2. **Saison 2027 wird jetzt im November 2026 eröffnet**, als zweite Zeile: `active = 0`, `live = 0`, `phase = announced`, `start_date = 2027-01-01`. Der Admin nennt `announce_channel` und optional `note`. Der Bot postet das Teilnahme-Embed in diesen Kanal.
3. **Bis Ende Dezember 2026** darf jeder mit `ViewChannel` auf diesem Kanal per DM tippen (Arbeitspaket C). Die Tipps werden Picks der announced-Saison (`season_id` = 2027). Alter und Punkteformel rechnen mit `2027-01-01`.
4. **Am 2027-01-01** (Admin-Befehl, kein Cron) wird 2026 archiviert und 2027 live geschaltet. Picks, Celebs, `death_awards` und die schon gesammelten 2027er-Picks bleiben. Der Abschluss löscht sie nicht.
5. **`/new-year confirm` ist nicht mehr die Saisoneröffnung.** Der bisherige Pfad (`clearSeasonForNewYear` plus `DELETE` auf `celebs` / `picks` / `death_awards` / …) wischt den laufenden Pool. Solange eine Saison `phase = running` ist oder eine announced-Zeile existiert, verweigert der Befehl diesen Pfad.
6. **Zwei Saison-Zeilen nebeneinander sind der Normalfall** von November 2026 bis zum Wechsel: `running` (2026) und `announced` (2027).

---

## 0. Empfohlene Reihenfolge

Kritischer Pfad, damit die Anmeldung noch im November 2026 aufgeht: **M1 → M3 → M4 → M5**. Danach **M2**.

| Rang | Paket | Warum diese Stelle |
|------|--------|--------------------|
| 1 | M1 — Logkanal (D) | Kleine Fläche, kein Verhalten am öffentlichen Kanal. Danach sind Eröffnung, Finalisieren und Fehler sichtbar. `CHANNEL_LOG` leer = No-Op, der Bot bleibt startbar. Die Scan-Log-Regel aus v1 gilt wortgleich. |
| 2 | M3 — Schema und Saison-API | Legt `phase`, Drafts, `celeb_review_queue.season_id`, Pick-Alter und Award-Saison an. `openAnnouncedSeason` lässt die 2026er-Zeile unangetastet. Ohne diese API würde jede Eröffnung den Live-Pool überschreiben. |
| 3 | M4 — Tipp-Assistent (C) | Schreibt Drafts und Picks nur auf die announced-Saison. `canParticipate` liest diese Zeile. Der `/go`-Guard zählt die 2027er-Queue nicht gegen 2026. |
| 4 | M5 — Eröffnung und Wechsel (B) | `/announce-season` postet das Embed und setzt den Kanal. Erst dieser Schritt macht die Anmeldung für Spieler auf. Der 1.1.-Wechsel ist ein zweiter, ausdrücklich getrennter Befehl. |
| 5 | M2 — Dedup und Link (A) | Die Live-DB postet weiter Doppelkarten (Abschnitt 1, F01–F06). M2 hängt nur an M1 und ändert keine Saison-Semantik. Er blockiert die November-Anmeldung nicht. |

M2 darf gebaut werden, sobald M1 steht, auch neben M3. Ausgeliefert wird die Anmeldung zuerst: M3, M4 und M5 als ein Block, M2 direkt dahinter. Die Defaults in Abschnitt 4.2 sind so gewählt, dass M3–M5 ohne weitere Antwort baubar sind. Eine spätere Antwort schaltet nur den dort markierten Zweig um.

---

## 1. Konsolidierte Findingliste

### A — Kanal-Qualität

Unverändert gegenüber v1. M2 setzt sie um. Sie betreffen den All-Deaths-Feed, der während der ganzen Parallelphase für 2026 weiterläuft.

**F01 · A · hoch**
Gleiche Person wird als Band-/Sammelseite ein zweites und drittes Mal gepostet, weil `redName` die EN-Brücke abschaltet und die Research-URL zur Karten-URL wird.
Wurzel: `extractFromTables` (`src/wiki/scraper-de.js`) setzt bei Rotlink oder leerer Namenszelle `redName` und hängt die erste andere Zeilen-URL an (`wikiPath` = Band, Partei, Beruf). Die Entry-ID ist `de:red:${nameText}`, also nie dieselbe ID wie die Personenseite. `runWikiPollInner` (`src/jobs/wiki-poll.js`, Zweig `if (d.redName)`) ruft `resolveEnglish` für diese Zeilen nicht auf — Kommentar dort: eine Brücke von der Research-Seite würde die Band als Person announcen. Die Zeile fällt dadurch in `newDeOnly` und `announceAllDeath` postet sie.
Live-Beleg `ANALYSE-DB.md`: Young L am selben Tag als `de:The_Pack_(Band)` (15:21:36), `en:The_Pack_(group)` (15:21:34) und `en:Young_L` (03:29:20). Die beiden Pack-Karten sind Research-Links, die Personenseite existierte schon.
Betroffen: `extractFromTables`, `runWikiPollInner`, `announceAllDeath`, `fetchDeathBrief`.

**F02 · A · hoch**
„Link ins Leere“ und Band-Link auf EN entstehen, weil der EN-Scraper den ersten Anker nimmt und Rotlinks nicht kennt.
Wurzel: `extractEntriesFromHtml` (`src/wiki/scraper-en.js`) setzt `wikiPath` auf den ersten Treffer von `wikiPathFromHref`. Die Funktion schneidet die Query ab, damit wird `/wiki/Name?action=edit&redlink=1` zu einem normalen Pfad. `isRedLink` existiert nur in `scraper-de.js` und wird auf EN nicht verwendet. Eine Zeile, deren Personenname Klartext ist und deren erster blauer Link die Band ist, bekommt die Band als `id`/`url` (`en:/wiki/The_Pack_(group)`). Eine Zeile, deren erster Link ein Rotlink ist, bekommt eine URL ohne Artikel. `fetchDeathBrief` liefert bei `page.missing` den Fallback **mit dieser URL** (`url: pageUrl`) und ohne Kennzeichen „Seite fehlt“ — der Fallback sieht aus wie ein Netzfehler (`isHuman: null`). `announceAllDeath` verlinkt `brief.url || entry.url`.
Betroffen: `wikiPathFromHref`, `extractEntriesFromHtml`, `fetchDeathBrief` (Zweig `page.missing`), `announceAllDeath` (Feld „Link“).

**F03 · A · hoch**
Dedup vor dem Posten kennt nur die Entry-ID, nicht die Person. Dieselbe Person mit zwei Pfaden oder zwei Sprachen wird zwei Karten.
Wurzel: EN-IDs sind `en:${wikiPath}` (`scraper-en.js`), DE-IDs `de:${wikiPath}` oder `de:red:${name}`. `uniqueNewEn` in `runWikiPollInner` kollabiert nur gleiche `e.id`. Es gibt keine Redirect-Auflösung, kein Wikidata-QID, keinen Abgleich mit schon geposteten Karten. `wiki_seen` und `announced_deaths` haben keine QID-Spalte. `markWikiAnnounced` kopiert `text/url/lang` und stempelt die ID; ein späterer Poll mit anderer ID sieht die erste Karte nicht.
Live-Belege, die diese ID-Regel erklärt:
- Thomas Rudy, Michał Oksiński, James Pavatt, Danny Watson, Choi Hyung-woo: je 2 Karten, gleiche Sprache, also zwei verschiedene `entry_id`.
- Peter Antony Moran (de) und Peter Moran (en, `Peter_Moran_(bishop)` vs `Peter_Antony_Moran`): zwei Titel, der Scraper speichert den Href vor Redirect.
- Claudette Soares [pt] / Claudete Soares [pt]: zwei Schreibweisen, zwei IDs. `normalizeName` faltet nur Akzente.
- Josef Mašín (en) und Josef Mašín jun. (de): am Namen zusammenzuziehen wäre falsch. Nur ein gemeinsames QID oder ein Redirect darf hier kollabieren.
Betroffen: `uniqueNewEn`, `markWikiSeen`, `markWikiAnnounced`, Schema `wiki_seen` / `announced_deaths`.

**F04 · A · hoch**
Die DE→EN-Regel ist im Code scharf (EN gewinnt, DE-only nur ohne EN-Ziel, HTTP-Fehler wird vertagt), die Erkennung des EN-Ziels ist es nicht. Deshalb erscheinen DE- und EN-Karte derselben Person kurz hintereinander.
Wurzel: `resolveEnglish` (`scraper-de.js`) liest `li.interlanguage-link.interwiki-en a` aus dem DE-HTML. Ein Treffer `null` nach HTTP 200 gilt als „kein EN“ und die Zeile geht nach `newDeOnly`. Die API liegt schon im Repo und wird vom Poll nicht benutzt: `prop=langlinks` bzw. die Sitelinks in `getPageMeta`. `resolveSisterUrl` (`page-image.js`) darf nicht 1:1 eingesetzt werden: der `catch` gibt `null` zurück und würde einen Netzfehler als DE-only lesen.
Live-Belege: Vyacheslav Briukhovetskyi / Wjatscheslaw Brjuchowezkyj, Masaaki Yamazaki, Karl Johan Åström.
Betroffen: `resolveEnglish`, `runWikiPollInner`, `announceDailySummary`.

**F05 · A · hoch**
Auch wenn der Kartentitel schon der Personenname ist, bleibt der klickbare Link die Nicht-Personen-Seite.
Wurzel: `fetchDeathBrief` baut bei `redName && isHuman !== true` Name, Alter und Beruf aus der Listenzeile und setzt `url` auf die Research-Seite. `announceAllDeath` korrigiert den Titel, das Feld „Link“ bleibt `brief.url`. Dieselbe Lücke gilt für EN-Zeilen, deren erster Link keine Person ist.
Live-Beleg: Christian Cousins — EN auf der eigenen Seite, DE auf `Christian_und_Joseph_Cousins`. Young L analog mit `The_Pack_(Band)`.
Betroffen: `fetchDeathBrief`, `announceAllDeath`.

**F06 · A · mittel**
Der Tagesbericht kann DE- und EN-Paare nur zusammenlegen, wenn `normalizeName(personNameFromText(name))` gleich ist. Transliteration, `[lang]`-Suffix und „Peter Antony Moran“ / „Peter Moran“ bleiben doppelt. Sobald F03 die zweite Karte nicht schreibt, verschwindet sie auch hier. Eine eigene Namens-Heuristik im Digest ist nicht vorgesehen.
Betroffen: `announceDailySummary`, `personNameFromText`, `normalizeName`, `deathsSinceHours`.

### B — Saisonstart im laufenden Betrieb

**F07 · B · hoch (Bruch mit v1)**
`/new-year` kann die kommende Saison nicht neben der laufenden eröffnen. Es gibt genau eine `active = 1`-Zeile, und der Befehl ersetzt sie.
Wurzel: `src/discord/commands/new-year.js` hat nur `confirm` und `start_date`. `run` ruft `createPackage`, dann `clearSeasonForNewYear(year, startDate)`, dann rohes `DELETE` auf `death_awards`, `picks`, `celeb_aka`, `celeb_blacklist`, `celebs`, `player_bonuses`. `clearSeasonForNewYear` (`src/db/index.js`) setzt die alte Zeile `active = 0`, legt eine neue mit `active = 1`, `live = 0` an und setzt `players.base_points = 0`. `seasons` hat `year`, `active`, `start_date`, `live` — keine Phase, keinen Kanal. Ein Aufruf im November 2026 würde 2026 als Scoring-Zeile ablösen, die Punkte nullen und danach alle Celebs und Picks löschen. `wiki_seen` und `announced_deaths` bleiben (richtig für den Feed, irrelevant für den Pool).
Es gibt keine zweite Zeile `phase = announced` und keinen Pfad, der nur Kanal und Embed schreibt. v1 hatte den Wipe ausdrücklich behalten. v2 legt die Eröffnung daneben und lässt den Wipe bei `phase = running` verweigern (M5).

**F08 · B · mittel**
Der Teilnahme-Satz kann heute nicht wahr werden, und der v1-Riegel „Assistent zu, solange `live = 1`“ würde ihn auch nach dem Bau zu halten: die einzige live-Zeile ist 2026 und soll live bleiben.
Der einzige Listen-Eingang ist Admin-`/import` (F10). Ein Embed, das den Tipp-Assistenten erklärt, wäre bis M4 eine falsche Anleitung. Die Membership-Prüfung hat keinen gespeicherten Kanal. Intents in `src/index.js`: Guilds, GuildMessages, MessageContent, DirectMessages, Partial `Channel`. Kein `GuildMembers`. `guild.members.fetch(userId)` geht per REST und wird nirgends aufgerufen.
v2 bindet Embed, Kanal und `canParticipate` an die announced-Zeile. `live = 1` auf 2026 schließt die 2027er-DMs nicht.

### C — Tipp-Assistent per PM

**F09 · C · hoch (Lücke, Schreibziel)**
Spieler können keine Liste abgeben. `messageCreate` (`src/index.js`) kennt drei nicht-präfixige Wege: `tryConsumeReviewUrl`, `importCmd.tryConsumePaste`, danach nur `prefix`. `tryConsumePaste` liest eine Prozess-`Map` (`pending`, 15 Minuten, Schlüssel = User-ID des Admins, der `/import` aufgerufen hat). `applyImportRows` nimmt `db.getActiveSeason()`, ruft `clearPicksForPlayer(player, season.id)`, `findOrCreateCeleb`, `setPick` und sammelt `reviewIds`. Solange `getActiveSeason()` die 2026er-Zeile bleibt, schreibt der Import den Live-Pool — das ist für Admin-Korrekturen an 2026 richtig und für 2027er-Tipps falsch. Der Puffer stirbt beim Neustart. 2027 braucht `pick_drafts` mit `season_id` der announced-Zeile, und `applyImportRows` braucht eine Assertion, die eine announced-Zeile als Ziel ablehnt, falls jemand `getActiveSeason` später umbiegt.

**F10 · C · hoch**
Ein Light-Review mit Buttons für Spieler funktioniert mit dem heutigen Router nicht. Zusätzlich ist die Admin-Queue global und würde 2026er-Celebs entvalidieren.
Wurzel Router: `handleReviewInteraction` (`celeb-review.js`) prüft den Typ, dann `interaction.user.id !== adminId` → „Nur Admin.“ und `return true`. Die Custom-ID wird erst danach gelesen. Jeder Nicht-Admin-Button wird verschluckt. `index.js` ruft Review direkt nach Help auf. Spieler-Komponenten (`pka:`) müssen davor ankommen, und das Gate muss Nicht-`crev:`-IDs durchlassen.
Wurzel Queue: `celeb_review_queue.celeb_id` ist `UNIQUE`, ohne `season_id`. `enqueueReview` setzt auf dem Celeb `exclude_from_auto = 1` und `wiki_confirmed = 0`. Ein 2027er-Finalize, das das auf einem bestätigten 2026er-Celeb ausführt, nimmt ihn aus `getAliveCelebsForAuto` und stoppt seinen Auto-Kill. `countPendingReviews()` zählt jede `pending`-Zeile. `go.js` bricht damit ab, sobald die aktive Saison nicht live ist. 2026 ist live, deshalb kehrt `/go` heute mit „Bereits live.“ zurück, bevor der Zähler läuft. `/ungo` setzt `live = 0` auf der aktiven Zeile und seedet den Wiki-Cache. Ein anschließendes `/go` sähe die 2027er-Queue und bliebe stehen. `countUnconfirmedSeasonCelebs` filtert schon `s.active = 1` und sieht 2027er-Picks deshalb nicht — der Pending-Zähler tut das nicht.
Vorlage für den Spieler-Select: `buildCandidateSelect` (max. 3, Value = Index), `proposeWikiForName` (EN, dann DE, höchstens 3 Personen, 350 ms Pause, EN-Sitelink wird kanonische URL).

**F11 · C · hoch**
Punkte, Alter und Auto-Match hängen an einer globalen Celeb-Zeile. Ein Finalize „wie Import, nur mit `season_id = 2027`“ schreibt die 2026er-Wertung um.
Wurzel: `celebs` ist nicht pro Saison. `age_at_pick` liegt auf dem Celeb. `applyDeath` vergibt `scoreForAge(celeb.age_at_pick)` an die Gewinner der **aktiven** Saison (`getWinnersForCeleb(celebId, getActiveSeason().id)`). `findOrCreateCeleb` legt neue Zeilen mit `wiki_confirmed = 0`, `exclude_from_auto = 1` an und füllt `age_at_pick` per `COALESCE`, wenn es noch leer ist. Bestätigte Namensvetter werden nicht wiederverwendet (Homonym), dieselbe QID schon: `idx_celebs_wikidata_id` und `idx_celebs_wiki_url_norm` sind global eindeutig. `applyWikiConfirm` setzt `exclude_from_auto = 0` und `age_at_pick = COALESCE(neuesAlter, age_at_pick)`. Ein 2027er-Alter (Stichtag `2027-01-01`, ein Jahr mehr) darf das 2026er-`age_at_pick` nicht ersetzen, sonst ändert sich jeder noch offene 2026er-Kill um einen Punkt (`100 − Alter`).
`death_awards` hat `UNIQUE(celeb_id, player_id)` und keine `season_id`. Dieselbe Person, die 2026 schon Punkte brachte und 2027 wieder getippt wird, bekäme 2027 keine zweite Gutschrift: `applyDeath` überspringt ein vorhandenes Award. `players.base_points` ist ein Zähler für alle Jahre. `clearSeasonForNewYear` nullt ihn.
`getAliveCelebsForAuto` liefert jeden bestätigten lebenden Celeb, nicht nur Picks der aktiven Saison. Ein im November bestätigter 2027-only-Celeb mit `exclude_from_auto = 0` liefe in den 2026er-Deathpool mit.
Der Assistent benutzt `proposeWikiForName` → bei bekanntem QID/`wikiNorm` die bestehende Zeile wiederverwenden, ohne Flags und ohne `age_at_pick` zu schreiben → sonst `findOrCreateCeleb` → `enqueueReview` nur für diese neue Zeile, mit `season_id` der announced-Saison. Das 2027er-Alter liegt auf `picks.age_at_pick`.

**F12 · C · mittel**
Slash-Infrastruktur kann einen Kanal noch nicht ausdrücken, und die Interaction-Hülle kennt keine Kanal-Mentions. `slash.js` `TYPE_MAP` hat String, Integer, User, Boolean, Attachment. `fromInteraction` reicht `getUser` / `getMember` / `getAttachment` durch, nicht `getChannel`. Für `/announce-season` nötig. Der PM-Flow selbst nimmt Namen als Nachrichten.

### D — Logkanal

**F13 · D · hoch (Lücke)**
Es gibt keinen Logkanal. `loadConfig` kennt `CHANNEL_DEATHPOOL` (Pflicht), `CHANNEL_ALL_DEATHS`, `CHANNEL_ADMIN`. Fehler landen in `console.error` und `ops.noteError` (`src/ops/status.js`, Ringpuffer 40, nur `/status`). `sendAdmin` ist der einzige Kanal-Helfer. `runWikiPollUnlocked` loggt jeden Lauf (`[poll] mode=`, Zähler `new EN=` / `DE-only=`) auf stdout. Diese Zeilen bleiben auf stdout. M1 stellt den Kanal. M4 und M5 hängen die Ereignisse „Saison 2027 eröffnet“, „Embed erneut gepostet“, „Tipp eingegangen (2027)“, „Draft finalisiert (2027)“, „Saisonwechsel 2026 → 2027“ an denselben Helfer. `kind: "scan"` bleibt verworfen.

### E — Zwei Saisons auf globalen Tabellen

**F14 · E · hoch**
Fünf Tabellen sind saisonblind und machen die Parallelphase gefährlich, auch wenn `picks.season_id` schon existiert:

| Tabelle / Zähler | Heute | Folge, wenn 2027 wie ein Import schreibt |
|------------------|--------|------------------------------------------|
| `seasons.active` | genau eine Zeile, Scoring und `isLive()` | Eine zweite `active = 1`-Zeile lässt `LIMIT 1` ohne Ordnung die falsche Saison ziehen. |
| `celebs` | eine Zeile pro Person, QID eindeutig | Zweite Zeile zur selben QID scheitert. `enqueueReview` entvalidiert die 2026er-Zeile. |
| `celebs.age_at_pick` | Alter der laufenden Wertung | Überschreiben mit Stand 2027-01-01 ändert 2026er-Punkte. |
| `death_awards` | eindeutig pro Celeb und Spieler, keine Saison | 2027 vergibt demselben Spieler nichts mehr. |
| `players.base_points`, `player_bonuses` | ein Kontostand | `clearSeasonForNewYear` nullt ihn bei der Eröffnung. `/scores` liest ihn plus Picks mit `s.active = 1`. |

`applyDeath`, `listScores`, `getPlayerPicks`, `unlinkPlayer`, `invalidateCeleb` (Pick-Löschung), `import`, `/kill`, `/season`, `/go`, `/ungo` und der Poller rufen `getActiveSeason()` bzw. `isLive()` auf. In der Parallelphase müssen sie das weiter tun. Der Assistent, `canParticipate` und `finalizeDraft` rufen `getAnnouncedSeason()` auf. Die beiden Zeiger werden nicht in einer Funktion zusammengelegt.

---

## 2. Implementierungsplan

Harte Reihenfolge für die Anmeldung: **M1 → M3 → M4 → M5**. **M2** danach (Abhängigkeit nur M1).

Schreibziel, das M3 bis M5 gemeinsam halten:

| Pfad | Saison | Funktion |
|------|--------|----------|
| Kills, Punkte, Retract, Tagesbericht, All-Deaths, `/scores`, `/liste`, `/kill`, `/import`, `tryConsumePaste` | 2026, solange sie `active = 1` ist | `getActiveSeason()` |
| DM-Tipps, `/picks`, Draft, Finalize, Membership, Embed | 2027 | `getAnnouncedSeason()` |
| `/go`-Blocker | offene Reviews der aktiven Saison plus `season_id IS NULL` | `countPendingReviews({ blockingLive: true })` |
| `/review` ohne Argument, sobald eine announced-Zeile existiert | 2027er-Queue | `nextPendingReview(announced.id)` |
| Wechsel am 2027-01-01 | 2026 → `archived`, 2027 → `running` + `live = 1` | `archiveRunningSeason` dann `activateAnnouncedSeason` |

`clearSeasonForNewYear` wird von keinem dieser Pfade aufgerufen.

### M1 — Logkanal (Arbeitspaket D)

Abhängigkeit: keine. Inhalt wie v1. Die Scan-Log-Regel bleibt: kein Import von `log.js` aus `src/jobs/wiki-poll.js`, `src/wiki/scraper-en.js`, `src/wiki/scraper-de.js`, `announceAllDeath`, `announceDailySummary`, `scrapeLangRetry`. Die eine erlaubte Ausnahme bleibt die Unterdrückungszeile in M2. Der Deathpool-`catch` aus Frage 10 (entschieden: ja) hängt in M2 an genau einer Stelle, nicht in M1.

**Dateien**

- Neu: `src/discord/log.js`
  - `logEvent(client, config, { kind, summary, userId, detail })`
  - `logError(client, config, err, { where, userId })`
  - `scrub(text)` — entfernt `config.token`, `process.env.TOKEN`, und jeden String, der wie ein Discord-Bot-Token aussieht.
- `src/config.js`: `channelLog: optional("CHANNEL_LOG", "")`.
- `docker-compose.yml`: `CHANNEL_LOG: ""` mit Kommentarzeile, analog `CHANNEL_ADMIN`.
- `README.md`: Tabellenzeile bei „Useful settings“. Kanal ergänzt `CHANNEL_ADMIN`, ersetzt ihn nicht.
- Aufrufe, gezielt:
  - `src/index.js`: die bestehenden `catch` von Interaction, Review-URL, Import-Paste, Prefix-Command → `logError`. Kein Log bei erfolgreichem `/help`, `/scores`, `/liste`, `/celebs`, `/players`, `/status`.
  - `src/discord/commands/import.js` `finalize` und `run`: eine Zeile pro abgeschlossener Import (Admin-ID, Ziel-User-ID, Anzahl Picks, Fehlerzahl, `season_id` der aktiven Saison). Chunk-Zwischenmeldungen nicht.
  - `src/discord/commands/new-year.js`: eine Zeile, wenn der Wipe-Zweig tatsächlich durchläuft (alte Saison, neue ID, Startdatum, Backup-Name). M5 lässt diesen Zweig bei laufender 2026er-Saison verweigern; die Zeile bleibt im Zweig, der löscht. Eröffnung und Wechsel loggen in M5 eigene Ereignisse über dasselbe `logEvent`.
  - `src/backup/index.js` `startAutoBackup`: Erfolg als eine Zeile (Dateiname), Fehler via `logError`. Der 02:00-Lauf ist kein Wiki-Scan.
  - `src/discord/celeb-review.js` `applyWikiConfirm`-Pfad (`confirm` / Kandidatenwahl): eine Zeile „Wiki bestätigt / Kandidat gewählt“ mit Celeb-ID und `season_id` der Queue-Zeile, nicht der ganze Embed.
- Ausdrücklich keine Aufrufe aus den in der Scan-Regel genannten Dateien. Auch nicht aus `ops.noteError` pauschal: der Poller schreibt dort Scan-Fehler (`poller: …`, „category check failed“).

Ereignisse, die M1 noch nicht verdrahtet, weil es die Befehle noch nicht gibt, und die M4/M5 mit demselben Modul schreiben: `kind: "season-announce"` (2027 eröffnet, Kanal-ID, Jahr), `kind: "season-repost"`, `kind: "pick"` (Tipp hinzugefügt / entfernt / geändert / Kandidat gewählt / finalisiert, User-ID, announced `season_id`), `kind: "season-switch"` (2026 archiviert, 2027 live, Backup-Name). `log.js` filtert diese Kinds nicht. `kind: "scan"` wird verworfen und erzeugt keinen Send.

**Verhalten**

- `CHANNEL_LOG` leer oder `fetch` schlägt fehl: `console.warn` einmal pro Fehlerart, Funktion kehrt zurück, der Aufrufer läuft weiter. Dieselbe Haltung wie `sendAdmin`, plus eine In-Memory-Queue (ein Consumer, Abstand ≥ 1 s).
- Inhalt: Zeit, `kind`, Discord-User-ID wenn vorhanden, Kurztext, bei Fehlern `err.message` und die ersten ~1500 Zeichen `stack`. HTTP-Status, wenn der Fehler ihn trägt (`err.response?.status`). Keine Request-Header.
- Nachrichtenlänge unter 1900. Längere Stacks abschneiden, nicht splitten.
- Entschieden (Frage 3): mutierende Aktionen und Fehler. Lese-Befehle nicht.

**Tests:** `test/log.test.js` (von `test/run.js` automatisch mitgenommen).

- `scrub` entfernt ein eingesetztes Token aus Message und Stack.
- Ein Event mit `kind: "scan"` wird verworfen und erzeugt keinen Send.
- Fehlender Kanal: `logError` resolved, wirft nicht.
- Queue: zwei schnelle Events ergeben zwei Sends, der zweite erst nach dem Abstand (Fake-Channel, Fake-Timer).

### M2 — Dedup und Linkqualität (Arbeitspaket A)

Abhängigkeit: M1. Liegt in der Lieferreihenfolge hinter M5, fachlich unabhängig von M3. `logEvent` nur für die Unterdrückungszeile (eine pro unterdrückter Karte: Gewinner-ID, Verlierer-ID, Grund `qid` | `sitelink` | `nonperson-name`). Keine Zeile für „gescraped N“. Der All-Deaths-Feed bleibt saisonlos: keine `season_id` an `wiki_seen` oder `announced_deaths`, kein Filter auf die announced-Saison. Deathpool-Hits laufen weiter über `getActiveSeason()` und `isLive()` (2026).

Zusätzlich, entschieden in Frage 10: der `catch` in `runWikiPollInner` um den konkreten Deathpool-Treffer (`[poll] deathpool` / `ops.noteError`) ruft `logError` mit Celeb-Namen und `err.message`. Scraping, Retry, „0 Einträge“, `new EN=`-Zähler, `mode=`-Zeilen und All-Deaths-Sends bleiben ohne `log.js`.

Neues reines Modul `src/wiki/announce-dedup.js`, Funktion `planAnnouncements(entries, history)`:

- Eingabe pro Entry, schon aufgelöst (Auflösung bleibt in `wiki-poll.js`): `{ id, lang, url, text, redName, listUrl, resolved: { qid, isHuman, canonicalUrl, enSitelink, error } }`.
- `history`: `{ qids: Set, recentHumanNames: Set }` aus den letzten 14 Tagen `announced_deaths` (Fenster = zwei `deathConfirmDays`, fest im Aufrufer).
- Ausgabe: `{ post: Entry[], bind: [{ loserId, winnerId, reason }], defer: Entry[] }`.
  - `post` geht an `announceAllDeath`.
  - `bind`: Verlierer-ID erst `markWikiAnnounced`, wenn der Gewinner `announced_at` hat. Dasselbe Muster wie das heutige `deferredDeEn`.
  - `defer`: Auflösungs-HTTP-Fehler. Nicht posten, nicht stempeln.

Regeln, in dieser Reihenfolge, alle deterministisch:

1. `resolved.error` → `defer`. Ein Fehler ist kein „kein EN“.
2. Menschen (`isHuman === true`) mit demselben `qid`: eine Karte. Gewinner: `lang === "en"` vor `de`, direkte Personenseite vor `redName`, schon in diesem Poll gescrabte EN-Zeile vor einer nur gebrückten. Verlierer nach `bind`. QID, das schon in `history.qids` liegt: nichts posten, Verlierer stempeln (Gewinner ist historisch schon `announced_at`).
3. Zwei Menschen mit verschiedenem oder fehlendem QID bleiben beide, auch bei ähnlichem Namen. Das schützt Josef Mašín / Josef Mašín jun. und echte Namensvetter.
4. Nicht-Mensch (`isHuman === false`) oder `redName && isHuman !== true`: posten nur, wenn `normalizeName(personNameFromText(text))` keinem Menschen aus diesem Batch und keinem `history.recentHumanNames` entspricht. Sonst `bind` an diese Menschen-Karte (Grund `nonperson-name`). Gleichheit nach der bestehenden `normalizeName` plus abgeschnittenem Suffix `\s*\[[a-z]{2,3}\]$`. Kein Edit-Abstand, keine Transliterations-Tabelle. Eine Nicht-Mensch-Karte ohne Namens-Gegenstück wird gepostet (Guruvayur Dorai, Hans Rot), mit `linkMode: "list"`.
5. DE-Zeile, deren `enSitelink` auf eine EN-ID in diesem Batch oder auf eine schon gestempelte EN-ID zeigt: `bind` an diese EN-Karte, auch wenn QID fehlt. DE-only ist der Rest: Auflösung ok, kein EN-Sitelink, kein gemeinsames Menschen-QID, kein `bind` aus Regel 4.

DE-only bleibt erlaubt und ist der Normalfall für Personen ohne `enwiki`. EN-first bleibt der Normalfall, sobald ein Sitelink oder ein QID existiert.

**Konkrete Änderungen**

- `src/db/schema.js` `migrate`: `ALTER TABLE wiki_seen ADD COLUMN qid TEXT`, dasselbe für `announced_deaths`. Nullable, kein Rebuild, kein Update-Lauf über die bestehenden Zeilen. Diese Spalten sind von den Saison-Spalten in M3 unabhängig; wer M2 vor M3 migriert, lässt `migrate` beide Blöcke additiv ausführen. Reihenfolge der `ADD COLUMN` inside `migrate` ist egal, solange jeder Block `PRAGMA table_info` prüft.
- `src/db/index.js` `markWikiAnnounced(entryId, at, qid)`: optionales `qid`. Vorhandenes `announced_at` wird nicht überschrieben (`ANNOUNCED_EPOCH` inklusive). INSERT in `announced_deaths` schreibt `qid` mit. Neu: `recentAnnouncedIdentities(sinceIso)` → `{ qids, humanNames }`. Kein Mass-Backfill.
- `src/wiki/death-brief.js`
  - `personNameFromText`: trailing ` [xx]` abschneiden, bevor der Name in Titel und Dedup-Key geht.
  - Return von `fetchDeathBrief` um `qid` und `pageMissing` ergänzen. `page.missing` setzt `pageMissing: true` und fällt nicht mit dem Netzfehler-Fallback zusammen (`pageMissing: false`).
  - `redName && isHuman !== true`: `url` bleibt die Research-URL (Bild, bestehender Test). `linkMode` entscheidet `announceAllDeath`.
- `src/discord/announce.js` `announceAllDeath`: Feld „Link“ ist `[Wikipedia](personenUrl)` nur bei `isHuman === true` oder bei einer aufgelösten Personen-URL ohne `pageMissing`. Bei `linkMode: "list"` oder `pageMissing`: Link auf `entry.listUrl`, und wenn die fehlt, der Text „Kein eigener Wikipedia-Artikel“. Band- und Organisations-URLs stehen in diesem Feld nicht. Bild darf von der Research-Seite kommen.
- `src/wiki/scraper-de.js` / `src/wiki/scraper-en.js`: beim Scrapen `listUrl` an jeden Entry hängen. `extractFromTables` selbst unverändert (Test Perkussionist / SPD / Schauspieler bleibt grün).
- `src/wiki/scraper-en.js`: `isRedLink` aus `scraper-de.js` exportieren und in `extractEntriesFromHtml` benutzen. Rotlink als erster Anker setzt `redName: true`, die Entry-ID bleibt `en:${wikiPath}`. Keine neue ID-Form `en:red:…`.
- `src/jobs/wiki-poll.js` `runWikiPollInner`, nur Modus `live` und `nightly` mit `channelAllDeaths`:
  - DE-Brücke: `resolveEnglish` ersetzen durch `resolveEnglishArticle(userAgent, germanUrl)` in `src/wiki/page-lookup.js`. MediaWiki `prop=langlinks&lllang=en` mit `redirects=1`, bei HTTP/Netz werfen, bei geladener Seite ohne `en`-Link `null`. `resolveSisterUrl` nicht aufrufen.
  - Nach `uniqueNewEn` und `newDeOnly`: `fetchDeathBrief` einmal pro Kandidat, Ergebnis am Entry ablegen. `announceAllDeath` bekommt ein optionales `brief`; ohne `brief` bleibt der heutige Fetch (`/simulate` bleibt).
  - `planAnnouncements`, dann die bisherige Send-Schleife nur über `post`. `bind` wie `deferredDeEn` nachziehen. `defer` nur stdout, nicht in den Logkanal.
  - Seed- und Reconcile-Zweig bleiben ID-basiert und posten nicht.
- `personNameFromText` gilt auch für `announceDailySummary`. Eine zweite Digest-Dedup nach QID entfällt, sobald die zweite Zeile nicht in `announced_deaths` steht.

M2 löscht keine Discord-Nachrichten, macht keinen Fuzzy-Merge, ruft `mergeCelebs` nicht auf und räumt den Reconcile-Bestand nicht auf. Frage 4 ist entschieden: nur künftige Karten.

**Tests:**

- Neu `test/announce-dedup.test.js`, Fixtures ohne Netz:
  - Young L: Mensch `en:Young_L` plus `de:red:Young L` auf `The_Pack_(Band)` (`isHuman: false`) plus `en:The_Pack_(group)` (`isHuman: false`). Eine Post-Karte, beide Pack-IDs in `bind`.
  - Dieselbe QID auf `de:` und `en:` (Åström, Yamazaki, Briukhovetskyi): nur EN in `post`.
  - DE ohne Sitelink und ohne QID-Kollision: DE in `post`.
  - `resolved.error` auf einer DE-Zeile: `defer`, nicht `post`.
  - Zwei Menschen, verschiedene QID, ähnlicher Name („Josef Mašín“ / „Josef Mašín jun.“): beide in `post`.
  - Rotlink-Person ohne Gegenstück: in `post` mit `linkMode: "list"`.
  - Historische QID schon in `history.qids`: nichts in `post`, Verlierer stempelfähig.
- `test/wiki-fixes.test.js`: `extractFromTables` bleibt. Rotlink-Brief: `b.url` darf die Research-URL bleiben; `pageMissing` bzw. `qid` asserten. `announce redName card`: Link-Feld enthält `Die_Ärzte` nicht, wenn `listUrl` gesetzt ist; Titel, Beruf und Thumbnail bleiben. EN-`<li>` mit Rotlink-Klasse wird `redName: true`, ID weiter `en:/wiki/…`.
- `markWikiAnnounced` zweimal aufgerufen lässt `announced_at` stehen und schreibt `qid` beim ersten Mal.

### M3 — Zwei Saison-Zeilen, Drafts, Queue, Award-Saison

Abhängigkeit: keine zu M2. Liegt vor M4/M5. Alles additiv über `migrate` (`PRAGMA table_info`, `ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`). Kein Rebuild von `celebs`. Kein `UPDATE` über `announced_deaths`. Die wenigen `UPDATE`s unten betreffen `seasons` (eine Handvoll Zeilen, nur wo `phase IS NULL` direkt nach dem `ADD COLUMN`) und `death_awards.season_id` (Bestandszeilen auf die damals aktive Saison setzen, einmalig).

**`src/db/schema.js` `migrate`**

`seasons`:

- `announce_channel_id TEXT`
- `announce_note TEXT`
- `phase TEXT` — Werte, die der Code schreibt: `setup`, `announced`, `running`, `archived`. Spalte nullable anlegen, dann einmalig, nur in dem Lauf, der die Spalte hinzufügt:

```sql
UPDATE seasons SET phase = 'running'  WHERE phase IS NULL AND active = 1 AND live = 1;
UPDATE seasons SET phase = 'setup'    WHERE phase IS NULL AND active = 1 AND live = 0;
UPDATE seasons SET phase = 'archived' WHERE phase IS NULL AND active = 0;
```

Die Live-Zeile 2026 wird damit `running`. Ein zweiter Prozessstart schreibt `phase` nicht erneut. `ensureActiveSeason` schreibt bei einem Insert `phase = 'setup'` mit (heute wäre die neue Zeile ohne Phase).

`pick_drafts`:

- `id INTEGER PRIMARY KEY`
- `player_id INTEGER NOT NULL` → `players(id)`
- `season_id INTEGER NOT NULL` → `seasons(id)`
- `status TEXT NOT NULL` — `draft` oder `finalized`
- `updated_at TEXT NOT NULL`
- `UNIQUE(player_id, season_id)`

`pick_draft_entries`:

- `id`, `draft_id` → `pick_drafts(id) ON DELETE CASCADE`, `position INTEGER`, `raw_name TEXT`, `wiki_url TEXT`, `wiki_norm TEXT`, `qid TEXT`, `proposed_age INTEGER`, `candidates_json TEXT`, `link_status TEXT` (`pending` | `linked` | `ambiguous` | `unlinked`)
- Kein FK auf `celebs`. Ein späteres Löschen von Celebs (Notfall-Wipe, Abschnitt M5) macht die Draft-Zeilen nicht ungültig per FK.

`celeb_review_queue`:

- `season_id INTEGER NULL`. Bestehende Zeilen bleiben `NULL` (Vermerk: legacy / 2026er-Pool). Kein Backfill auf eine Saison-ID.
- `celeb_id UNIQUE` bleibt. Eine Person hat weiter höchstens eine Queue-Zeile. Zwei Saisons teilen sich deshalb keine zweite Karte derselben `celeb_id`; der Assistent stellt bestätigte 2026er-Celebs gar nicht erst ein (M4).
- Index `idx_review_season_status` auf `(season_id, status)`.

`picks`:

- `age_at_pick INTEGER NULL`. Alle heutigen Zeilen bleiben `NULL` und bedeuten „Alter steht auf `celebs.age_at_pick`“. 2027er-Finalize schreibt hier das Alter zum `2027-01-01`.

`death_awards`:

- `season_id INTEGER NULL`.
- Einmalig, im selben Migrate-Lauf wie das `ADD COLUMN`: `UPDATE death_awards SET season_id = (SELECT id FROM seasons WHERE active = 1 LIMIT 1) WHERE season_id IS NULL`. Das sind die 2026er-Gutschriften.
- Danach `DROP INDEX IF EXISTS idx_death_awards_celeb_player` und `CREATE UNIQUE INDEX idx_death_awards_celeb_player_season ON death_awards(celeb_id, player_id, season_id)`. SQLite behandelt `NULL` in Unique-Indizes als verschieden; deshalb schreibt `applyDeath` ab diesem Release immer die aktive `season_id` mit. Der Indexwechsel und die Code-Änderung liegen in demselben Deploy.

`season_point_snapshots` (leer bis zum Wechsel, angelegt schon in M3):

- `season_id`, `player_id`, `base_points INTEGER`, `bonus_points INTEGER`, `total INTEGER`, `snapshotted_at TEXT`
- `PRIMARY KEY (season_id, player_id)`
- FKs auf `seasons(id)` und `players(id)`

**`src/db/index.js` — Saison-API**

`getActiveSeason()` — SQL-Prädikat bleibt:

```sql
SELECT * FROM seasons WHERE active = 1 LIMIT 1
```

Rückgabe ist die volle Zeile, damit ab M3 auch `phase`, `announce_channel_id`, `announce_note`. Fehlt die Zeile, legt `ensureActiveSeason` eine an (`active = 1`, `live = 0`, `phase = 'setup'`, Start 1. Januar des laufenden Kalenderjahres) und die Funktion liefert diese Zeile. Die Funktion sucht nicht nach `phase = 'announced'` und nicht nach `live = 1`. Aufrufer von Scoring, Kills, Import, `/scores`, Poller-`seasonStartDate` und `isLive()` bleiben auf dieser Funktion. Invariante, die `openAnnouncedSeason` und `activateAnnouncedSeason` halten: genau eine Zeile mit `active = 1`.

`getAnnouncedSeason()`:

```sql
SELECT * FROM seasons
WHERE phase = 'announced'
ORDER BY year DESC, id DESC
LIMIT 1
```

Rückgabe: die Zeile oder `null`. Legt nichts an. `active` dieser Zeile ist 0, `live` ist 0.

`openAnnouncedSeason({ year, startDate, channelId, note })`:

- `year` Zahl (Aufrufer übergibt 2027). `startDate` Default `` `${year}-01-01` ``. `channelId` Pflicht (Discord-Snowflake als Text). `note` Text oder `null`.
- Transaktion.
- Liegt schon eine Zeile `phase = 'announced'` mit diesem `year`: `UPDATE` von `announce_channel_id`, `announce_note`, `start_date`. `active` und `live` bleiben 0. Rückgabe `{ season, created: false }`.
- Liegt eine announced-Zeile mit anderem Jahr: werfen. Es gibt höchstens eine announced-Saison.
- Liegt eine Zeile desselben Jahres mit `phase IN ('running','setup','archived')`: werfen. 2026 wird so nicht ein zweites Mal angelegt, und eine archivierte 2027 nicht still wiedereröffnet.
- Sonst `INSERT INTO seasons (year, active, start_date, live, phase, announce_channel_id, announce_note) VALUES (?, 0, ?, 0, 'announced', ?, ?)`.
- Die running-Zeile wird nicht gelesen, um sie zu ändern. Nach dem Commit sind ihre `id`, `active`, `live`, `phase`, `start_date` und die Zähler `COUNT(*)` von `celebs`, `picks`, `death_awards` sowie `players.base_points` gleich geblieben. Drafts jeder anderen `season_id` werden nicht gelöscht und nicht geupdatet.
- Rückgabe `{ season, created: true }`.
- Diese Funktion ruft `clearSeasonForNewYear` nicht auf und setzt `base_points` nicht an.

`archiveRunningSeason(seasonId)`:

```sql
UPDATE seasons
SET active = 0, live = 0, phase = 'archived'
WHERE id = ? AND active = 1 AND phase = 'running'
```

`changes !== 1` → werfen, damit der Aufrufer die Transaktion abbricht. Rückgabe: die Zeile nach dem Update. Die Funktion löscht keine Picks, Celebs, Awards, Boni, Drafts, `wiki_seen` oder `announced_deaths`. Drafts, deren `season_id` die laufende Saison ist, bleiben an der nun archivierten Zeile hängen. M4 legt solche Drafts nicht an.

`activateAnnouncedSeason()` — nur der Wechsel, nur aus dem M5-Befehl, nach `createPackage`:

- Transaktion.
- `announced = getAnnouncedSeason()`, fehlt → werfen. `running = getActiveSeason()`, fehlt → werfen. Gleiche `id` → werfen. `running.phase !== 'running'` → werfen.
- Snapshot (Default Frage 13): pro Spieler eine Zeile in `season_point_snapshots` für `running.id` (`base_points`, Summe der Boni, `playerTotal`).
- `archiveRunningSeason(running.id)`.
- ```sql
  UPDATE seasons
  SET active = 1, live = 1, phase = 'running'
  WHERE id = ? AND phase = 'announced' AND active = 0 AND live = 0
  ```
  `changes !== 1` → werfen, Rollback inklusive Archivierung.
- 2027-only-Celebs für den Auto-Match freigeben (Default Frage 18):

```sql
UPDATE celebs
SET exclude_from_auto = 0
WHERE wiki_confirmed = 1
  AND manual_only = 0
  AND exclude_from_auto = 1
  AND id IN (SELECT celeb_id FROM picks WHERE season_id = :announced)
  AND id NOT IN (SELECT celeb_id FROM picks WHERE season_id = :archivedRunning)
```

Celebs, die in beiden Saisons einen Pick haben, behalten ihr 2026er-`exclude_from_auto`. Manuell ausgeschlossene bleiben ausgeschlossen.

- Danach `UPDATE players SET base_points = 0` und `DELETE FROM player_bonuses`. `death_awards`, `picks`, `celebs`, `pick_drafts` bleiben. Der 2026er-Kontostand steht im Snapshot und ist aus `death_awards` mit der archivierten `season_id` rekonstruierbar.
- Rückgabe `{ archived, activated }`.
- Kein `setSeasonLive` (das träfe die noch aktive Zeile). Kein Seed, kein `DELETE`.

`setSeasonAnnounce(seasonId, { channelId, note })` schreibt Kanal und Notiz auf der genannten Zeile. M5 benutzt das beim Repost, wenn ein neuer Kanal mitgegeben wird. Die running-Zeile ist kein gültiges Ziel: `phase` muss `announced` sein, sonst werfen.

`clearSeasonForNewYear` bleibt als Funktion im Modul, damit ein Notfall-Wipe sie noch erreichen kann, wird aber von `openAnnouncedSeason`, `archiveRunningSeason` und `activateAnnouncedSeason` nicht aufgerufen. M5 verweigert den Wipe-Befehl, solange eine running- oder announced-Zeile existiert. Ein Kommentar direkt über der Funktion sagt das.

Weitere Funktionen, gleiche Datei:

- `getOrCreateDraft(playerId, seasonId)` — nur wenn die übergebene Saison `phase = 'announced'` und `live = 0` hat, und nur solange `status = 'draft'` fehlt oder genau so ist. Eine `finalized`-Zeile wird nicht wieder geöffnet (Frage 1, entschieden, bezogen auf die announced-Saison). Aufruf mit der running-`season_id` wirft.
- `addDraftNames(draftId, names[])`, `removeDraftEntry(entryId)`, `replaceDraftEntryName(entryId, rawName)`, `listDraftEntries(draftId)`.
- `finalizeDraft(playerId, seasonId)` — Transaktion. `seasonId` muss die announced-Saison sein (`phase = 'announced'`, `live = 0`), sonst werfen. `clearPicksForPlayer(playerId, seasonId)` löscht nur Picks dieser `season_id`. Picks der running-Saison desselben Spielers bleiben. Pro Entry mit `linked` oder `unlinked`: `linkCelebForAnnouncedSeason` (unten), dann `setPick(playerId, celeb.id, seasonId)`. `picks.age_at_pick` wird auf `proposed_age` gesetzt (Alter zum `start_date` der announced-Saison, auch `null`). QID- oder `wiki_norm`-Treffer auf eine **andere** noch nicht bestätigte Zeile: `mergeCelebs` wie in `queueCelebsForReview`, danach `setPick` auf die kanonische ID. Treffer auf eine bereits `wiki_confirmed = 1`-Zeile: diese ID benutzen, nicht mergen, nicht enqueuen. Rückgabe `{ reviewIds, added }`. `reviewIds` enthält nur Celebs, die danach noch `wiki_confirmed = 0` sind und keinen Pick in der running-Saison haben. Status des Drafts `finalized`. Ein Entry `ambiguous` oder `pending`: die Funktion wirft bzw. gibt `{ blocked: true }` und schreibt keine Picks. Zweiter Aufruf bei `finalized`: `{ locked: true }`, keine neuen Picks.
- `linkCelebForAnnouncedSeason({ name, age, qid, wikiNorm })`:
  1. `qid` und `findCelebByWikidataId` → `{ celeb, reuse: true }`. Kein `UPDATE` auf `age_at_pick`, `is_alive`, `wiki_confirmed`, `exclude_from_auto`, `death_*`.
  2. Sonst `wikiNorm` und `findCelebByWikiNorm` → dasselbe.
  3. Sonst `findOrCreateCeleb({ name, age })`. Hat die zurückgegebene Zeile `wiki_confirmed = 1` oder einen Pick mit `seasons.phase = 'running'`: ebenfalls `{ reuse: true }` und die gerade gesetzten Felder sind durch `COALESCE` nur gefüllt worden, wenn sie leer waren. War `age_at_pick` schon gesetzt, bleibt es. Zusätzlich: wenn Schritt 3 eine **neue** Zeile angelegt hat, ist `age_at_pick` das 2027er-Alter; das ist tragbar, weil diese Zeile keinen 2026er-Pick hat und `applyDeath` bis zum Wechsel nur running-Gewinner zahlt. Trotzdem schreibt Finalize das maßgebliche Alter immer nach `picks.age_at_pick`.
- `enqueueReview(celebId, proposal, { seasonId })`:
  - Vor dem `INSERT`: wenn der Celeb `wiki_confirmed = 1` ist oder einen Pick in `phase = 'running'` hat, return `{ queued: false, reason: "running-celeb" }` und kein `UPDATE` der Flags.
  - `INSERT` schreibt `season_id`. `ON CONFLICT(celeb_id)` aktualisiert Vorschlag und `status = 'pending'` nur in zwei Fällen: die vorhandene `season_id` ist gleich `excluded.season_id`, oder sie ist `NULL` und `excluded.season_id` ist die `active = 1`-Zeile. Sonst return `{ queued: false, reason: "other-season" }`, Flags bleiben. Eine announced-`season_id` übernimmt damit weder eine `NULL`-Zeile noch eine running-Zeile.
  - Das Flag-`UPDATE` (`exclude_from_auto = 1`, `wiki_confirmed = 0`) läuft nur, wenn wirklich neu eingereiht oder im erlaubten Konfliktfall aktualisiert wurde und der Running-Celeb-Check nicht gegriffen hat.
  - Import (M4-Aufrufer, weiter die aktive Saison) übergibt `seasonId` der aktiven Zeile. Altzeilen mit `NULL` bleiben `NULL`, bis ein solcher 2026er-Re-Enqueue sie auf die aktive ID setzt.
- `countPendingReviews({ seasonId, blockingLive } = {})`:
  - `{ seasonId }`: `WHERE status = 'pending' AND season_id = ?`.
  - `{ blockingLive: true }`: `WHERE status = 'pending' AND (season_id IS NULL OR season_id = (SELECT id FROM seasons WHERE active = 1))`. Die announced-ID fehlt in diesem Prädikat. Das ist der Zähler für `go.js`.
  - Ohne Argument: alle `pending` (nur noch für Diagnose). `/go` und `/status` benutzen ihn nicht mehr als einzigen Wert.
- `countUnconfirmedSeasonCelebs()` bleibt bei `s.active = 1`. 2027er-Picks (`active = 0`) zählen nicht mit und dürfen 2026 nicht blockieren. Die Funktion wird nicht auf die announced-Saison erweitert.
- `nextPendingReview(seasonId)`: dieselbe Celeb-Join wie heute, plus `AND q.season_id = ?`. `seasonId === null` liest die legacy-Zeilen (`season_id IS NULL`) zusammen mit der aktiven ID, für `/review scope:pool`.
- `applyDeath`: Gewinner wie heute über die aktive `season_id`. Pro Gewinner `age = pick.age_at_pick ?? celeb.age_at_pick`, `score = scoreForAge(age)`. Existenzprüfung und `INSERT` von `death_awards` enthalten `season_id` der aktiven Saison. Für alle heutigen 2026er-Picks ist `picks.age_at_pick` NULL, der Score bleibt `scoreForAge(celebs.age_at_pick)`. `isLive()`, der Deathpool-Kanal und der Tagesbericht lesen weiter die aktive Zeile.
- `applyWikiConfirm`: wenn die Queue-Zeile eine `season_id` mit `phase = 'announced'` hat, setzt das bestätigende Update `wiki_confirmed = 1` und lässt `exclude_from_auto = 1`. `age_at_pick` auf `celebs` wird in diesem Zweig nicht geschrieben (`age_at_pick = age_at_pick`). Das 2027er-Alter bleibt auf den Picks. Liegt die Queue-`season_id` auf der aktiven Saison oder ist sie `NULL`, bleibt das heutige Verhalten (`exclude_from_auto = 0`, Alter per `COALESCE`). Ein Confirm, der per QID in eine schon bestätigte Zeile mergt, läuft durch `mergeCelebs` und schreibt danach die Flags der kanonischen Zeile nicht auf unbestätigt zurück.

Keine Kopie der Live-DB. `wiki_seen` inhaltlich unverändert durch M3 (QID-Spalte ist M2).

**Tests:** `test/pick-draft.test.js` und `test/two-season.test.js`, Temp-SQLite über `openDb` wie `test/db-fixes.test.js`.

- Migration auf einer DB ohne die neuen Spalten lässt die Zeilenzahl von `celebs`, `picks`, `death_awards`, `announced_deaths` gleich. Die eine aktive Live-Zeile hat danach `phase = 'running'`.
- `openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "1", note: "n" })` bei vorhandener running-2026: `getActiveSeason().id` und `.live` unverändert, `getAnnouncedSeason().year === 2027`, `active === 0`, `live === 0`, `phase === "announced"`. Pick- und Celeb-Zähler gleich. `base_points` eines Spielers gleich.
- Zweiter Aufruf mit derselben Jahreszahl: `created: false`, keine dritte Zeile.
- Aufruf mit `year: 2026`, während 2026 `running` ist: Wurf, keine Änderung.
- Draft anlegen, Name dazu, Name weg, Name ändern, Reihenfolge. `getOrCreateDraft` mit der running-ID wirft.
- `finalizeDraft` schreibt `picks.season_id` der announced-Saison und `picks.age_at_pick`. Eine vorherige 2026er-Pickliste desselben Spielers hat dieselbe Zeilenzahl wie vorher.
- Finalize auf einen Namen, dessen QID schon ein bestätigter 2026er-Celeb ist: dieselbe `celeb_id`, `wiki_confirmed`, `exclude_from_auto`, `age_at_pick` und `is_alive` unverändert, keine neue Queue-Zeile.
- `enqueueReview` mit announced-`seasonId` auf diesen Celeb: `{ queued: false, reason: "running-celeb" }`, Flags unverändert.
- Queue-Zeile mit announced-`seasonId`: `countPendingReviews({ blockingLive: true })` zählt sie nicht. Eine `NULL`-Zeile zählt mit.
- `applyDeath` auf einen Celeb mit 2026er-Pick (`picks.age_at_pick` NULL) und 2027er-Pick (Alter gesetzt), aktive Saison 2026: nur der 2026er-Spieler bekommt Punkte, Score aus `celebs.age_at_pick`. Award-Zeile trägt die 2026er-`season_id`.
- Nach `archiveRunningSeason` + `activateAnnouncedSeason`: 2026 `phase = archived`, `active = 0`, `live = 0`; 2027 `active = 1`, `live = 1`, `phase = running`; Picks beider Saisons noch da; `death_awards`-Zeilenzahl gleich; Snapshot enthält den alten `base_points`; `players.base_points` ist 0. Drafts der announced-Saison noch da.
- Zweiter `finalizeDraft` auf `finalized`: `{ locked: true }`.
- Zwei Entries mit demselben `wiki_norm` werden ein Pick.

### M4 — Tipp-Assistent (Arbeitspaket C)

Abhängigkeit: M1, M3. Zielsaison ist immer `getAnnouncedSeason()`. Die running-Saison wird von diesem Paket nicht beschrieben: keine Picks, keine `age_at_pick` auf bestehenden Celebs, keine `base_points`, kein `live`-Flag.

**Neue Dateien**

- `src/discord/pick-parse.js` — `parsePickList(text) → { names: string[], error?: string }`
  - Zeilenumbruch trennt immer.
  - Innerhalb einer Zeile: `;`, ` – `, ` — `, ` - ` (Bindestrich nur mit Leerzeichen beiderseits).
  - `Jean-Luc` bleibt ein Name. `Müller, Hans` bleibt ein Name (Frage 6, entschieden).
  - Leere Tokens weg. Doppelte Namen in derselben Paste (nach `nameKey`) werden eine Zeile, der Spieler bekommt das in der Antwort gesagt.
- `src/discord/membership.js` — `canParticipate(client, config, userId) → { ok, reason }`
  - Saison = `getAnnouncedSeason()`. `null`, leere `announce_channel_id`, `phase !== "announced"` oder `live !== 0` → `{ ok: false, reason: "closed" }`. `getActiveSeason().live` geht in diese Funktion nicht ein. 2026 live lässt die Funktion weiter `ok` liefern, sobald 2027 announced ist und einen Kanal hat.
  - `client.channels.fetch(channelId)`. Kein Guild-Kanal → `reason: "channel"`.
  - `channel.guild.members.fetch(userId)`. 10007 oder `permissionsFor` ohne `ViewChannel` → `reason: "not-member"`. `permissionsFor` auf einem nicht gefetchten Member ist `null` und zählt als verpasster Fetch, deshalb zuerst `members.fetch`.
  - Admin (`config.adminId`) darf ohne `ViewChannel`, damit der Flow vor dem ersten fremden Teilnehmer prüfbar ist. Die announced-Saison muss trotzdem `live = 0` und einen Kanal haben.
- `src/discord/pick-assistant.js`
  - Zustand in `pick_drafts`. Neustart setzt dieselbe Liste fort. Keine Prozess-`Map` für die Namen.
  - `tryConsumePickMessage(ctx, msg)`: nur DMs (`msg.guildId` leer). `canParticipate` mit `reason: "closed"` → `false` (andere Guild-Nachrichten und DMs außerhalb der Anmeldung bleiben liegen). `not-member` → eine DM mit dem Satz, dass die Runde am Announce-Kanal hängt, `logEvent`, kein Draft, kein Wiki-Call (Frage 5, entschieden).
  - `getOrCreateDraft(player.id, announced.id)`.
  - `proposeWikiForName(config.userAgent, name, announced.start_date, null)` nacheinander. Für 2027 ist `start_date` `2027-01-01`. Kein `Promise.all`. Die 350 ms in `proposeWikiForName` bleiben.
  - 0 Kandidaten: `unlinked`. 1 Kandidat: `linked`, URL/QID/`proposedAge` speichern. 2+ verschiedene QID: `ambiguous`, `candidates_json`, eine Nachricht, ein `StringSelect` wie `buildCandidateSelect`, Custom-ID `pka:pick:<entryId>`, Value = Index. Der nächste ungeklärte Name kommt nach der Wahl.
  - Embed der Liste: Position, Rohname, Wiki-Link oder „ohne Artikel“, `proposedAge` (Stand Saisonstart 2027). Darunter die Sätze aus dem Saison-Embed: Namen schicken, `entfernen 3`, `ändern 3 Neuer Name`, `fertig` / `done` / `end`.
  - `fertig`: ein `ambiguous`- oder `pending`-Entry blockiert. `unlinked` blockiert nicht (Frage 11, entschieden). Sonst `finalizeDraft(player.id, announced.id)` und `queueCelebsForReview(ctx, reviewIds, target, { season: announced })`. Die Funktion nimmt `announced.start_date` für `proposeWikiForName` und `enqueueReview(..., { seasonId: announced.id })`. Sie lädt die Saison nicht über `getActiveSeason()`. Celebs mit `queued: false` erscheinen nicht als offene 2027er-Karten. Antwort an den Spieler: Anzahl, Hinweis dass Gregg die Wikipedia-Zuordnung der neuen Namen noch bestätigt, Punkte `max(1, 100 − Alter zum 2027-01-01)`, Alter `—` solange die Review der neuen Zeile offen ist. Bereits aus 2026 bekannte Personen zeigen das 2027er-Alter aus `proposed_age`, ohne dass der 2026er-Celeb geändert wurde. Kein `applyDeath` aus der Spieler-DM.
  - `logEvent` `kind: "pick"` bei hinzu / weg / geändert / Kandidat gewählt / finalisiert, mit User-ID, Namen und `season_id`. Nicht bei jedem Zwischen-„tippt“.
- `src/discord/commands/picks.js`
  - Slash `/picks`, `admin: false`, `group: "everyone"`.
  - `run` macht keinen Wiki-Aufruf. `canParticipate`, bei Bedarf Draft anlegen, aktuelle Liste plus der Satz „Schick die Namen als Nächstes in diese Unterhaltung“. In einer Guild-Interaction: Hinweis, die DM zu öffnen, plus `user.createDM()` und die erste Liste dorthin. Schlägt die DM fehl: ephemer an den User und `logError`.
  - `index.js` macht vor `run` schon `deferReply`. Das bleibt, weil `run` nur SQLite und eine DM öffnet.

**Änderungen an Bestehendem**

- `src/discord/celeb-review.js`
  - `handleReviewInteraction`: direkt nach der Typ-Prüfung, vor dem Admin-Gate, `return false`, wenn die Custom-ID nicht mit `crev:` beginnt. Admin-Gate und „Nur Admin.“ bleiben für `crev:`.
  - `sendNextReview` und `queueCelebsForReview` nehmen die Saison, die zur Queue-Zeile gehört. `proposeWikiForName` bekommt deren `start_date`. Eine 2027er-Karte rechnet das Alter zum `2027-01-01`, auch wenn 2026 noch aktiv ist.
  - `confirmFromProposal` / `applyWikiConfirm` folgt der M3-Regel: announced-Queue lässt `exclude_from_auto = 1` und schreibt `celebs.age_at_pick` nicht um.
- `src/discord/commands/review.js`: `/review` ohne Argument, wenn `getAnnouncedSeason()` existiert, zeigt die Tiefe und die nächste Karte **nur** dieser `season_id`. Option `scope` (`next` | `pool`), Default `next`. `pool` liest `season_id IS NULL` oder die aktive ID (legacy und laufende 2026er-Imports). Die Antwort nennt die Saison im ersten Satz („2027-Anmeldung“ bzw. „laufender Pool“).
- `src/discord/commands/go.js`: nach dem bestehenden „Bereits live.“-Return (der bei 2026 weiter zuerst kommt) den Blocker auf `countPendingReviews({ blockingLive: true })` und `countUnconfirmedSeasonCelebs()` umstellen. Eine pending-Zeile mit der announced-`season_id` erhöht den Zähler nicht und erzeugt den Block-Text nicht. `force` bleibt der Override für die Reviews der **aktiven** Saison.
- `src/discord/commands/ungo.js`: verweigert, solange `getAnnouncedSeason()` eine Zeile liefert. Antwort: die laufende Saison bleibt live, der Wechsel ist `/new-year activate:true` am Saisonstart der announced-Saison. Damit seedet `/ungo` den All-Deaths-Cache nicht, während 2026 noch punkten soll, und ein folgendes `/go` kommt gar nicht erst in die Lage, an der 2027er-Queue zu hängen. Der Guard ist die konkrete Form von „2026 läuft unverändert weiter“.
- `src/discord/commands/import.js`:
  - Neue Funktion `seasonForImport()`: `const season = getActiveSeason()`. Werfen, wenn `!season || season.active !== 1` oder `season.phase === "announced"` oder (`phase` gesetzt und nicht `running` und nicht `setup`). `applyImportRows` und die Reply in `run` benutzen nur diese Funktion.
  - `clearPicksForPlayer` und `setPick` bekommen diese `season.id`. Ein Spieler mit 2027er-Picks behält sie, wenn der Admin seine 2026er-Liste ersetzt.
  - `tryConsumePaste` bleibt auf der Admin-`pending`-Map (`msg.author.id` des Admins, der `/import` gestartet hat). Eine Spieler-DM liegt nicht in dieser Map, fällt durch und erreicht `tryConsumePickMessage`. Hat der Admin selbst eine offene Paste, gehört seine nächste DM zum Import und schreibt 2026, bis `done` oder Ablauf. Das ist Absicht und steht im Log mit der running-`season_id`.
  - `queueCelebsForReview` aus dem Import übergibt `season: getActiveSeason()`.
- `src/index.js`:
  - `interactionCreate`, vor `handleReviewInteraction`: `handlePickInteraction`. Rückgabe `false`, wenn die ID nicht mit `pka:` beginnt. Erste Zeile der Behandlung: `deferUpdate()` bzw. `deferReply`, danach erst `lookupUrl` / DB.
  - `messageCreate`: Reihenfolge bleibt `tryConsumeReviewUrl`, dann `tryConsumePaste`, dann `tryConsumePickMessage`. Nur DMs werden vom Assistenten verarbeitet. Kein `setInterval`, kein Poll über offene DMs.
- `src/discord/commands/help.js`: wenn eine announced-Saison mit Kanal existiert, einen Satz, dass die nächste Runde per DM an Gregg getippt wird (`/picks`). Der bestehende Setup-Nudge (`!season.live` auf der **aktiven** Saison) bleibt für einen echten Setup-Pool. Er erscheint 2026 nicht, weil 2026 live ist, und wird nicht umgedeutet.
- `src/discord/commands/status.js`: zwei Zähler, „Reviews Pool“ (`blockingLive`) und „Reviews Anmeldung“ (`seasonId` der announced-Zeile, oder 0). Der eine globale `countPendingReviews()` steht dort nicht mehr allein.
- `src/discord/commands/season.js`: `setSeasonStartDate` verweigert, wenn die aktive Saison `phase = running` und `live = 1` ist. Das Startdatum 2027 setzt nur `openAnnouncedSeason`. Damit verschiebt ein `/season start_date:2027-01-01` im November nicht die 2026er-Altersbasis.
- README „For players“: `/picks` und die PM-Schritte, ausdrücklich für die announced-Runde. Bis M5 den Kanal setzt, bleibt der Assistent zu (`closed`). Der README-Satz sagt das.

**Serialize und Grenzen**

- Eine In-Memory-Queue pro User-ID, damit eine zweite PM während `proposeWikiForName` nicht parallel sucht. Namen werden an den Draft gehängt, die Auflösung arbeitet `pending`-Entries der Reihe nach ab und editiert „3/12“.
- Wikipedia-Fehler an einem Namen: Entry `unlinked`, `logError` mit Status, nächster Name läuft. `ändern N` stößt später neu an.
- `proposeWikiForName` nicht umbauen.

**Tests:**

- `test/pick-parse.test.js`: eine Zeile pro Name; `a; b; c`; `a – b — c`; `a - b`; `Jean-Luc Picard` bleibt eins; `Müller, Hans` bleibt eins; leere Zeilen; `nameKey`-Duplikat in einer Paste.
- `test/pick-draft.test.js`: Finalize ruft die Review nur für einen neuen, unbestätigten Celeb. Ein QID-Treffer auf einen bestätigten Running-Celeb erzeugt keine Queue-Zeile und ändert seine Flags nicht.
- `test/membership.test.js`: keine announced-Zeile → `closed`; announced ohne Kanal → `closed`; running `live = 1` daneben → trotzdem `ok`, wenn announced Kanal und `live = 0` hat; Fake-Channel ohne Guild → `channel`; ohne `ViewChannel` → `not-member`; Admin → `ok`; announced `live = 1` → `closed`.
- `test/import-season-target.test.js`: beide Saison-Zeilen vorhanden, Spieler hat je einen Pick. `applyImportRows` ersetzt nur die running-Picks, 2027er-Pick bleibt, neue Zeile hat die running-`season_id`. Ein direkter Aufruf der Ziel-Hilfe mit einer announced-Zeile als `getActiveSeason`-Stub wirft.
- `classifyProposal(proposal)` in `pick-assistant.js`, exportiert, in `test/pick-parse.test.js`: 1 Kandidat `linked`, 2 QID `ambiguous`, 0 `unlinked`. Kein Netz.

### M5 — Eröffnung jetzt, Wechsel am 2027-01-01 (Arbeitspaket B)

Abhängigkeit: M1, M3, M4. Zwei Befehle, zwei Zeitpunkte. Der erste löscht nichts. Der zweite archiviert und schaltet live, ebenfalls ohne `DELETE` auf Pool-Tabellen.

**Eröffnung, neuer Befehl `src/discord/commands/announce-season.js`**

Eigener Befehl, damit die bisherige Muscle-Memory `/new-year confirm:true` nicht eine Option neben dem Wipe ist.

- `announce_channel`, Typ `CHANNEL`, erforderlich, außer der Aufruf ist nur `repost`.
- `note`, Typ `STRING`, optional.
- `year`, Typ `INTEGER`, optional, Default `2027` solange das Kalenderjahr 2026 ist, sonst das nächste Jahr. Der November-Lauf übergibt faktisch 2027.
- `start_date`, Typ `STRING`, optional, Default `` `${year}-01-01` ``. Für diesen Lauf `2027-01-01`.
- `repost`, Typ `BOOLEAN`, optional.
- `admin: true`, `group: "season"`.

Ablauf `run`, wenn nicht `repost`:

1. `createPackage(ctx.config, { reason: "announce-season" })`. Das Zip ist die ganze SQLite-Datei, also 2026 inklusive Punkte und Picks. Der Grund im Namen macht das Paket von `new-year` und vom Nacht-Backup unterscheidbar.
2. `openAnnouncedSeason({ year, startDate, channelId, note })`. Schlägt das fehl (Jahr belegt, zweite announced-Saison), Reply mit dem Fehler, kein Embed, Backup bleibt liegen.
3. Embed in `announce_channel` posten.
4. `logEvent` `kind: "season-announce"` mit Jahr, `season_id`, Kanal-ID, Backup-Name.
5. Reply an den Admin: Saison-ID, `live=nein`, `phase=announced`, Start, Kanal, und der Satz, dass 2026 weiter live punktet.

Schlägt nur das Posten fehl: die Zeile ist schon committet. Reply nennt den Fehler, `logError`. Danach `repost:true`, ohne eine zweite Zeile und ohne Löschen.

`repost`: kein `openAnnouncedSeason`-Insert, kein Wipe, kein zweites Pflicht-Backup. Liest `getAnnouncedSeason()`. Fehlt sie oder `live !== 0`: verweigern. Kanal aus der Option oder aus `announce_channel_id`. Optional neue `note` über `setSeasonAnnounce`. Dasselbe Embed noch einmal. `logEvent` `kind: "season-repost"`.

Prefix: `{prefix}announce-season #kanal [Notiz…]`. Kanal aus `msg.mentions.channels`. Dafür `fromInteraction` um den Kanal aus `interaction.options.getChannel("announce_channel")` erweitern, abgelegt so, dass `mentions.channels.first()` ihn sieht.

**`src/discord/slash.js`:** `TYPE_MAP.CHANNEL = ApplicationCommandOptionType.Channel` und `addChannelOption`. Required-Optionen bleiben vor den optionalen sortiert, wie der Builder das schon tut.

**Embed**, eine Funktion `buildSeasonEmbed({ year, startDate, channelName, note, runningYear })` in `announce-season.js` (oder `src/discord/season-embed.js`, wenn der Test sie ohne den Command laden soll). Feste Sätze:

- Neue Runde **2027**, Start **2027-01-01**. Die Runde **2026** läuft bis dahin weiter; Tipps jetzt gelten für 2027, nicht für den laufenden Punktestand.
- Wer in diesem Kanal `ViewChannel` hat, schickt Gregg eine DM. Wer den Kanal nicht sehen kann, nimmt nicht teil.
- Namen einzeln oder als Liste: eine Zeile, Semikolon oder Strich mit Leerzeichen (` - `, ` – `, ` — `). Der Bot verknüpft Wikipedia, zeigt die Liste, `ändern` / `entfernen` / weitere Namen, bis `fertig` oder `done`.
- Alter und Punkte (`max(1, 100 − Alter)`) beziehen sich auf den **2027-01-01**.
- Danach bestätigt der Admin die neuen Wikipedia-Zuordnungen (`/review`) und schaltet am **2027-01-01** mit `/new-year activate:true` live. Bis dahin ist 2027 nicht live.
- `note` als eigenes Feld, wenn gesetzt.

**Wechsel am 2027-01-01, `src/discord/commands/new-year.js`**

Der Befehl wird der Archiv-Wechsel. Die Hilfe, die heute bei fehlendem `confirm` erscheint, beschreibt drei Wege und nennt `/announce-season` als Eröffnung:

- `/new-year activate:true` — archiviert die running-Saison, schaltet die announced-Saison live, löscht keine Picks und keine Celebs.
- `/announce-season` — legt nur die kommende Zeile an.
- `wipe:true` — der alte Löschpfad, und `run` verweigert ihn, solange `getActiveSeason().phase === "running"` oder `getAnnouncedSeason()` nicht `null` ist. Antwort, fester Satz: die laufende Saison wird über `activate` archiviert, Celebs und Picks bleiben. Im November 2026 und bis zum Wechsel ist dieser Zweig tot. Nach dem Wechsel existiert eine running-Zeile (2027), der Wipe bleibt deshalb auch dann verweigert. Der Code des `DELETE`-Blocks bleibt im File, erreichbar nur wenn weder `running` noch `announced` vorliegt (leerer `setup` ohne Anmeldung). Das ist der getrennte Notfall, nicht die Eröffnung und nicht der 1.1.-Abschluss.

`activate`-Ablauf, Option `activate` BOOLEAN. `confirm` ist dafür nicht erforderlich. Ein gleichzeitiges `wipe:true` verweigert der Befehl.

1. Kalender: `today` (UTC-Datum) muss `>= announced.start_date` sein. Vor dem 2027-01-01 verweigern, auch für Admins. `force:true` überspringt nur diese Datumsprüfung, für einen Testlauf, und die Reply sagt, dass der Wechsel vor dem Startdatum liegt. Default-Hilfe zeigt `force` nicht als normalen Weg.
2. `createPackage({ reason: "season-switch" })`. Inhalt: beide Saisons, alle Picks, alle `death_awards`, der noch nicht genullte Kontostand.
3. `activateAnnouncedSeason()` wie in M3 (Snapshot, `archiveRunningSeason`, 2027 `active = 1` / `live = 1` / `phase = running`, Exclude-Flip nur für 2027-only, `base_points` auf 0, Boni gelöscht, keine Deletes an Picks/Celebs/Awards/Drafts).
4. Nach dem Commit: `runWikiPoll(..., { mode: "reconcile" })`. `getActiveSeason()` ist jetzt 2027, `start_date` ist `2027-01-01`. `findPoolDeathsByCategory` bekommt dieses Datum und verwirft Kategorie-Tode davor. `getAliveCelebsForAuto` sieht nur noch Lebende; wer 2026 schon `is_alive = 0` ist, wird nicht erneut gewertet. **Kein** `mode: "seed"`. Ein Seed auf dem seit 2026 laufenden Feed würde ungestempelte Einträge auf `ANNOUNCED_EPOCH` setzen und Karten schlucken (`startWikiPoller`-Kommentar in `wiki-poll.js`). Der Poller tickt danach weiter `live`, weil `isLive()` wahr ist.
5. Schlägt Reconcile fehl: die Saisons bleiben gewechselt (Backup liegt), Reply und `logError`, Admin kann `/check` nachziehen. `/check` verlangt `season.live` und passt damit.
6. `logEvent` `kind: "season-switch"` mit archivierter ID, neuer ID, Backup-Name, Snapshot-Zeilenzahl.
7. Reply: 2026 archiviert, Punkte im Snapshot, 2027 live, Start, Anzahl stiller Nachträge, Hinweis dass der All-Deaths-Feed nicht neu geseedet wurde.

`setSeasonLive(true)` wird in diesem Ablauf nicht separat aufgerufen. `live` setzt das `UPDATE` in `activateAnnouncedSeason`.

Drafts nach dem Wechsel: `getAnnouncedSeason()` ist `null`, `canParticipate` ist `closed`. Finalisierte 2027er-Drafts bleiben mit `status = finalized` an der nun running-Zeile. Sie werden nicht gelöscht und nicht wieder geöffnet. Neue Tipps brauchen eine neue announced-Saison, die es vor dem nächsten Jahr nicht gibt.

**Was zwischen November und dem Wechsel absichtlich gleich bleibt**

- `isLive()` wahr, Poller-Modus `live`, Nachtlauf, Tagesbericht.
- `/scores` und `listScores` filtern Picks mit `s.active = 1` und zeigen `playerTotal` (2026er-Kontostand). 2027er-Picks erscheinen dort nicht. Spieler sehen sie in `/picks` und in der DM.
- `/go` auf der live-Zeile antwortet „Bereits live.“ und schaltet 2027 nicht live.
- `players`-Zeilen bleiben eine pro Discord-User. 2026er- und 2027er-Picks unterscheiden sich an `season_id`.

**README:** „start a season“ beschreibt `/announce-season`, die DM-Schritte, `repost`, und den späteren `/new-year activate:true`. Der Satz, `/new-year confirm` lösche den Pool und sei der normale Start, wird durch diese beiden Befehle ersetzt. `CHANNEL_LOG` steht seit M1 in der Settings-Tabelle.

**Tests:**

- `test/new-year-announce.test.js`: `buildSeasonEmbed` enthält Jahr 2027, Startdatum `2027-01-01`, den Hinweis dass 2026 weiterläuft, DM, Liste, `fertig`, Nicht-Mitglied, Stichtag der Punkte.
- `repost` gegen eine Temp-DB mit running-2026 und announced-2027: Zähler von `celebs`, `picks`, `death_awards` und `base_points` vorher = nachher, weiter genau eine announced-Zeile.
- `open`-Pfad derselben Datei: nach `openAnnouncedSeason` ist die running-ID dieselbe.
- `activate` auf einer Temp-DB: Datumshilfe verweigert bei `today < start_date`. Mit überschriebenem Datum: 2026 archiviert, 2027 live, Picks beider Jahre vorhanden, Snapshot gefüllt, `base_points` 0, `death_awards` vollständig, `exclude_from_auto` eines 2027-only bestätigten Celebs 0, `exclude_from_auto` eines Celebs mit beiden Picks unverändert.
- Der Wipe-Zweig mit `phase = running` wirft bzw. der Command-Helfer `assertWipeAllowed` gibt `{ ok: false }` zurück, und `celebs` bleibt stehen. Der Test ruft das rohe `DELETE` nicht aus.

---

## 3. Fallstricke im bestehenden Code

1. **`proposeWikiForName` im Tipp-Flow.** Pro Name: EN-Search plus bis zu drei `getPageMeta` mit 350 ms, oft noch eine DE-Suche. 25 Namen sind mehrere Minuten. Das läuft nur in der DM-Queue von M4, Name für Name, mit Fortschritts-Edit. Ein Slash, der die Liste selbst auflöst, läuft in das 15-Minuten-Token und in 429er. `page-lookup.js` wiederholt 429 nicht. Ein 429 lässt diesen Eintrag `unlinked` und macht weiter.

2. **Discord-Ack 3 s.** `index.js` ruft `deferReply` vor `run` auf. `/picks` und `/announce-season` (der Befehl selbst macht Backup, Insert, einen Send) müssen schnell ack’en; das Backup einer Live-DB kann dauern, deshalb `deferReply` vor `createPackage`, das `index.js` für Slash schon tut. Komponenten: `pka:` sendet `deferUpdate` als Erstes. Das URL-Modal in `celeb-review.js` ruft `lookupUrl` vor dem Ack auf; dieses Muster nicht für Spieler-Selects kopieren. Nicht-Admin-Buttons erreichen den Review-Code heute nie, weil das Admin-Gate sie als „Nur Admin.“ beantwortet (F10).

3. **Dedup muss idempotent sein (M2).** `markWikiAnnounced` stempelt beim ersten Mal für immer. Ein Verlierer, der gestempelt wird, bevor der Gewinner gesendet ist, kommt nie wieder (`deferredDeEn` hat das für die HTML-Brücke geschlossen). Eine neue ID-Form für EN-Rotlinks würde schon gesehene Rotlink-Personen noch einmal posten. Seed schreibt `ANNOUNCED_EPOCH` auf Ungestempeltes. Dedup im Seed-Modus und ein Seed beim 1.1.-Wechsel sind deshalb außen vor. Nur `live`/`nightly` mit All-Deaths-Kanal planen Ankündigungen.

4. **Live-DB-Migration.** `migrate` ist additiv und läuft bei jedem `openDb`. Neue Spalten nullable. Der `phase`-Backfill und der `death_awards.season_id`-Backfill laufen nur im selben Start, der die Spalte anlegt, und nur auf Zeilen, deren neue Spalte noch `NULL` ist. `qid` auf alten All-Deaths-Zeilen bleibt `NULL` (M2). Kein API-Backfill über 14 000 URLs. `celebs` wird nicht neu aufgebaut.

5. **Kein Dauer-Poll in DMs.** Der Assistent reagiert auf `messageCreate` und auf `pka:`. Ein Timer, der offene Drafts erinnert oder Wikipedia nachzieht, wäre ein zweiter Poller neben `startWikiPoller`. Nicht einbauen. Auch kein Cron, der um 00:00 am 2027-01-01 `activateAnnouncedSeason` aufruft: der Wechsel bleibt der Admin-Befehl, mit Backup und Reply.

6. **Membership und DMs.** Die PM hat kein `guild`. Die Prüfung läuft über `getAnnouncedSeason().announce_channel_id`, dann `channels.fetch`, dann `guild.members.fetch(userId)`, dann `permissionsFor`. `ViewChannel` ist „ist im Kanal“ (Frage 7, entschieden). `GuildMembers`-Intent wird nicht beantragt. Geschlossene DMs: `createDM()` wirft, der Slash antwortet ephemeral, der Logkanal bekommt den Fehler.

7. **`/new-year confirm:true` ist heute der Wipe.** Nach M5 ist die Eröffnung `/announce-season` und der Abschluss `/new-year activate:true`. Wer den alten Text im Kopf hat und `confirm:true` schickt, muss die Verweigerung sehen, solange 2026 `running` ist oder 2027 `announced` ist. `clearSeasonForNewYear` nullt außerdem `base_points`. Ein versehentlicher Aufruf im November würde den publizierten Spielstand löschen, bevor die `DELETE`s laufen. Deshalb verweigert der Command, bevor `createPackage` des Wipe-Pfads und bevor `clearSeasonForNewYear`.

8. **`enqueueReview` und `applyWikiConfirm` schreiben globale Flags.** Jeder neue Aufrufer übergibt `seasonId` und geht durch den Running-Celeb-Check aus M3. Ein Finalize, das `enqueueReview(celebId, proposal)` ohne `seasonId` und ohne Check aufruft, setzt auf einem 2026er-Celeb `wiki_confirmed = 0` und nimmt ihn aus dem Auto-Match. Die Signatur bleibt rückwärtslesbar, der Check sitzt in der Funktion, nicht nur im Assistenten.

9. **`getAliveCelebsForAuto` ist global.** Bis zum Wechsel bleiben 2027-only-Celebs `exclude_from_auto = 1`, auch nach Admin-Confirm. Der Flip passiert in `activateAnnouncedSeason` und nur für Celebs ohne Pick in der archivierten Saison. Ein Confirm, der für eine announced-Queue `exclude_from_auto = 0` setzt, legt die Person noch im Dezember in den 2026er-Deathpool.

10. **Dieselbe Person, zwei Spieler, zwei Saisons.** `setPick` hat den Primärschlüssel `(player_id, celeb_id, season_id)`. Zwei Spieler, eine QID: ein Celeb, zwei Picks, wie beim Import heute. Ein Spieler, beide Jahre: zwei Picks derselben `celeb_id`. Das ist zulässig. `mergeCelebs` kopiert Picks inklusive `season_id`. Finalize darf den Celeb des anderen Spielers und die Picks der anderen Saison nicht löschen.

11. **Alter.** `proposalFromMeta` setzt `proposedAge` aus Wikidata `P569` zum übergebenen Datum. Der Assistent übergibt `2027-01-01`. `scoreForAge(null)` ist 0. Fehlt `P569`, bleibt `picks.age_at_pick` NULL und der 2027er-Score 0, bis der Admin das Alter setzt. `setCelebAge` verweigert bei vorhandenen `death_awards` und schreibt `celebs.age_at_pick`. Für einen Celeb, der 2026 schon Punkte hat, trägt der Admin das 2027er-Alter deshalb als `picks.age_at_pick` der announced- bzw. später running-2027-Zeile ein, nicht über den alten Button, der die Celeb-Spalte sperrt oder überschreibt. M4-Review für announced-Karten schreibt das Alter auf die 2027er-Picks dieses Celebs (`UPDATE picks SET age_at_pick = ? WHERE celeb_id = ? AND season_id = ?`).

12. **Import und Draft schreiben verschiedene Saisons.** `applyImportRows` ersetzt die running-Picks und lässt `pick_drafts` sowie 2027er-Picks stehen. `fertig` ersetzt die announced-Picks und lässt 2026er-Picks stehen. Es gibt keinen stillen Merge der beiden Listen, und es gibt auch kein gegenseitiges Überschreiben mehr. Beide Ereignisse gehen in den Logkanal mit ihrer `season_id`.

13. **Tagesbericht nach M2.** Verlierer, die an einen schon geposteten Gewinner gebunden sind, mit dem `announced_at` des Gewinners stempeln (oder `ANNOUNCED_EPOCH`, wenn der Gewinner älter als 26 h ist). `datetime('now')` auf einem Verlierer ohne neue Karte zeigt ihn 26 h im Tagesbericht. `repairAnnouncedBursts` fasst nur Sekunden mit mehr als 20 Zeilen an.

14. **Komponenten-Limits.** `StringSelect` hat 25 Optionen, die Vorlage nutzt 3, `proposeWikiForName` liefert höchstens 3. Lange Listen bleiben Text (`entfernen 3`). Custom-IDs `pka:pick:<id>`, Obergrenze 100 Zeichen.

15. **Logkanal-Rate.** Ein Ereignis pro Draft-Änderung und pro unterdrückter Karte ist klein. Ein Ereignis pro gescrapter Zeile ist der untersagte Scan-Lauf und trifft zusätzlich das Kanal-Limit. Die Queue in M1 ist die Bremse, nicht die Erlaubnis. `wiki-poll.js` importiert `log.js` nur für die Unterdrückungszeile (M2) und für den einen Deathpool-`catch` (Frage 10).

16. **`/ungo` und Seed.** `/ungo` setzt `live = 0` auf der aktiven Saison und ruft `mode: "seed"` auf. In der Parallelphase würde das den 2026er-Deathpool stumm schalten und den All-Deaths-Stempel versetzen. M4 verweigert den Befehl, solange eine announced-Zeile existiert. Dasselbe gilt für einen Seed im Aktivieren (M5).

17. **`death_awards` ohne Saison-Spalte würde 2027 stumm lassen.** Der Unique-Index `(celeb_id, player_id)` lässt die zweite Gutschrift nicht zu. M3 erweitert ihn auf `(celeb_id, player_id, season_id)` und schreibt die Saison ab dann immer mit. Ein Deploy, der nur die Spalte anlegt und `applyDeath` noch ohne `season_id` insertet, erzeugt NULL-Keys, die sich nicht gegenseitig ausschließen. Spalte, Backfill, Index und `applyDeath` sind ein Deploy.

18. **`ensureActiveSeason` bei null aktiver Zeile.** Wenn `archiveRunningSeason` committen würde, ohne dass `activateAnnouncedSeason` die announced-Zeile auf `active = 1` setzt, legte der nächste `getActiveSeason` eine dritte Saison `phase = setup` an. Beide Schritte liegen in einer Transaktion. Der Aktivieren-Befehl ruft sie nur darüber auf.

19. **Restore ist die ganze Datei.** `restorePackage` ersetzt `deathbot.sqlite`. Es gibt kein Restore „nur 2027“ oder „nur den Snapshot“. Das Announce-Backup und das Switch-Backup sind deshalb vollständige Stände. Ein Restore nach dem Wechsel bringt auch den davor liegenden 2026er-Live-Stand zurück, inklusive `phase` und beider Zeilen, weil die Datei ganz ist.

20. **Gleicher Celeb, Tod im Dezember 2026.** Wer in der 2027er-Liste steht und im Dezember stirbt, wird über den 2026er-Pool gewertet, wenn er dort einen Pick hat (`applyDeath` zahlt der aktiven Saison). Die 2027er-Picks desselben Celebs bleiben liegen und zahlen nicht mit, solange 2026 aktiv ist. Ist die Person danach `is_alive = 0`, sieht der Reconcile am 1.1. sie nicht mehr (`getAliveCelebsForAuto` fordert `is_alive = 1`). Ein Tod vor `2027-01-01` bringt der 2027er-Runde keine Punkte. Das ist das bestehende Saisonstart-Gatter in `isDeathValidForSeason`.

---

## 4. Entscheidungen und offene Fragen

### 4.1 Entschieden am 2026-11-14

Fragen 1–11: Empfehlung aus v1 gilt. Frage 12 ist der Widerspruch und ist ebenfalls entschieden. Die Pakete bauen genau diese Zweige.

1. **Liste nach `fertig`.** Ändern nur solange der eigene Draft `draft` ist und die **announced**-Saison `live = 0` ist. `fertig` friert den 2027er-Draft ein. `live = 1` auf **2026** friert ihn nicht. Der Wechsel, der 2027 auf `live = 1` setzt, friert ihn. Admin-`/import` ersetzt weiter nur die aktive Saison (2026 bis zum Wechsel, danach 2027).
2. **Punkte und Review.** Dieselbe Formel `max(1, 100 − Alter)`, Alter aus Wikidata `P569` zum Startdatum der Zielsaison. Für 2027er-Tipps ist das Datum `2027-01-01`. Finalize reiht nur neue, noch nicht bestätigte Celebs in die 2027er-Queue ein. Kein `applyDeath` aus der Spieler-PM. Fehlendes Geburtsdatum bleibt Alter leer und 0 Punkte, bis es gesetzt ist (Fallstrick 11).
3. **Logkanal-Inhalt.** Mutationen und Fehler mit Stack bzw. HTTP-Status. Keine Lese-Befehle. Keine Scan-Läufe.
4. **Alte Doppelkarten.** Nur künftige Karten verhindern (M2). Der Kanalbestand bleibt.
5. **Tipp ohne Sicht auf den Kanal.** Eine DM, kein Draft, kein Wiki-Call, ein `logEvent`.
6. **Trenner.** Zeilenumbruch, `;`, ` - `, ` – `, ` — `. Komma und Binnen-Bindestrich trennen nicht. Das Embed (M5) beschreibt diese Trenner.
7. **Mitgliedschaft.** `ViewChannel` auf genau dem Kanal, der bei `/announce-season` gespeichert wurde. Kein Rollen-Sonderfall, kein Intent-Wechsel.
8. **Schreibvarianten ohne QID und ohne Redirect.** Beide Karten behalten (M2 Regeln 2–3).
9. **Embed noch einmal posten.** `repost` postet neu und lässt Tabellen, Picks und die running-Saison stehen.
10. **Deathpool-Fehler im Log.** Nur der eine `catch` pro konkretem Treffer in `runWikiPollInner`. Der Rest der Datei bleibt beim Scan-Verbot.
11. **Unverknüpfte Namen.** Bleiben auf der Liste (`unlinked`) und gehen beim Finalize in die Review, wie ein Import ohne Treffer. `ambiguous` blockiert `fertig`.
12. **Anmeldephase jetzt.** Entschieden gegen den v1-Default „nicht in 2026 öffnen“. Saison 2026 bleibt live bis zum Abschluss. Saison 2027 wird im November 2026 als `phase = announced`, `live = 0`, Start `2027-01-01` eröffnet. Teilnahme per DM bis Ende Dezember für jeden mit `ViewChannel`. Am 2027-01-01 archiviert der Admin 2026 ohne die Pool-Daten zu löschen und schaltet 2027 live. Die Eröffnung ist `/announce-season`, der Abschluss ist `/new-year activate:true`; der Wipe-Pfad bleibt in beiden Schritten aus. M4 bleibt offen, sobald die announced-Zeile einen Kanal hat, auch wenn die running-Zeile `live = 1` ist.

### 4.2 Neue Fragen aus dem Zwei-Saison-Modell

Defaults sind der Zweig, den M3–M5 bauen, solange keine andere Antwort da ist. Die November-Anmeldung wartet nicht auf diese Antworten.

13. **Was passiert am 2027-01-01 mit 2026er-Punkten, Boni und Awards?**
    Kontext: `players.base_points` und `player_bonuses` sind ein Kontostand. `death_awards` wird in M3 saisonfähig, die Zeilen selbst sind die History. `picks` der archivierten Saison bleiben liegen. `/scores` liest nach dem Wechsel die dann aktive Saison.
    Empfehlung: Archivieren ohne Delete. Vorher Snapshot (`season_point_snapshots`) von Basis, Boni und Total pro Spieler für die 2026er-ID. Danach `base_points = 0` und `player_bonuses` leeren, damit 2027 bei 0 startet. `death_awards` bleiben mit `season_id` der 2026er-Zeile. Neue Tode schreiben die dann aktive ID. 2026er-Picks bleiben lesbar.
    Standard bis zur Antwort: `activateAnnouncedSeason` in M3/M5 macht genau das. Ein späteres „Kontostand mitnehmen“ wäre ein anderes Update und lässt den Snapshot weg; der November-Code nullt den Kontostand erst in diesem Befehl, nicht bei der Eröffnung.

14. **Review-Queue: eine Zeile pro Celeb, zwei Saisons.**
    Kontext: `celeb_id UNIQUE`. `enqueueReview` entvalidiert global. `/review` ist heute eine einzige Schlange. `/go` zählt sie global, sobald die aktive Saison nicht live ist.
    Empfehlung: `season_id NULL` bleibt legacy/2026 und wird nicht nachträglich gefüllt, außer ein echter 2026er-Re-Enqueue schreibt die aktive ID. 2027er-Karten tragen die announced-ID. `/review` zeigt standardmäßig nur diese. `countPendingReviews({ blockingLive: true })` lässt die announced-ID weg, damit die 2027er-Queue 2026 nicht blockiert. Bestätigte oder im running-Pool gepickte Celebs werden nicht eingereiht und nicht entvalidiert.
    Standard bis zur Antwort: M3-Signaturen und der M4-Guard in `go.js`, `review.js`, `ungo.js`.

15. **Wohin schreiben `/import` und `tryConsumePaste`, wenn beide Saisons existieren?**
    Kontext: `applyImportRows` nimmt `getActiveSeason()` und ersetzt die Pickliste dieses Spielers in dieser Saison. `tryConsumePaste` hängt am Admin, der den Import gestartet hat, nicht am Spieler. `messageCreate` fragt den Import vor dem Assistenten.
    Empfehlung: Import schreibt immer die aktive Saison und verweigert, wenn diese Zeile `phase = announced` ist oder nicht `active = 1`. Spieler-DMs liegen nicht in der Paste-Map und erreichen den Assistenten. Eine offene Admin-Paste bleibt 2026, bis `done` oder 15 Minuten.
    Standard bis zur Antwort: `seasonForImport()` und `test/import-season-target.test.js` in M4. `getActiveSeason` wird dafür nicht auf die announced-Zeile umgebogen.

16. **Backup-Semantik bei zwei Zeilen.**
    Kontext: `createPackage` zippt die ganze `deathbot.sqlite` plus `manifest.json` mit `getActiveSeason()` und `statsSnapshot()`. `restorePackage` ersetzt die Datei. Es gibt kein saisonweises Restore.
    Empfehlung: Vor `openAnnouncedSeason` ein Paket `reason: "announce-season"`, vor `activateAnnouncedSeason` ein Paket `reason: "season-switch"`. Beide enthalten laufende und kommende Zeile, Picks und Awards. `repost` schreibt kein Pflicht-Backup und löscht nichts. Der Wipe-Pfad nimmt weiter `reason: "new-year"`, wird aber verweigert, solange running oder announced existiert. Nacht-Backup bleibt, wie es ist, und sieht ab der Eröffnung beide Zeilen in derselben Datei.
    Standard bis zur Antwort: M5 ruft `createPackage` an genau diesen zwei Stellen. Restore bleibt Ganzdatei; der Plan führt kein Teil-Restore ein.

17. **Gemeinsame Celeb-Zeile: welches Alter gilt 2027?**
    Kontext: `celebs.age_at_pick` füttert heute jeden Kill. 2027 ist ein Jahr später. Dieselbe QID darf nur eine Zeile haben.
    Empfehlung: QID oder `wiki_norm` treffen die bestehende Zeile, Flags und `celebs.age_at_pick` bleiben. Das 2027er-Alter aus `proposeWikiForName(..., "2027-01-01")` liegt auf `picks.age_at_pick`. `applyDeath` nimmt pro Gewinner das Pick-Alter und fällt auf das Celeb-Alter zurück, wenn das Pick-Alter NULL ist (alle Bestands-Picks). Neue Personen ohne Treffer gehen durch `findOrCreateCeleb` und in die 2027er-Queue.
    Standard bis zur Antwort: `linkCelebForAnnouncedSeason` und die `applyDeath`-Lesart in M3. Kein zweites Celeb-Duplikat pro Saison.

18. **Wann darf ein nur für 2027 angelegter Celeb in den Auto-Match?**
    Kontext: `applyWikiConfirm` setzt heute `exclude_from_auto = 0`. `getAliveCelebsForAuto` ist nicht auf `active = 1` gefiltert. Ein Confirm im November würde die Person in den 2026er-Poller legen.
    Empfehlung: Confirm einer announced-Queue lässt `wiki_confirmed = 1` und `exclude_from_auto = 1`. `activateAnnouncedSeason` setzt `exclude_from_auto = 0` nur für bestätigte, nicht manuelle Celebs, die einen 2027er-Pick und keinen Pick in der archivierten Saison haben.
    Standard bis zur Antwort: M3-`applyWikiConfirm`-Zweig und das `UPDATE` in `activateAnnouncedSeason`.

19. **Schaltet der Bot am 2027-01-01 von allein um?**
    Kontext: Ein Cron wäre unbeaufsichtigt (Backup, Reconcile, Kontostand). Der Owner ist am Wechsel ansprechbar.
    Empfehlung: Kein Cron. Admin ruft `/new-year activate:true` am oder nach dem `start_date` der announced-Saison. Vorher verweigert der Befehl. `force:true` hebt nur die Datumsgrenze auf.
    Standard bis zur Antwort: M5-Datumsgate, kein Eintrag in `src/index.js` / `node-cron` für den Wechsel.

20. **Was zeigen `/scores` und die Spielerliste in der Parallelphase?**
    Kontext: `listScores` zählt Picks mit `s.active = 1` und addiert den globalen Kontostand. Eine reine 2027er-Anmeldung hat in 2026 keine aktiven Picks und erscheint nicht. Das ist der laufende Spielstand, den die Runde bis Dezember weiterführt.
    Empfehlung: Öffentliche Scores bleiben die running-Saison. 2027 sieht der Spieler über `/picks` und die DM. Nach `activate` zeigt `/scores` die neue running-Saison und den dann auf 0 gesetzten Kontostand. Der 2026er-Snapshot ist über die Tabelle da; ein öffentlicher `/scores season:2026` ist kein Teil dieses Ausbaus.
    Standard bis zur Antwort: `listScores` und `getPlayerPicks` behalten `getActiveSeason()`. Kein zweites Scoreboard in M4/M5.

21. **Darf der Wipe-Pfad noch aufgerufen werden?**
    Kontext: Der Code löscht `celebs`, `picks`, `death_awards`, Akas, Blacklist, Boni und nullt Punkte. Die Entscheidung zu Frage 12 nimmt ihn als Eröffnung und als 1.1.-Abschluss heraus. Ein harter Abbruch einer leeren Setup-Saison kann im File bleiben.
    Empfehlung: `wipe:true` verweigert, sobald eine Zeile `phase = running` ist oder eine announced-Zeile existiert. Damit ist er von November 2026 an bis nach dem Wechsel nicht der Weg, 2026 zu beenden. Beenden ist `activate` (archivieren, Daten bleiben).
    Standard bis zur Antwort: `assertWipeAllowed` in M5, Test dass `celebs` bei `phase = running` unverändert bleibt.

22. **Welche `season_id` trägt ein Draft?**
    Kontext: `UNIQUE(player_id, season_id)`. Ein Draft an der running-Saison würde `finalizeDraft` in Versuchung führen, 2026er-Picks zu ersetzen.
    Empfehlung: `getOrCreateDraft` und `finalizeDraft` nehmen nur die announced-Saison und werfen sonst. Es wird kein Draft für 2026 angelegt. Finalisierte 2027er-Drafts bleiben nach dem Wechsel an dieser Zeile hängen und gehen nicht wieder auf. Drafts der running-Saison, sollte ein Test welche eingefügt haben, werden von Eröffnung, Archivierung und Aktivierung nicht gelöscht und nicht geändert.
    Standard bis zur Antwort: die Prüfungen in M3 und die Tests, die einen running-Draft-Aufruf werfen lassen und einen announced-Draft über `archiveRunningSeason` hinweg behalten.

---

## 5. Nächste Schritte

Die Anmeldung soll noch im November 2026 aufgehen. Gebaut wird zuerst **M1**, ohne weitere Antwort (Fragen 1–12 sind entschieden, die Defaults aus 4.2 ändern M1 nicht). Danach direkt der Anmeldeblock **M3 → M4 → M5**, und erst dann **M2**.

M1, nur diese Dateien:

- `src/discord/log.js` (neu)
- `src/config.js`
- `docker-compose.yml`
- `README.md`
- `src/index.js` (nur die bestehenden `catch`-Pfade)
- `src/discord/commands/import.js` (eine Logzeile pro abgeschlossenem Import, noch ohne `seasonForImport`)
- `src/discord/commands/new-year.js` (eine Logzeile im bestehenden Wipe-Zweig, noch ohne `activate` und ohne Verweigerung)
- `src/backup/index.js`
- `test/log.test.js` (neu)

`npm test` über `test/run.js`.

Unmittelbar danach M3, damit die 2027er-Zeile neben 2026 existieren kann, ohne den Pool zu löschen:

- `src/db/schema.js` (`phase`, Kanal, Drafts, `celeb_review_queue.season_id`, `picks.age_at_pick`, `death_awards.season_id`, Snapshots)
- `src/db/index.js` (`getActiveSeason`-Rückgabe, `getAnnouncedSeason`, `openAnnouncedSeason`, `archiveRunningSeason`, `activateAnnouncedSeason`, `linkCelebForAnnouncedSeason`, `finalizeDraft`, Review-Zähler, `applyDeath`)
- `test/two-season.test.js`, `test/pick-draft.test.js`

Dann M4 (`pick-parse.js`, `membership.js`, `pick-assistant.js`, `commands/picks.js`, Guards in `go.js`, `ungo.js`, `import.js`, `review.js`, `celeb-review.js`, `index.js`) und M5 (`commands/announce-season.js`, Umbau `new-year.js`, `slash.js` CHANNEL, Embed). Sobald M5 auf der NAS läuft, kann der Admin `/announce-season` mit dem Teilnahme-Kanal aufrufen. 2026 punktet dabei weiter. Der Wechsel bleibt `/new-year activate:true` am oder nach dem 2027-01-01.

M2 danach: `src/wiki/announce-dedup.js`, `src/jobs/wiki-poll.js`, `src/discord/announce.js`, `src/wiki/death-brief.js`, `src/wiki/page-lookup.js`, `src/wiki/scraper-en.js`, die QID-Spalten in `src/db/schema.js` und `src/db/index.js`, `test/announce-dedup.test.js`. Die Scan-Log-Regel aus M1 gilt dabei unverändert.
