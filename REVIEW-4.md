Ich prüfe zuerst REVIEW-3 und den aktuellen Code an den genannten Stellen, damit jeder Befund gegen den echten Fix und nicht nur gegen die Beschreibung steht.Ich prüfe zuerst REVIEW-3 und den aktuellen Code an den genannten Stellen, damit jeder Befund gegen den echten Fix und nicht nur gegen die Beschreibung steht.REVIEW-3 ist da. Als Nächstes lese ich die geänderten Module gegen die 19 Befunde, zuerst Jahreswechsel, Schema und Announce.REVIEW-3 ist da. Als Nächstes lese ich die geänderten Module gegen die 19 Befunde, zuerst Jahreswechsel, Schema und Announce.Der Jahreswechsel am 1. Januar 00:00 Wien ist im Guard geschlossen. Offen und sofort wirksam: jeder Prozessstart postet eine Abschlussbilanz der laufenden Saison, obwohl dafür keine Snapshots existieren. Daneben bleiben der manuelle Wechsel ohne neuen Kanal, der Tipp-Resolver nach einer URL während der Auflösung, und die Overwrite-Nachpflege auf einem bestehenden Kanal.

Geprüft gegen `REVIEW-3.md` und den aktuellen Stand in `src/`. Die Tests wurden in dieser Runde nicht ausgeführt.

## Offene Defekte

### F20 — Jeder Start postet eine Abschlussbilanz ohne Punktestand

- **Schwere:** kritisch
- **Datei:** `src/index.js` 95–101; `src/jobs/year-rollover.js` 66–78 und 173–179; `src/db/index.js` 1474–1506
- **Problem:** `clientReady` ruft `runYearRollover` ohne Datumsschranke auf. Fehlt eine announced-Saison (Normalfall über das Jahr), oder liegt `start_date` noch vor dem Wiener Tag (`not-yet`, also ab der Eröffnung bis zum 31.12.), ruft der Lauf trotzdem `postReview` auf. `seasonReview` liest nur `season_point_snapshots`. Die schreibt weiterhin ausschließlich `activateAnnouncedSeason`. Für die laufende Saison gibt es die Zeilen erst beim nächsten Archivieren.

  Folge bei gesetztem Deathpool-Kanal, bei jedem Restart und jedem Deploy: Nachricht `Saison {Jahr} — Abschlussbilanz`. Ohne Snapshots und ohne Awards steht dort „Keine Punkte verbucht.“ Mit Awards erscheinen die Spieler mit `total: 0` und einer Trefferzahl; Bonus-only-Spieler fehlen. `test/year-rollover.test.js` 164 verlangt diesen Post auf dem `no-announced`-Pfad explizit (`review of running season still posted`) und prüft die Punkte nicht.

  Auf dem echten Wechselpfad stimmt die Reihenfolge Backup → `activateAnnouncedSeason` → `postReview(archived)`. Die Snapshots sind dann sichtbar, Bonus-only-Spieler inklusive. `deaths` bleibt `awardRows.length` (1506): zehn Spieler auf demselben Toten werden „10 Todesfälle“.
- **Fix:** `not-yet` sofort zurück, ohne `postReview`. Eine Bilanz nur nach committetem Wechsel, mit `seasonReview(archived.id)`. Ein `no-announced`-Post nur am Wiener 01.01. und nur einmal (Meta-Flag). Dafür vorher dieselben Summen wie in `activateAnnouncedSeason` schreiben oder `base_points` plus Boni lesen. `deaths` als `COUNT(DISTINCT celeb_id)`. Den Test, der den Post auf jedem zweiten Lauf verlangt, anpassen.

### F21 — `/new-year activate` schaltet live, legt keinen Deathpool-Kanal an und postet die Archiv-Bilanz nicht

- **Schwere:** hoch
- **Datei:** `src/discord/commands/new-year.js` 140–213
- **Problem:** Kanal und Bilanz hängen nur in `runYearRollover`. Der dokumentierte Handwechsel macht Backup, `activateAnnouncedSeason`, Reconcile, Antwort. Er ruft weder `createNextSeasonChannel` noch `setSeasonDeathpoolChannel` noch `postReview` auf. Danach ist keine announced-Saison mehr da. Cron und Start-Nachhol nehmen den `no-announced`-Pfad (F20) und legen `deathpool-{YEAR}` nicht nach. `deathpool_channel_id` bleibt leer, der Versand bleibt auf `CHANNEL_DEATHPOOL`. Die Snapshots der archivierten Saison liegen in der DB und werden von diesem Pfad nie gelesen.
- **Fix:** Dieselbe Nacharbeit wie der Cron: Kanal anlegen, ID nur in `deathpool_channel_id`, `postReview` mit der archivierten Saison und dem Live-Satz. Am besten eine Funktion, die beide Einstiege nach erfolgreichem `activateAnnouncedSeason` aufrufen.

### F22 — URL oder Auswahl während der Auflösung lässt `pending` liegen, `fertig` blockiert

- **Schwere:** hoch
- **Datei:** `src/discord/pick-assistant.js` 243, 327–332, 446–451, 703–706, 767, 781–788
- **Problem:** Der Überschreibschutz greift (`claimEntryUrl` plus `recheckEntry`). Der Abschluss nicht. Eine Wiki-URL oder `link N` bei gesetztem `busyUsers` speichert die URL, setzt `interruptUsers` und `rerunUsers` und kehrt mit „setze ich gleich um“ zurück. Die Select-Wahl setzt nur `interruptUsers`. Die Schleife bricht beim nächsten Eintrag ab, sobald das Flag gesetzt ist:

