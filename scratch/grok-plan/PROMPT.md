Du bist der Architekt für DeathBot-2000, einen produktiven Discord-Celebrity-Deathpool-Bot
(Node 20, discord.js 14, better-sqlite3, läuft als Docker auf einer NAS, öffentliches Repo
github.com/Emil007/DeathBot-2000, Diskord-Bot "Gregg#0124").

Lies der Reihe nach:
1. `ANFORDERUNGEN.md` — die vier Arbeitspakete vom Eigentümer (A: Kanal-Qualität/Dedup+Wiki-Links,
   B: Saisonstart im laufenden Betrieb mit Announce-Kanal + Teilnehmer-Onboarding,
   C: Self-Service-Tipp-Assistent per PM mit Wiki-Verknüpfung und iterativer Bearbeitung,
   D: Logkanal für Eingaben/Änderungen/Fehler inkl. techn. Details, KEINE Scan-Run-Logs).
2. `ANALYSE-DB.md` — echte Live-DB-Befunde (Duplikate, Band-Sammelseiten als Karten, DE+EN-Regel-Fälle).
3. Den kompletten Quellcode im Workspace (`src/`, `test/`, `scripts/`, `package.json`, `README.md`).

WICHTIG — bitte die echten, bestehenden Module WIEDERVERWENDEN statt neu zu erfinden:
- `src/db/index.js` = zentrale DB-API (getActiveSeason, clearSeasonForNewYear, findOrCreateCeleb,
  setPick, applyWikiConfirm, enqueueReview, findCelebByWikiNorm/WikidataId, mergeCelebs, upsertPlayer, …)
- `src/wiki/page-lookup.js` = proposeWikiForName / lookupUrl / normalizeWikiUrl / getPageMeta / isPersonPage
- `src/discord/celeb-review.js` = Admin-Review mit Buttons/Modals/StringSelect (Vorlage für Light-Review)
- `src/discord/commands/import.js` = Paste-Chunk-Puffer bis done/fertig/end (Muster für den PM-Pick-Assistenten)
- `src/discord/msg-adapter.js`, `src/discord/admin-notify.js`, `src/config.js`

Schreibe EINE Implementierungs- und Architektur-Plan-Datei `IMPLEMENTIERUNGSPLAN.md` im Workspace mit:

## Geforderte Struktur der Ausgabedatei

### 1. Konsolidierte Findingliste (F01, F02, …) pro Arbeitspaket
Nur echte, im Code verifizierte Probleme. Jedes Finding: Bereich (A/B/C/D), Severity,
Wurzelursache, betroffene Dateien/Funktionen, konkrete Kern-Aussage. Für A: binde die
DB-Befunde aus `ANALYSE-DB.md` explizit an die Code-Stellen (wiki-poll.js announce-Flow,
announceAllDeath redName-Pfad, death-brief redName-Logik, EN/DE-Brücke in wiki-poll).
Kein Generik, keine aufgebauschten Edge-Cases ohne Code-Bezug.

### 2. Implementierungsplan als geordnete Arbeitspakete M1, M2, …
- Harte Build-Reihenfolge + Abhängigkeiten (z.B. "M3 hängt an M1", doppelt ausdrücken:
  im Vorwärts-Ablauf UND bei jedem Paket "Abhängigkeit: M1").
- Pro Paket: konkrete Dateien, konkrete Änderungen (bestehende Funktionen benennen),
  neue Dateien (z.B. `src/discord/pick-assistant.js`, `src/discord/log.js`, neue DB-Tabellen
  in `src/db/schema.js` + Migrationen in `src/db/index.js`), neue Envs in `src/config.js`
  + `docker-compose.yml` + README, und ein Tests-Block ("Tests:" mit was genau getestet wird,
  inkl. neuer Fälle in `test/*.test.js`; `test/run.js` führt sie aus).
- Beachte die Einschränkungen des Besitzers:
  - KEINE Logs der Scan-Runs im Logkanal (D).
  - Teilnahme-Recht per Kanal-Membership prüfen (B).
  - Dedup risikoarm: nie echte Todesfälle verschlucken; deterministische Kriterien (A).
  - Tipp-Liste per PM: einzeln ODER Liste (eine pro Zeile / Striche / Semikolon), iterativ
    ändern/entfernen/hinzufügen bis "fertig"; Wiki-Verknüpfung pro Name; bei Homonymen
    Kandidaten zur Auswahl (C).

### 3. Erfahrungsgemäße Fallstricke / Gefahren, die du im Code findest
Was kann beim Umsetzen schiefgehen (Rate-Limits bei proposalWikiForName im Tipp-Flow;
Discord 3s-Ack-Fenster bei PM-Slash; idempotente Dedup-Logik; Migrationen ohne
Datenverlust auf der Live-DB; kein Dauer-Poll in DMs; Channel-Nicht-Member-Prüfung
mit fetch — DM-Kanal hat kein guild membership …).

### 4. OFFENE FRAGEN / ENTSCHEIDUNGEN für den Eigentümer
EINE fortlaufend nummerierte Liste aller Punkte, die eine Eigentümer-Entscheidung brauchen.
Jede Frage: Kontext (1 Zeile), "Empfehlung:" (1 Zeile), "Standard bis zur Antwort:"
(welches Default-Paket baut welchen Zweig). Sei erschöpfend — der Eigentümer beantwortet
sie in einem Rutsch. Beispiele, die ich vorgebe (du darfst ergänzen):
1. Darf ein Spieler NACH Finalisierung/Kanonfrist seine Liste noch ändern (laufende Saison), oder ist das nur im Setup-Fenster möglich?
2. Punkte: gelten für die Tipps die gleichen Regeln wie Admin-Import (Alter zu Saisonstart, derzeit max(1,100-age))? Automatische Review-Queue nötig?
3. `CHANNEL_LOG`: auch Nicht-Fehler-Aktionen wie `/help`-Aufrufe loggen, oder nur relevante Aktionen?
4. Alte/unsaubere Doppelkarten (bereits gepostet): einmaliger Cleanup-Run im Reconcile, oder sollen neue nur künftig verhindert werden?
5. Wenn ein nicht-Mitglied des Announce-Kanals tippt: still ignorieren oder Verweigerungs-DM schicken?

Bewerte selbst, welche der 4 Arbeitspakete am besten zuerst umgesetzt werden (Risiko/Nutzen/Freiheitsgrade) und schlage eine Reihenfolge vor, ohne die Owner-Entscheidungen zu präjudizieren.

Am Ende: gib EINEN kurzen "Nächste Schritte"-Absatz mit der konkreten Datei-Liste, die als erstes gebaut werden soll, wenn der Eigentümer grünes Licht gibt.
