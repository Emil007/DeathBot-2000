# DeathBot-2000 — Anforderungen an die Implementierung (vom Owner, 2026-11-14)

Vier Arbeitspakete. Der Bot läuft produktiv auf einer WD-NAS als Docker-Container
(Image ghcr.io/emil007/deathbot-2000:latest), Discord-Bot "Gregg#0124",
Daten in `/app/data/deathbot.sqlite` (bind-mount). Node 20, discord.js 14, better-sqlite3.
Repo: https://github.com/Emil007/DeathBot-2000 (öffentlich, main).

---

## A) Kanal-Qualität: Duplikate + kaputte Wiki-Links verbessern

Live-DB-Analyse in `ANALYSE-DB.md` (echte Befunde vom 14.11.2026).

Konkrete, zu lösende Probleme:

1. **Gleiche Person wird mehrfach gemeldet** mit verschiedenen URLs/Sprachen:
   - Band/Org-Sammelseite statt Personenseite (Young L: `The_Pack_(Band)`, `The_Pack_(group)` + eigene Seite `Young_L` → 3 Karten)
   - Titel-Varianten (Peter Antony Moran vs Peter Moran), DE-Transliteration vs EN (Wjatscheslaw Brjuchowezkyj vs Vyacheslav Briukhovetskyi), Rechtschreibvarianten (Claudette vs Claudete Soares)
   - Zwillinge-/Sammelseiten (Christian_und_Joseph_Cousins)
2. **"Links ins Leere"**: Karten deren Wikipedia-Link auf eine Band/Org-/Umleitung-/Nicht-Personen-Seite zeigt oder gar nicht existiert (red-link). Der Bot baut die Karte dann aus der Listenzeile (redName), aber der Link klickt auf eine leere/irreführende Seite.
3. **DE+EN-Regel unscharf**: Wann sind DE-Karte und EN-Karte beide ok, wann ist es ein Duplikat?

Erwartung:
- Deduplizierung VOR dem Posten (und ggf. Reconcile, um Alt-Müll zu bereinigen) — robust, aber risikoarm (keine echten Todesfälle verschlucken).
- Link-Qualität: Personenseite bevorzugen; wenn die eigentliche Personenseite existiert (z.B. Young_L), nicht die Band-/Sammelseite verlinken/announcen.
- Klare, deterministische Kriterien, keine Heuristik-Falle: DE-only wenn wirklich keine EN-Brücke, EN first.

## B) Saisonstart fürs nächste Jahr IM laufenden Betrieb (announcen + Teilnahme)

Aktuell: `/new-year` (src/discord/commands/new-year.js) ist ein reiner Admin-Slash-Befehl,
macht Backup + löscht Celebs/Picks, kein Kanal-Announce, keine Spieler-Onboarding.

Gewünscht:
- Admin kann im laufenden Betrieb die **nächste Runde** starten, dabei einen **Kanal** angeben
  (z.B. der Main-Chat) als `announce_channel`-Option.
- Der Bot **announced** dort (Embed), dass die neue Runde startet und **erklärt genau, wie man teilnimmt**:
  - Wer im Kanal ist, darf per **Privatnachricht (PM/DM)** an den Bot seine Tipps abgeben.
  - Anleitung (klare Schritte): "DM an Gregg mit deinen Namen — einzeln oder als Liste (eine pro Zeile / mit Strichen/Bindestrichen). Der Bot verknüpft mit Wikipedia, zeigt dir die Liste, du kannst ändern/entfernen/hinzufügen, bis du 'fertig' sagst."
  - Wer NICHT im Kanal ist (kein Member des angegebenen Kanals), darf NICHT teilnehmen → Teilnahme-Recht wird am Kanal-Membership geprüft.
- Der Bot sammelt die Tipps der Spieler über den neuen Tipp-Assistenten (siehe C) und legt sie als die üblichen Picks/Review-Queue ab, sobald der Spieler "fertig" sagt.
- `/new-year` erhält neue Optionen/Logik (announce_channel, beschreibung), aber die bestehende Admin-Archivierung (Backup, clearSeasonForNewYear) muss erhalten bleiben.

## C) Tipp-Assistent für Spieler per PM (Wiki-Verknüpfung + iterative Bearbeitung)

Aktuell gibt es KEINE Self-Service-Tippeingabe. Nur Admin—`!import` mit Sheet-Paste.

Gewünscht (neuer Flow, PM-basiert für Teilnehmer):
- Spieler schickt dem Bot eine **PM** mit Namen — **einzeln** ODER als **Liste**:
  - ein Promi pro Zeile, oder
  - mit Bindestrichen/Strichen/Strichpunkten getrennt (`–`, `-`, `;`, `,` — tolerant parsen).