```703:706:src/discord/pick-assistant.js
      for (const e of pendings) {
        if (interruptUsers.has(userId)) break;
```

  Der `do/while (rerunUsers)` läuft danach noch einmal, löscht `rerunUsers` und bricht sofort wieder ab, weil `interruptUsers` erst im `finally` gelöscht wird. Die geclaimte Zeile bleibt `pending` (URL gesetzt, Status nicht `linked`). `finalizeDraft` blockiert jedes `pending`. `fertig` antwortet „Ein Name ist noch unklar“.

  Zweites Loch, gleiche Funktion: Nach der Schleife kommen noch `await respondPick` (781). Trifft in diesem Fenster eine weitere DM ein, sieht sie `busyUsers`, setzt `rerunUsers` und kehrt zurück. `finally` löscht `busyUsers` und plant keinen neuen Lauf. Die neuen Zeilen bleiben `pending`.
- **Fix:** `interruptUsers` nicht als Abbruch der ganzen Schleife benutzen. `recheckEntry` reicht, um eine manuelle Zeile nicht zu überschreiben; Einträge mit gesetzter `wiki_url` weiter über `lookupUrl` auflösen. `rerunUsers` im `finally` prüfen und, wenn gesetzt, nach dem Löschen von `busyUsers`/`interruptUsers` genau einmal `resolvePendingSynchronous` nachziehen. Select muss denselben Nachlauf anstoßen, sonst bleiben die übrigen Namen liegen.

### F23 — Bestands-Kanal: Overwrite-Edit setzt keine Rechte, Fehlerpfad wirft `client` weg

- **Schwere:** hoch
- **Datei:** `src/jobs/year-rollover.js` 219–229, 141–145, 292–323
- **Problem:** Drei Lücken an der Kanal-Anlage.

 1. `syncChannelOverwrites` ruft `permissionOverwrites.edit(d.id, d.allow, …)` mit `d.allow = ["ViewChannel", "SendMessages"]` auf (310). discord.js 14 erwartet dort `{ ViewChannel: true, SendMessages: true }`. `resolveOverwriteOptions` übernimmt nur Werte `true`/`false`/`null`. `Object.entries` auf dem Array liefert `["0","ViewChannel"]` und `["1","SendMessages"]`, keine Bits. Der erste `channels.create` ist in Ordnung, dort baut `PermissionsBitField` das Array. Die Nachpflege eines bestehenden `deathpool-{YEAR}` schreibt den API-Call, ändert die Rechte aber nicht. Der Test in `test/year-rollover.test.js` 432–472 zeichnet das Array nur an einem Fake auf.

 2. Wirft `edit` (unbekannte User-ID, fehlende Rechte), referenziert der `catch` `client` (318). Der Parameter der Funktion ist nur `(channel, config)`. In einem Modul ist das ein `ReferenceError`. Der steigt aus `createNextSeasonChannel` heraus, der bestehende Kanal wird verworfen, `newChannelFailed` wird gesetzt, `deathpool_channel_id` bleibt leer. Ein Spieler, der den Server verlassen hat, reicht.

 3. Keine auflösbare Guild: `createNextSeasonChannel` loggt und gibt `null` zurück, ohne zu werfen (219–229). `newChannelFailed` bleibt falsch. Die Kurzbestätigung ist der normale Satz „ist live“, ohne den Hinweis auf die fehlende Kanal-Anlage (141–145).
- **Fix:** `edit(id, { ViewChannel: true, SendMessages: true }, { type: 1, reason })`. `client` als Parameter nach `syncChannelOverwrites` durchreichen. Ein fehlgeschlagenes Edit einzelner Spieler loggen und den Kanal trotzdem zurückgeben. Bei `return null` wegen fehlender Guild `newChannelFailed` setzen, damit der Ack-Text den Fehlschlag nennt.

### F24 — Kategorie-Treffer der Anmeldung vergibt Punkte in der laufenden Saison

- **Schwere:** hoch
- **Datei:** `src/wiki/category-death.js` 302–356; `src/jobs/wiki-poll.js` 511–522; `src/discord/announce.js` 61–72; `src/db/index.js` 1257–1264 und 1166–1168
- **Problem:** Der Listenpfad ist geschlossen: `{ year: 2026, month: 11, day: 20 }` wird `2026-12-20`, und `applyDeath` vergibt auf einer aktiven Saison mit `start_date` danach keine Punkte. `findAnnouncedDeathsByCategory` hängt an den Entry weder `year`/`month`/`day` noch das Kategorie-Jahr (`parseDeathYear` wird dort nicht benutzt) und ruft `isDeathValidForSeason` nicht auf. `entryDeathDateIso` liefert `null`, `diedAt` wird der UTC-Erkennungstag.

  Der Pool-Lauf markiert eine alte Kategorie (`2024 deaths`) nur mit `exclude_from_auto` und lässt `is_alive = 1`. Der announced-Lauf sieht dieselbe Seite, weil `getAliveCelebsForAnnounced` `exclude_from_auto` nicht filtert, und ruft `processDeathpoolHit` auf. `applyDeath` wertet den Erkennungstag gegen den Start der laufenden Saison. Ein Tod von 2024, erkannt im Dezember 2026, liegt nicht vor `2026-01-01`. Hat der Celeb einen Pick in der laufenden Saison, gibt es Punkte. Der Pool-Lauf hätte genau diesen Fall verworfen.

  Zweites Prädikat, Listen und Kategorie: die Warnung nimmt `died_at <= start_date` (1167), die Punktesperre `diedAt < start_date` (1264). Ein Tod am Saisonstart selbst löst die DM „vor dem Saisonstart“ aus und bekommt gleichzeitig Punkte.
