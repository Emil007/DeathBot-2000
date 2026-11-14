# GROK — DeathBot-2000 Plan auf "Zwei parallele Saisons" überarbeiten (v2)

Du bist weiterhin der Architekt von DeathBot-2000 (Node 20, discord.js 14, better-sqlite3,
Docker auf WD-NAS, öffentliches Repo github.com/Emil007/DeathBot-2000, Bot "Gregg#0124").

## Kontext

Du hast am 2026-11-14 bereits `IMPLEMENTIERUNGSPLAN.md` (v1) im Workspace erstellt.
Der Eigentümer hat die 12 Entscheidungsfragen beantwortet und angepasst:

- **Fragen 1–11: Ja (Empfehlungen übernommen).**
- **Frage 12: WIDERSPRUCH** — siehe die neue Datei `AUFGABE-ZWEI-SAISON.md`.

Damit ist deine Aufgabe: **Überarbeite `IMPLEMENTIERUNGSPLAN.md` IN-PLACE zu v2
„Zwei parallele Saisons"**, sofort umsetzbar.

## Neue Tatsachen/Entscheidungen (zwingend)

1. **Saison 2026 läuft WEITER LIVE** (live=1, Start 2026-01-01) bis Ende Dezember 2026:
   Kills, Punkte, Rücksetztungen, Tagesbericht — komplett unverändert weiterlaufen.
2. **Saison 2027 wird JETZT (November 2026) als announced-Saison eröffnet** (live=0, phase=announced):
   - Admin-Befehl mit `announce_channel` (+ optional `note`), Teilnahme-Embed im Kanal.
   - Alle mit ViewChannel können ab sofort bis Ende Dezember per DM Tipps abgeben (Paket C).
   - Am 01.01.2027: Saison 2027 live schalten; Saison 2026 abschließen/archivieren ohne Datenverlust.
3. **Der destruktive Wipe-Pfad von `/new-year` (Celebs/Picks löschen) wird NICHT mehr als normale
   Saisoneröffnung benutzt.** Die 2026er-Daten bleiben bis zum echten Abschluss vollständig erhalten.
4. **Zwei parallele Saison-Zeilen sind möglich:** running (2026) + announced (2027).
5. **Punkteregel/Saisonstart: 2027-01-01** für Alter-Berechnung der 2027er-Tipps.

## Arbeitsweise

1. Lies in dieser Reihenfolge: `AUFGABE-ZWEI-SAISON.md` → `ANALYSE-DB.md` → bestehender
   `IMPLEMENTIERUNGSPLAN.md` (v1) → relevanter Source (`src/db/index.js`, `src/db/schema.js`,
   `src/discord/commands/new-year.js`, `src/discord/commands/import.js`, `src/discord/celeb-review.js`,
   `src/jobs/wiki-poll.js`, `src/discord/slash.js`, `src/config.js`, `src/index.js`).
2. Überarbeite **IN-PLACE**: `IMPLEMENTIERUNGSPLAN.md` → Titel wird
   `# DeathBot-2000 — Implementierungs- und Architekturplan (v2, Stand 2026-11-14, Zwei-Saison-Modell)`.
3. **M1 (Logkanal) und M2 (Dedup/Linkqualität) bleiben im Kern wie v1** — die Scan-Log-Regel
   (keine Scan-Run-Logs im Logkanal) bleibt unangetastet.
4. **M3, M4, M5 und die Findings F07–F12** auf das Zwei-Saison-Modell anpassen:
   - M3: `seasons.phase` (`setup|announced|running|archived`), `pick_drafts` an announced-Saison gebunden,
     `celeb_review_queue.season_id` (NULL = legacy/2026), Drafts der laufenden Saison NICHT anfassen.
     Return/SQL-Änderungen an `getActiveSeason`, neue `getAnnouncedSeason`, `openAnnouncedSeason(...)`,
     `activateAnnouncedSeason(...)`, `archiveRunningSeason(...)` beschreiben.
   - M4: `canParticipate` prüft die **announced** Saison; Drafts + Finalize auf 2027; `go.js`-Guard:
     die 2027er-Review-Queue darf 2026 NICHT blockieren.
   - M5: neuer Eröffnungsablauf OHNE Wipe der laufenden Saison; der echte Wechsel am 1.1.2027
     (archivieren von 2026, Punkte/History behalten, 2027 live) muss als eigener Schritt beschrieben sein.
5. **Fragen/Entscheidungen:** Frage 12 ist entschieden (Anmeldephase JETZT). Führe dafür die NEUEN
   technischen Fragen ein, die das Zwei-Saison-Modell aufwirft (z.B. Review-Queue-Trennung,
   was passiert am 1.1.2027 mit 2026ern, wie verhindert man, dass `tryConsumePaste`/`import`
   versehentlich auf 2027 statt 2026 schreibt, Backup-Semantik).
6. **Nächste Schritte am Ende aktualisieren** — der erste Baustein bleibt M1 (Logkanal), aber M3/M4
   so, dass die 2027er-Anmeldung noch im November 2026 eröffnbar ist (priorisiere den Pfad,
   damit der Eigentümer die Anmeldung früh starten kann).

## Ausgabe

Überschreibe `IMPLEMENTIERUNGSPLAN.md` im Workspace vollständig mit v2.
Behalte die Struktur: 0) Reihenfolge, 1) Findings F01.. (an Zwei-Saison angepasst),
2) Arbeitspakete M1..M5, 3) Fallstricke, 4) offene Fragen (nummeriert, mit Empfehlung + Standard),
5) Nächste Schritte. Alle Spezifika aus AUFGABE-ZWEI-SAISON.md müssen sichtbar eingearbeitet sein.