- Der Bot **verknüpft jeden Namen mit der Wikipedia** (nutzt bestehende `proposeWikiForName` / `lookupUrl` aus `src/wiki/page-lookup.js`) und **befüllt eine Liste** (DB-backed, pro Spieler+Pending-Saison).
- Der Bot zeigt dem Spieler seine aktuelle Liste (mit Wiki-Link + vorgeschlagenem Alter) und gibt ihm **Interaktionsmöglichkeiten**:
  - Namen **ändern** (z.B. andere Person / andere Schreibweise)
  - Namen **entfernen**
  - neue Namen **hinzufügen**
  - bis der Spieler die Liste als fertig bestätigt → **"fertig"/"done"** → Liste wird eingefroren und in die Saison-Picks (picks-Tabelle) + Review-Queue übernommen (wie Admin-Import, aber self-service).
- Beim Verknüpfen: bei Mehrdeutigkeit (Homonyme) den Spieler wählen lassen (Kandidatenliste), wie die Admin-Review (`celeb-review.js`-Buttons), aber light.
- Kommunikation muss robust sein (Nachrichten-gesteuert, evtl. DMs; nicht nur einmaliger Call). Konflikte: Wenn der Spieler die Liste schon eingereicht hat (Saison läuft), soll er im laufenden Betrieb seine Liste ABGEBEN können, aber Änderungen nach Abgabefrist — Entscheidung nötig (siehe OFFENE FRAGEN).

Design-Freiheit / Empfehlung: einen neuen `src/discord/pick-assistant.js` + PM-Command
(ein `@mention`-PM oder ein Slash `/picks` in DM), State in eigenem DB-Tabellen-Set
(`pick_drafts`, `pick_draft_entries`, ggf. mit Status draft/finalized).

## D) Logkanal: alle Eingaben, Änderungen und Fehler inkl. technischer Details

Aktuell: KEIN Logkanal. Logs gehen an stdout (Container) + Fehlermeldungen teilweise an Nutzer.

Gewünscht:
- Ein **konfigurierbarer Kanal** (`CHANNEL_LOG`), in den der Bot schreibt:
  - **alle Eingaben** (jede PM-Tippeingabe, jedes Import-Ereignis, jedes "/"-Kommando wenn sinnvoll — mit User + Inhalt bzw. anonymisiert)
  - **alle Änderungen** (Liste geändert/hinzugefügt/entfernt/finalisiert; Wiki-Zuordnung geändert; Backup/Neujahr-Archivierung; neue Saison gestartet)
  - **alle Fehler inkl. technischer Details** (Stacktrace, HTTP-Status, Discord-Fehler, Wiki-Fehler, Retry-Fälle)
  - **KEINE Logs über die Scan-Runs** (die all-deaths/Wiki-Poll-Scrapes sollen NICHT in den Logkanal — das war explizit vom Owner: "keine logs über die scan runs dort").

Erwartung:
- Ein zentraler Helfer (`src/discord/log.js`?), der aus jeder Stelle aufrufbar ist, rate-limit-sicher
  (Discord: nicht bei jedem Poll-Posten loggen), Failsafe (Logkanal kaputt → warnen, nicht crashen).
- Soll auch `CHANNEL_ADMIN`-Verhalten ergänzen, nicht ersetzen. Privacy: Discord-User-IDs sind ok
  (Admin-Server), aber keine Tokens/Secrets je loggen.

---

## Technische Randbedingungen & Bestehende Module (bitte wiederverwenden)

- `src/db/index.js` (1195 Zeilen) = zentrale DB-API: `getActiveSeason`, `clearSeasonForNewYear`,
  `findOrCreateCeleb`, `setPick`, `applyDeath`, `applyWikiConfirm`, `enqueueReview`,
  `findCelebByWikiNorm/WikidataId`, `mergeCelebs`, `upsertPlayer`, `playerTotal`, …
- `src/wiki/page-lookup.js`: `proposeWikiForName`, `lookupUrl`, `normalizeWikiUrl`, `getPageMeta`,
  `isPersonPage`, Kandidaten-Suche (EN first, DE Fallback) — perfekt für den Tipp-Assistenten.
- `src/discord/celeb-review.js`: Admin-Review-Buttons/Modals/Menus (`reviewCustomId` etc.) — Vorlage für Light-Review im Tipp-Flow.
- `src/discord/commands/import.js`: zeigt, wie Paste-Chunks bis `done`/`fertig`/`end` gepuffert werden (`tryConsumePaste`, `pending`-Map) — Muster für den PM-Pick-Assistenten.
- `src/discord/msg-adapter.js`: Message↔Interaction-Normalisierung.
- `src/discord/admin-notify.js`: `resolveAdminTarget`/`sendAdmin`.
- `src/config.js`: Env-Config (`CHANNEL_*`). Neue Envs sauber ergänzen.
- `src/docker-compose.yml` + README: neue Envs dokumentieren.
- Tests: `test/run.js` läuft alle `test/*.test.js` mit echter Temp-SQLite. Für neue DB-Tabellen/Logik Tests ergänzen.

## Ablauf (bestehende Anlaufreihenfolge Saison)
`/new-year` → `!import`/Tipp-Assistent (B+C) → `/check` (still reconcile) → `/go` (live).