- **Fix:** Kategorie-Jahr in den Entry legen (`died_at` z. B. `{jahr}-12-31`, wenn Tag und Monat fehlen). Liegt das Jahr vor der laufenden Saison, `applyDeath` über den bestehenden `preStart`-Zweig auf 0 Punkte lassen und nur warnen. Warn-SQL auf `died_at < start_date` ziehen, analog zur Punktesperre. Erkennungstag nur, wenn wirklich kein Datum da ist, und in der DM als solches kennzeichnen.

### F25 — Bilanz-Versand: fehlender Kanal bleibt stumm

- **Schwere:** mittel
- **Datei:** `src/jobs/year-rollover.js` 176–178 und 396–398; `src/index.js` 99–101
- **Problem:** `channel.send` wird geloggt und `postReview` gibt dann `false` zurück. `channels.fetch` auf einen gelöschten Kanal endet in `.catch(() => null)` und `return false` ohne `logError`. `runYearRollover` verwirft den Rückgabewert. Der Cron- und der Start-`catch` schreiben nur `console.error`, auch wenn `activateAnnouncedSeason` nach dem `logError` erneut wirft.
- **Fix:** Bei fehlendem Ziel `logError` und `false`. Den Rückgabewert in `runYearRollover` auswerten. Beide `catch`-Handler über `logError` schicken.

### F26 — `UNKNOWN_CMD_RE` wirft echte Namen weg

- **Schwere:** niedrig
- **Datei:** `src/discord/pick-assistant.js` 32 und 626–628
- **Problem:** `CHANGE_RE` trifft `ändern 3 Neuer Name` als ganze DM. Zusätzlich filtert `/^\S+\s+\d+\s+\S+/` jeden einzelnen Token. `Boeing 737 Max` oder `Apollo 13 Crew` wird nicht gespeichert. Ist das der einzige Token, gibt `tryConsumePickMessage` `false` zurück, ohne Antwort. Steht `ändern 3 Neuer Name` in einer zweiten Zeile unter echten Namen, matcht `CHANGE_RE` die ganze DM nicht (`$` ohne `/m`), die Zeile wird still entfernt, die anderen Namen werden angelegt.
- **Fix:** Nur die dokumentierten Verben filtern (`änder`, `aender`, `entfern`, `link`, `falsch`, …), und eine solche Zeile in einer Mehrzeilen-DM als Befehl ausführen oder mit einem Satz ablehnen.

### F27 — Hilfe-Jahr und Punkte-Satz

- **Schwere:** niedrig
- **Datei:** `src/discord/commands/announce-season.js` 35, 112, 119; `src/db/index.js` 262–264; `src/discord/announce.js` 107–110
- **Problem:** `DEFAULT_YEAR` ist `aktiveSaison.year + 1`. `usage` und `details` nennen weiter `2027`. Der Embed-Satz „Weniger als **1** gibt es nicht“ gilt für bekanntes Alter (`scoreForAge`). `null` und `NaN` ergeben 0, die Deathpool-Karte schreibt „Alter unbekannt → 0 Punkte“.
- **Fix:** Hilfe ohne festes Jahr. Im Tarif-Satz unbekanntes Alter auf 0 setzen, den Embed-Satz daran anpassen.

## Vollständigkeitsmatrix

