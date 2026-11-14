Du bist der unabhängige Code-Reviewer für DeathBot-2000 (Node 20, discord.js 14, better-sqlite3,
Docker auf WD-NAS, Repo github.com/Emil007/DeathBot-2000, Bot "Gregg#0124").

## Kontext

Vor dir liegt `scratch/grok-review/` mit:
- dem kompletten Quellcode (`src/`, `test/`, `scripts/`, `package.json`, `README.md`) und
- `IMPLEMENTIERUNGSPLAN.md` — dem Plan v2 (Stand 2026-11-14, Zwei-Saison-Modell), den ich erstellt habe.

Seit Plan v2 wurden die Arbeitspakete **M1, M3, M4, M5, M2** von DeepSeek implementiert (alle Tests grün).
Deine Aufgabe: **harter Bugs- und Entwurfs-Check des implementierten Codes gegen den Plan.**

## Fokus-Bereiche (prüfe jeden gegen den Plan und den echten Code)

1. **Zwei-Saison-Logik (M3/M5)** — `src/db/index.js`, `src/db/schema.js`:
   - `getActiveSeason` vs `getAnnouncedSeason` — nirgends vertauschen.
   - `openAnnouncedSeason` (keine zweite announced, kein Re-Open von archived/running).
   - `activateAnnouncedSeason` (Snapshot, archiveRunning, exclude-flip nur 2027-only, base_points=0) —
     insbesondere: Transaktions-Sicherheit, korrekte `season_id` bei `death_awards`.
   - `assertWipeAllowed` / `assertActivateDateAllowed` in `new-year.js`.
2. **Tipp-Assistent (M4)** — `pick-assistant.js`, `membership.js`, `pick-parse.js`, `commands/picks.js`:
   - `canParticipate`: nur announced-Saison, ViewChannel, Admin-Fallback. Race/Security-Lücken?
   - `finalizeDraft` (db) — schreibt nur in picks der announced-Saison, blockt bei ambiguous/pending,
     Review nur für neue/unbestätigte Celebs.
   - DM-Handling: kein konsumieren von Guild-Nachrichten, keine Endlosschleifen.
3. **Logkanal (M1)** — `log.js`: Scan-Logs nie in den Kanal, Failsafe ohne Kanal, Queue, scrub.
4. **Dedup/Linkqualität (M2)** — `announce-dedup.js`, `wiki-poll.js`-Einbindung, `scraper-en/de.js`,
   `death-brief.js`, `announce.js`:
   - `planAnnouncements` Regeln 1–5 gegen den Plan (insbesondere: keine echten Tote verschlucken,
     Verlierer nur nach Gewinner-announced_at stempeln, idempotent).
   - Zusammenwirken mit dem bestehenden `deferredDeEn`-Mechanismus.
5. **Ablauf/Integration** — `index.js`, `celeb-review.js` (non-crev-Gate), `go/ungo/review/import`.

## Prüf-Fragen je Befund

gib pro Befund: **Datei:Zeile**, Schweregrad (kritisch/hoch/mittel/niedrig), konkrete Wurzel,
und einen präzisen Fix-Vorschlag (mit konkretem Code). Verifiziere Befunde am echten Code —
keine generischen Muster, kein Aufblähen. Drei Kategorien:

- FEHLER (verletzt Plan oder Logik; erkläre die konkrete Fehlwirkung)
- VERBESSERUNG (Edge-Case, Robustheit, Migration, Rate-Limit, Ack-Fenster)
- UNKLAR (nachfragen, was gemeint ist; nur wenn wirklich nötig)

## Ausgabe

Schreibe `scratch/grok-review/REVIEW.md` mit:
1. Zusammenfassung (Anzahl je Kategorie).
2. Findings F.. sortiert nach Schweregrad, ohne Duplikate.
3. Am Ende: „MUSS vor Deploy gefixt werden“-Liste (nur kritisch/hoch).