| Runde 3 | Status | Begründung |
| --- | --- | --- |
| F01 | ✅ | `todayInVienna` (en-CA, `Europe/Vienna`) in Cron und `/new-year`. `2026-12-31T23:00:00Z` ist Wiener 01.01. und schaltet ohne `force`. 31.12. 00:00–01:00 Wien ist `2026-12-30T23:00:00Z` bis `2026-12-31T00:00:00Z`, also Wiener `2026-12-31` und damit `not-yet`. Der spätere Rand 31.12. 23:59 Wien (`…T22:59:00Z`) ist im Test abgedeckt. |
| F02 | ⚠️ | Nachhol-Aufruf steht in `clientReady` und schaltet eine überfällige `start_date`. Er postet dabei die Abbruch-Bilanz (F20). |
| F03 | ⚠️ | Wechselpfad: Backup, dann `activateAnnouncedSeason`, dann Bilanz der archivierten ID, Live-Satz nur mit Jahr. `deaths` ist weiter die Award-Zeilenzahl. `no-announced`/`not-yet` schreiben keinen Snapshot und lesen die Live-Konten nicht. |
| F04 | ⚠️ | `send`-Fehler in Bilanz, Ack und Erinnerung gehen an `logError`. Fehlender Kanal in `postReview` bleibt stumm, der Rückgabewert wird verworfen, die Cron-`catch` loggen nur stdout (F25). |
| F05 | ✅ | Eine `setSeasonLive`: `true` setzt `setup`/`NULL` auf `running`, `false` setzt `running` auf `setup`. `openDb` hebt `active=1 AND live=1 AND phase='setup'` bei jedem Start an (idempotent). `/go` braucht keinen zweiten Schreibweg. |
| F06 | ⚠️ | Spalte, Migration (`ADD` nur wenn fehlend), `resolveDeathpoolChannel` und die Aufrufe in Treffer, Rücknahme, Simulation, Tagesbericht und Bilanz stimmen. `announce_channel_id` wird beim Rollover nicht überschrieben. Bestands-Overwrite, Guild-`null` und der Handwechsel nicht (F21, F23). |
| F07 | ✅ | Ohne `CHANNEL_ADMIN` DM an `adminId`. Kein Ziel: `reminded: false`, `reason: "no-target"`, `logError`, kein `admin-reminder`. Der Jahr-Vergleich ist weg. |
| F08 | ⚠️ | Claim, `recheckEntry` und `interruptUsers` im `finally` verhindern das Überschreiben und ein hängenbleibendes Flag. Der Nachlauf bricht am selben Flag ab, die URL bleibt `pending` (F22). |
| F09 | ✅ | `CHANGE_RE` ist `änder\w*|aender\w*|change`. Die DM `ändern 3 Neuer Name` ändert die Zeile. Der zusätzliche Filter ist zu breit (F26). |
| F10 | ✅ | `addDraftNames` dedupliziert über `nameKey` gegen bestehende Zeilen und gibt `duplicates` zurück. Die DM nennt sie. Der Kappungstext sagt, dass nur `entfernen` Platz schafft. Überhang zählt `recognized`. |
| F11 | ✅ | Repost liest nach `setSeasonAnnounce` `getAnnouncedSeason()` und nimmt `fresh.announce_note`. |
| F12 | ✅ | `countPendingReviews` ohne `seasonId` zählt `season_id IS NULL OR season_id = aktive Saison`. `/review scope:pool` übergibt `undefined` und trifft denselben Zweig (`undefined == null`). |
| F13 | ✅ | Confirm liest `seasonForQueue` vor `confirmFromProposal` und gibt das Paar an `sendNextReview`. |
| F14 | ⚠️ | Listen-Datum und Punktesperre für ein Datum vor `start_date` stimmen. Kategorie-Entry ohne Datum vergibt Punkte (F24). Warnung nutzt `<=`, Punkte `<`. DM-Fehler gehen an `logError`, die Summary nennt `sent`. |
| F15 | ⚠️ | `channels.fetch`, nur `GuildText`, `logError` bei fehlender Guild und beim Fetch-Fehler. Das Edit setzt die Bits nicht, der `catch` kennt `client` nicht, der Ack verschweigt den `null`-Return (F23). |
| F16 | ✅ | `unavailable` antwortet im DM und gibt `true` zurück, ohne zu speichern. |
| F17 | ✅ | Description wird nach dem Notiz-Anhang auf 4096 gekürzt, der Titel auf 256. Die Admin-Antwort nennt `(gekürzt)`. |
| F18 | ⚠️ | `DEFAULT_YEAR` ist laufendes Saisonjahr + 1. `channelName` ist weg. `note:` läuft bis zum nächsten bekannten Schlüssel. Hilfe-`2027` und der Mindestpunkte-Satz sind geblieben (F27). |
| F19 | ✅ | `reason: "empty"` hat einen eigenen Satz. Getrennt wird nur bei Leerzeichen beiderseits des Strichs. Feldwerte über 1024 enden mit `…`. |
| M4 | ⚠️ | Speicher und Resolve des neuen Kanals sind da. Rechte-Nachpflege, Ack bei fehlender Guild und der Handbefehl fehlen (F21, F23). |

## Implementierungsplan

### M1 — Bilanz nur nach echtem Wechsel

- **Dateien:** `src/jobs/year-rollover.js`, `src/db/index.js` (`seasonReview`), `src/index.js`, `test/year-rollover.test.js`
- **Änderung:** `not-yet` ohne Post. `no-announced` nicht bei jedem Start. Einmaliger Jahresbericht nur am Wiener 01.01., mit Live-Summe oder Snapshot und `COUNT(DISTINCT celeb_id)`. Den Test um Zeile 164 auf „kein Post“ bzw. „ein Post mit echten Punkten, nur am Stichtag“ umstellen.
- **Priorität:** vor dem nächsten Restart in Produktion.

### M2 — Handwechsel und Cron teilen sich Kanal und Bilanz

- **Dateien:** `src/discord/commands/new-year.js`, `src/jobs/year-rollover.js`
- **Änderung:** Nach `activateAnnouncedSeason` Kanal anlegen, `deathpool_channel_id` setzen, Bilanz der archivierten ID posten, Fehlschlag im Antworttext nennen.

### M3 — Resolver-Nachlauf zu Ende führen

- **Dateien:** `src/discord/pick-assistant.js`, `test/pickflow.test.js`
- **Änderung:** Kein `break` über `interruptUsers`. Geclaimte URL in derselben oder der nächsten Runde per `lookupUrl` anwenden. `finally` startet bei gesetztem `rerunUsers` genau einen weiteren Lauf. Test: URL während `proposeWikiForName`, danach Status `linked` oder `unlinked`, `fertig` legt die übrigen Picks an.

### M4 — Overwrites und Guild-Fehler

- **Dateien:** `src/jobs/year-rollover.js`, `test/year-rollover.test.js`
- **Änderung:** `edit` mit Boolean-Map. `client` durchreichen. Teilfehler nicht den bestehenden Kanal verwerfen. Guild-`null` setzt das Fehlschlag-Flag für den Ack. Test gegen die Aufrufform `{ ViewChannel: true, SendMessages: true }`, plus ein `edit`, das wirft, und der Kanal bleibt gesetzt.

### M5 — Kategorie-Tod ohne falsche Punkte

- **Dateien:** `src/wiki/category-death.js`, `src/discord/announce.js`, `src/db/index.js`
- **Änderung:** Kategorie-Jahr als `died_at` verwenden. Jahr vor der laufenden Saison: keine Awards, Warnung. SQL-Vergleich strikt `< start_date`.

### M6 — Stiller Bilanz-Fehler

- **Dateien:** `src/jobs/year-rollover.js`, `src/index.js`
- **Änderung:** `postReview` loggt einen fehlenden Kanal. Aufrufer und Cron-`catch` werten das aus und rufen `logError`.

### M7 — Texte

- **Dateien:** `src/discord/commands/announce-season.js`, `src/discord/pick-assistant.js`
- **Änderung:** `usage`/`details` ohne `2027`. Tarif-Satz: unbekanntes Alter 0 Punkte. `UNKNOWN_CMD_RE` auf die bekannten Verben begrenzen.Der Jahreswechsel am 1. Januar 00:00 Wien ist im Guard geschlossen. Offen und sofort wirksam: jeder Prozessstart postet eine Abschlussbilanz der laufenden Saison, obwohl dafür keine Snapshots existieren. Daneben bleiben der manuelle Wechsel ohne neuen Kanal, der Tipp-Resolver nach einer URL während der Auflösung, und die Overwrite-Nachpflege auf einem bestehenden Kanal.

Geprüft gegen `REVIEW-3.md` und den aktuellen Stand in `src/`. Die Tests wurden in dieser Runde nicht ausgeführt.

## Offene Defekte

### F20 — Jeder Start postet eine Abschlussbilanz ohne Punktestand

- **Schwere:** kritisch
- **Datei:** `src/index.js` 95–101; `src/jobs/year-rollover.js` 66–78 und 173–179; `src/db/index.js` 1474–1506
- **Problem:** `clientReady` ruft `runYearRollover` ohne Datumsschranke auf. Fehlt eine announced-Saison (Normalfall über das Jahr), oder liegt `start_date` noch vor dem Wiener Tag (`not-yet`, also ab der Eröffnung bis zum 31.12.), ruft der Lauf trotzdem `postReview` auf. `seasonReview` liest nur `season_point_snapshots`. Die schreibt weiterhin ausschließlich `activateAnnouncedSeason`. Für die laufende Saison gibt es die Zeilen erst beim nächsten Archivieren.

  Folge bei gesetztem Deathpool-Kanal, bei jedem Restart und jedem Deploy: Nachricht `Saison {Jahr} — Abschlussbilanz`. Ohne Snapshots und ohne Awards steht dort „Keine Punkte verbucht.“ Mit Awards erscheinen die Spieler mit `total: 0` und einer Trefferzahl; Bonus-only-Spieler fehlen. `test/year-rollover.test.js` 164 verlangt diesen Post auf dem `no-announced`-Pfad explizit (`review of running season still posted`) und prüft die Punkte nicht.

  Auf dem echten Wechselpfad stimmt die Reihenfolge Backup → `activateAnnouncedSeason` → `postReview(archived)`. Die Snapshots sind dann sichtbar, Bonus-only-Spieler inklusive. `deaths` bleibt `awardRows.length` (1506): zehn Spieler auf demselben Toten werden „10 Todesfälle“.
- **Fix:** `not-yet` sofort zurück, ohne `postReview`. Eine Bilanz nur nach committetem Wechsel, mit `seasonReview(archived.id)`. Ein `no-announced`-Post nur am Wiener 01.01. und nur einmal (Meta-Flag). Dafür vorher dieselben Summen wie in `activateAnnouncedSeason` schreiben oder `base_points` plus Boni lesen. `deaths` als `COUNT(DISTINCT celeb_id)`. Den Test, der den Post auf jedem zweiten Lauf verlangt, anpassen.

### F21 — `/new-year activate` schaltet live, legt keinen Deathpool-Kanal an und postet die Archiv-Bilanz nicht

- **Schwere:** hoch
- **Datei:** `src/discord/commands/new-year.js` 140–213
- **Problem:** Kanal und Bilanz hängen nur in `runYearRollover`. Der dokumentierte Handwechsel macht Backup, `activateAnnouncedSeason`, Reconcile, Antwort. Er ruft weder `createNextSeasonChannel` noch `setSeasonDeathpoolChannel` noch `postReview` auf. Danach ist keine announced-Saison mehr da. Cron und Start-Nachhol nehmen den `no-announced`-Pfad (F20) und legen `deathpool-{YEAR}` nicht nach. `deathpool_channel_id` bleibt leer, der Versand bleibt auf `CHANNEL_DEATHPOOL`. Die Snapshots der archivierten Saison liegen in der DB und werden von diesem Pfad nie gelesen.
- **Fix:** Dieselbe Nacharbeit wie der Cron: Kanal anlegen, ID nur in `deathpool_channel_id`, `postReview` mit der archivierten Saison und dem Live-Satz. Am besten eine Funktion, die beide Einstiege nach erfolgreichem `activateAnnouncedSeason` aufrufen.

### F22 — URL oder Auswahl während der Auflösung lässt `pending` liegen, `fertig` blockiert

- **Schwere:** hoch
- **Datei:** `src/discord/pick-assistant.js` 243, 327–332, 446–451, 703–706, 767, 781–788
- **Problem:** Der Überschreibschutz greift (`claimEntryUrl` plus `recheckEntry`). Der Abschluss nicht. Eine Wiki-URL oder `link N` bei gesetztem `busyUsers` speichert die URL, setzt `interruptUsers` und `rerunUsers` und kehrt mit „setze ich gleich um“ zurück. Die Select-Wahl setzt nur `interruptUsers`. Die Schleife bricht beim nächsten Eintrag ab, sobald das Flag gesetzt ist:

```703:706:src/discord/pick-assistant.js
      for (const e of pendings) {
        if (interruptUsers.has(userId)) break;
```

  Der `do/while (rerunUsers)` läuft danach noch einmal, löscht `rerunUsers` und bricht sofort wieder ab, weil `interruptUsers` erst im `finally` gelöscht wird. Die geclaimte Zeile bleibt `pending` (URL gesetzt, Status nicht `linked`). `finalizeDraft` blockiert jedes `pending`. `fertig` antwortet „Ein Name ist noch unklar“.

  Zweites Loch, gleiche Funktion: Nach der Schleife kommen noch `await respondPick` (781). Trifft in diesem Fenster eine weitere DM ein, sieht sie `busyUsers`, setzt `rerunUsers` und kehrt zurück. `finally` löscht `busyUsers` und plant keinen neuen Lauf. Die neuen Zeilen bleiben `pending`.
- **Fix:** `interruptUsers` nicht als Abbruch der ganzen Schleife benutzen. `recheckEntry` reicht, um eine manuelle Zeile nicht zu überschreiben; Einträge mit gesetzter `wiki_url` weiter über `lookupUrl` auflösen. `rerunUsers` im `finally` prüfen und, wenn gesetzt, nach dem Löschen von `busyUsers`/`interruptUsers` genau einmal `resolvePendingSynchronous` nachziehen. Select muss denselben Nachlauf anstoßen, sonst bleiben die übrigen Namen liegen.

### F23 — Bestands-Kanal: Overwrite-Edit setzt keine Rechte, Fehlerpfad wirft `client` weg

- **Schwere:** hoch
- **Datei:** `src/jobs/year-rollover.js` 219–229, 141–145, 292–323
- **Problem:** Drei Lücken an der Kanal-Anlage.

  1. `syncChannelOverwrites` ruft `permissionOverwrites.edit(d.id, d.allow, …)` mit `d.allow = ["ViewChannel", "SendMessages"]` auf (310). discord.js 14 erwartet dort `{ ViewChannel: true, SendMessages: true }`. `resolveOverwriteOptions` übernimmt nur Werte `true`/`false`/`null`. `Object.entries` auf dem Array liefert `["0","ViewChannel"]` und `["1","SendMessages"]`, keine Bits. Der erste `channels.create` ist in Ordnung, dort baut `PermissionsBitField` das Array. Die Nachpflege eines bestehenden `deathpool-{YEAR}` schreibt den API-Call, ändert die Rechte aber nicht. Der Test in `test/year-rollover.test.js` 432–472 zeichnet das Array nur an einem Fake auf.

  2. Wirft `edit` (unbekannte User-ID, fehlende Rechte), referenziert der `catch` `client` (318). Der Parameter der Funktion ist nur `(channel, config)`. In einem Modul ist das ein `ReferenceError`. Der steigt aus `createNextSeasonChannel` heraus, der bestehende Kanal wird verworfen, `newChannelFailed` wird gesetzt, `deathpool_channel_id` bleibt leer. Ein Spieler, der den Server verlassen hat, reicht.

  3. Keine auflösbare Guild: `createNextSeasonChannel` loggt und gibt `null` zurück, ohne zu werfen (219–229). `newChannelFailed` bleibt falsch. Die Kurzbestätigung ist der normale Satz „ist live“, ohne den Hinweis auf die fehlende Kanal-Anlage (141–145).
- **Fix:** `edit(id, { ViewChannel: true, SendMessages: true }, { type: 1, reason })`. `client` als Parameter nach `syncChannelOverwrites` durchreichen. Ein fehlgeschlagenes Edit einzelner Spieler loggen und den Kanal trotzdem zurückgeben. Bei `return null` wegen fehlender Guild `newChannelFailed` setzen, damit der Ack-Text den Fehlschlag nennt.

### F24 — Kategorie-Treffer der Anmeldung vergibt Punkte in der laufenden Saison

- **Schwere:** hoch
- **Datei:** `src/wiki/category-death.js` 302–356; `src/jobs/wiki-poll.js` 511–522; `src/discord/announce.js` 61–72; `src/db/index.js` 1257–1264 und 1166–1168
- **Problem:** Der Listenpfad ist geschlossen: `{ year: 2026, month: 11, day: 20 }` wird `2026-12-20`, und `applyDeath` vergibt auf einer aktiven Saison mit `start_date` danach keine Punkte. `findAnnouncedDeathsByCategory` hängt an den Entry weder `year`/`month`/`day` noch das Kategorie-Jahr (`parseDeathYear` wird dort nicht benutzt) und ruft `isDeathValidForSeason` nicht auf. `entryDeathDateIso` liefert `null`, `diedAt` wird der UTC-Erkennungstag.

  Der Pool-Lauf markiert eine alte Kategorie (`2024 deaths`) nur mit `exclude_from_auto` und lässt `is_alive = 1`. Der announced-Lauf sieht dieselbe Seite, weil `getAliveCelebsForAnnounced` `exclude_from_auto` nicht filtert, und ruft `processDeathpoolHit` auf. `applyDeath` wertet den Erkennungstag gegen den Start der laufenden Saison. Ein Tod von 2024, erkannt im Dezember 2026, liegt nicht vor `2026-01-01`. Hat der Celeb einen Pick in der laufenden Saison, gibt es Punkte. Der Pool-Lauf hätte genau diesen Fall verworfen.

  Zweites Prädikat, Listen und Kategorie: die Warnung nimmt `died_at <= start_date` (1167), die Punktesperre `diedAt < start_date` (1264). Ein Tod am Saisonstart selbst löst die DM „vor dem Saisonstart“ aus und bekommt gleichzeitig Punkte.
- **Fix:** Kategorie-Jahr in den Entry legen (`died_at` z. B. `{jahr}-12-31`, wenn Tag und Monat fehlen). Liegt das Jahr vor der laufenden Saison, `applyDeath` über den bestehenden `preStart`-Zweig auf 0 Punkte lassen und nur warnen. Warn-SQL auf `died_at < start_date` ziehen, analog zur Punktesperre. Erkennungstag nur, wenn wirklich kein Datum da ist, und in der DM als solches kennzeichnen.

### F25 — Bilanz-Versand: fehlender Kanal bleibt stumm

- **Schwere:** mittel
- **Datei:** `src/jobs/year-rollover.js` 176–178 und 396–398; `src/index.js` 99–101
- **Problem:** `channel.send` wird geloggt und `postReview` gibt dann `false` zurück. `channels.fetch` auf einen gelöschten Kanal endet in `.catch(() => null)` und `return false` ohne `logError`. `runYearRollover` verwirft den Rückgabewert. Der Cron- und der Start-`catch` schreiben nur `console.error`, auch wenn `activateAnnouncedSeason` nach dem `logError` erneut wirft.
- **Fix:** Bei fehlendem Ziel `logError` und `false`. Den Rückgabewert in `runYearRollover` auswerten. Beide `catch`-Handler über `logError` schicken.

### F26 — `UNKNOWN_CMD_RE` wirft echte Namen weg

- **Schwere:** niedrig
- **Datei:** `src/discord/pick-assistant.js` 32 und 626–628
- **Problem:** `CHANGE_RE` trifft `ändern 3 Neuer Name` als ganze DM. Zusätzlich filtert `/^\S+\s+\d+\s+\S+/` jeden einzelnen Token. `Boeing 737 Max` oder `Apollo 13 Crew` wird nicht gespeichert. Ist das der einzige Token, gibt `tryConsumePickMessage` `false` zurück, ohne Antwort. Steht `ändern 3 Neuer Name` in einer zweiten Zeile unter echten Namen, matcht `CHANGE_RE` die ganze DM nicht (`$` ohne `/m`), die Zeile wird still entfernt, die anderen Namen werden angelegt.
- **Fix:** Nur die dokumentierten Verben filtern (`änder`, `aender`, `entfern`, `link`, `falsch`, …), und eine solche Zeile in einer Mehrzeilen-DM als Befehl ausführen oder mit einem Satz ablehnen.

### F27 — Hilfe-Jahr und Punkte-Satz

- **Schwere:** niedrig
- **Datei:** `src/discord/commands/announce-season.js` 35, 112, 119; `src/db/index.js` 262–264; `src/discord/announce.js` 107–110
- **Problem:** `DEFAULT_YEAR` ist `aktiveSaison.year + 1`. `usage` und `details` nennen weiter `2027`. Der Embed-Satz „Weniger als **1** gibt es nicht“ gilt für bekanntes Alter (`scoreForAge`). `null` und `NaN` ergeben 0, die Deathpool-Karte schreibt „Alter unbekannt → 0 Punkte“.
- **Fix:** Hilfe ohne festes Jahr. Im Tarif-Satz unbekanntes Alter auf 0 setzen, den Embed-Satz daran anpassen.

## Vollständigkeitsmatrix

| Runde 3 | Status | Begründung |
| --- | --- | --- |
| F01 | ✅ | `todayInVienna` (en-CA, `Europe/Vienna`) in Cron und `/new-year`. `2026-12-31T23:00:00Z` ist Wiener 01.01. und schaltet ohne `force`. 31.12. 00:00–01:00 Wien ist `2026-12-30T23:00:00Z` bis `2026-12-31T00:00:00Z`, also Wiener `2026-12-31` und damit `not-yet`. Der spätere Rand 31.12. 23:59 Wien (`…T22:59:00Z`) ist im Test abgedeckt. |
| F02 | ⚠️ | Nachhol-Aufruf steht in `clientReady` und schaltet eine überfällige `start_date`. Er postet dabei die Abbruch-Bilanz (F20). |
| F03 | ⚠️ | Wechselpfad: Backup, dann `activateAnnouncedSeason`, dann Bilanz der archivierten ID, Live-Satz nur mit Jahr. `deaths` ist weiter die Award-Zeilenzahl. `no-announced`/`not-yet` schreiben keinen Snapshot und lesen die Live-Konten nicht. |
| F04 | ⚠️ | `send`-Fehler in Bilanz, Ack und Erinnerung gehen an `logError`. Fehlender Kanal in `postReview` bleibt stumm, der Rückgabewert wird verworfen, die Cron-`catch` loggen nur stdout (F25). |
| F05 | ✅ | Eine `setSeasonLive`: `true` setzt `setup`/`NULL` auf `running`, `false` setzt `running` auf `setup`. `openDb` hebt `active=1 AND live=1 AND phase='setup'` bei jedem Start an (idempotent). `/go` braucht keinen zweiten Schreibweg. |
| F06 | ⚠️ | Spalte, Migration (`ADD` nur wenn fehlend), `resolveDeathpoolChannel` und die Aufrufe in Treffer, Rücknahme, Simulation, Tagesbericht und Bilanz stimmen. `announce_channel_id` wird beim Rollover nicht überschrieben. Bestands-Overwrite, Guild-`null` und der Handwechsel nicht (F21, F23). |
| F07 | ✅ | Ohne `CHANNEL_ADMIN` DM an `adminId`. Kein Ziel: `reminded: false`, `reason: "no-target"`, `logError`, kein `admin-reminder`. Der Jahr-Vergleich ist weg. |
| F08 | ⚠️ | Claim, `recheckEntry` und `interruptUsers` im `finally` verhindern das Überschreiben und ein hängenbleibendes Flag. Der Nachlauf bricht am selben Flag ab, die URL bleibt `pending` (F22). |
| F09 | ✅ | `CHANGE_RE` ist `änder\w*|aender\w*|change`. Die DM `ändern 3 Neuer Name` ändert die Zeile. Der zusätzliche Filter ist zu breit (F26). |
| F10 | ✅ | `addDraftNames` dedupliziert über `nameKey` gegen bestehende Zeilen und gibt `duplicates` zurück. Die DM nennt sie. Der Kappungstext sagt, dass nur `entfernen` Platz schafft. Überhang zählt `recognized`. |
| F11 | ✅ | Repost liest nach `setSeasonAnnounce` `getAnnouncedSeason()` und nimmt `fresh.announce_note`. |
| F12 | ✅ | `countPendingReviews` ohne `seasonId` zählt `season_id IS NULL OR season_id = aktive Saison`. `/review scope:pool` übergibt `undefined` und trifft denselben Zweig (`undefined == null`). |
| F13 | ✅ | Confirm liest `seasonForQueue` vor `confirmFromProposal` und gibt das Paar an `sendNextReview`. |
| F14 | ⚠️ | Listen-Datum und Punktesperre für ein Datum vor `start_date` stimmen. Kategorie-Entry ohne Datum vergibt Punkte (F24). Warnung nutzt `<=`, Punkte `<`. DM-Fehler gehen an `logError`, die Summary nennt `sent`. |
| F15 | ⚠️ | `channels.fetch`, nur `GuildText`, `logError` bei fehlender Guild und beim Fetch-Fehler. Das Edit setzt die Bits nicht, der `catch` kennt `client` nicht, der Ack verschweigt den `null`-Return (F23). |
| F16 | ✅ | `unavailable` antwortet im DM und gibt `true` zurück, ohne zu speichern. |
| F17 | ✅ | Description wird nach dem Notiz-Anhang auf 4096 gekürzt, der Titel auf 256. Die Admin-Antwort nennt `(gekürzt)`. |
| F18 | ⚠️ | `DEFAULT_YEAR` ist laufendes Saisonjahr + 1. `channelName` ist weg. `note:` läuft bis zum nächsten bekannten Schlüssel. Hilfe-`2027` und der Mindestpunkte-Satz sind geblieben (F27). |
| F19 | ✅ | `reason: "empty"` hat einen eigenen Satz. Getrennt wird nur bei Leerzeichen beiderseits des Strichs. Feldwerte über 1024 enden mit `…`. |
| M4 | ⚠️ | Speicher und Resolve des neuen Kanals sind da. Rechte-Nachpflege, Ack bei fehlender Guild und der Handbefehl fehlen (F21, F23). |

## Implementierungsplan

### M1 — Bilanz nur nach echtem Wechsel

- **Dateien:** `src/jobs/year-rollover.js`, `src/db/index.js` (`seasonReview`), `src/index.js`, `test/year-rollover.test.js`
- **Änderung:** `not-yet` ohne Post. `no-announced` nicht bei jedem Start. Einmaliger Jahresbericht nur am Wiener 01.01., mit Live-Summe oder Snapshot und `COUNT(DISTINCT celeb_id)`. Den Test um Zeile 164 auf „kein Post“ bzw. „ein Post mit echten Punkten, nur am Stichtag“ umstellen.
- **Priorität:** vor dem nächsten Restart in Produktion.

### M2 — Handwechsel und Cron teilen sich Kanal und Bilanz

- **Dateien:** `src/discord/commands/new-year.js`, `src/jobs/year-rollover.js`
- **Änderung:** Nach `activateAnnouncedSeason` Kanal anlegen, `deathpool_channel_id` setzen, Bilanz der archivierten ID posten, Fehlschlag im Antworttext nennen.

### M3 — Resolver-Nachlauf zu Ende führen

- **Dateien:** `src/discord/pick-assistant.js`, `test/pickflow.test.js`
- **Änderung:** Kein `break` über `interruptUsers`. Geclaimte URL in derselben oder der nächsten Runde per `lookupUrl` anwenden. `finally` startet bei gesetztem `rerunUsers` genau einen weiteren Lauf. Test: URL während `proposeWikiForName`, danach Status `linked` oder `unlinked`, `fertig` legt die übrigen Picks an.

### M4 — Overwrites und Guild-Fehler

- **Dateien:** `src/jobs/year-rollover.js`, `test/year-rollover.test.js`
- **Änderung:** `edit` mit Boolean-Map. `client` durchreichen. Teilfehler nicht den bestehenden Kanal verwerfen. Guild-`null` setzt das Fehlschlag-Flag für den Ack. Test gegen die Aufrufform `{ ViewChannel: true, SendMessages: true }`, plus ein `edit`, das wirft, und der Kanal bleibt gesetzt.

### M5 — Kategorie-Tod ohne falsche Punkte

- **Dateien:** `src/wiki/category-death.js`, `src/discord/announce.js`, `src/db/index.js`
- **Änderung:** Kategorie-Jahr als `died_at` verwenden. Jahr vor der laufenden Saison: keine Awards, Warnung. SQL-Vergleich strikt `< start_date`.

### M6 — Stiller Bilanz-Fehler

- **Dateien:** `src/jobs/year-rollover.js`, `src/index.js`
- **Änderung:** `postReview` loggt einen fehlenden Kanal. Aufrufer und Cron-`catch` werten das aus und rufen `logError`.

### M7 — Texte

- **Dateien:** `src/discord/commands/announce-season.js`, `src/discord/pick-assistant.js`
- **Änderung:** `usage`/`details` ohne `2027`. Tarif-Satz: unbekanntes Alter 0 Punkte. `UNKNOWN_CMD_RE` auf die bekannten Verben begrenzen.
