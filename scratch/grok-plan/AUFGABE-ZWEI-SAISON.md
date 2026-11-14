# AUFGABE: Zwei parallele Saisons — Anmeldephase 2027 JETZT eröffnen

## Klärung zu Frage 12 (Entscheidung des Eigentümers, 2026-11-14)

Der Eigentümer **widerspricht** Frage-12-Default ("nicht in 2026 öffnen"). Sein Modell:

- **Saison 2026 läuft WEITER LIVE** (Start 2026-01-01, live=1) bis 31.12.2026:
  Deathpool-Hits, Punkte, Rücksetzungen, Tagesbericht, All-Deaths — ALLES wie bisher, unverändert.
- **Saison 2027 (neue Runde) wird JETZT (November 2026) eröffnet** im Setup-Modus (live=0):
  - Der Admin ruft einen Befehl auf, gibt `announce_channel` an, der Bot posted das Teilnahme-Embed.
  - **Von jetzt an bis Ende Dezember 2026** können alle, die ViewChannel auf den Announce-Kanal haben, per DM ihre Tipps abgeben (Tipp-Assistent aus Paket C).
  - Am **01.01.2027** wird Saison 2027 live geschaltet (der 2026er-Status wird abgeschlossen/archiviert, ohne Datenverlust; die zuvor gesammelten 2027er-Picks bleiben).

## Was das für den Plan ändert

Der bestehende Plan (v1) geht von einer einzigen "aktiven" Saison aus und `/new-year` wischt die alte weg,
bevor die neue angelegt wird. Das passt NICHT zum obigen Modell. Notwendige Anpassungen in M1–M5
(der SQL/DB-Teil aus M3 und die Grundstruktur aus M4/M5 bleiben die Basis, aber die Semantik wird Zwei-Saison):

### 1. Datenmodell / Schema (betrifft M3)
- `seasons` bekommt zusätzlich eine Phase-Abkürzung ODER der Code führt klare Begriffe ein:
  `running` (2026, live=1) vs `announced` (2027, live=0). Vorschlag: Spalte `phase TEXT DEFAULT 'setup'`
  mit Werten `setup` | `announced` | `running` | `archived`. Migration additiv und nullable wie üblich.
  - `active` bleibt der Zeiger auf "was gerade zählt für Scoring/Kills" (2026).
  - Die **kommende** Saison wird über `phase='announced'` gefunden, nicht über `active`.
- `pick_drafts` binden an die **announced** Saison (2027) — NICHT an die laufende.
- Wichtiger Konflikt: `celeb_review_queue` ist heute GLOBAL (eine Queue, `celeb_id UNIQUE`).
  Die 2026er-Deaths/Review und die 2027er-Tipps teilen sich sonst dieselbe Warteschlange.
  Lösung: neue Spalte `season_id INTEGER NULL` an `celeb_review_queue`, alte Einträge bleiben NULL,
  `/review` (Admin) arbeitet die 2027er-Queue ab; die 2026er-Auto-Kills laufen OHNE Review-Queue (wie heute,
  sie sind ja schon bestätigte/wikibestätigte Celebs aus 2026). Prüfe `go.js`-Guard
  (`countPendingReviews`: darf die 2027er-Queue nicht blockieren, solange 2026 noch live ist).

### 2. Saison-Eröffnung / Announce (betrifft M4/M5)
- Neuer Befehl ODER erweiterter `/new-year`: Der Admin eröffnet JETZT die kommende Saison.
  Erforderlich:
  - Die 2026er-Saison wird **nicht** angetastet (kein Wipe, kein Löschen von Celebs/Picks/Score).
  - Es wird eine **neue** Saison-Zeile (2027, live=0, phase=announced) angelegt, falls nicht vorhanden.
  - `announce_channel` + optionale `note` werden gespeichert.
  - Teilnahme-Embed wird im Kanal gepostet (gleicher Embed-Text wie in M5 v1).
  - `repost` funktioniert wie gehabt (Embed erneut posten ohne irgendwas zu löschen).
- Der bestehende destruktive Wipe-Pfad (`/new-year confirm`, der Celebs/Picks löscht) wird **ab jetzt NICHT** mehr
  als normale Saisoneröffnung benutzt. Erst beim finalen Saisonwechsel (01.01.2027 oder wenn der Admin
  entscheidet) wird archiviert. Für heute: Der neue Eröffnungsbefehl ist die Saisoneröffnung.
  (Es darf weiterhin eine Admin-Funktion geben, die alte Saison hart zu beenden — aber dann mit klar getrennter
   Archivierungs-Logik; der Plan soll beschreiben, wo der 2026er-Abschluss am 1.1. passiert, Zähler übertragen.)

### 3. Tipp-Assistent (betrifft M4)
- `canParticipate` prüft gegen die **announced** Saison (2027): Kanal vorhanden + `live = 0` + ViewChannel.
- `getOrCreateDraft` bindet an die announced Saison.
- `finalizeDraft` legt Picks der **announced** Saison an (season_id = 2027) — via `findOrCreateCeleb`
  genau wie v1, aber auf der kommenden Saison.
- Alter/Punkte: Saisonstart für die Alter-Berechnung ist `2027-01-01` (`start_date` der announced Saison).
- Die 2026er-Saison bleibt vom Assistenten komplett unberührt.

### 4. Logkanal (M1) bleibt wie geplant — nur zusätzlich Ereignisse für "Saison 2027 eröffnet", "Tipp eingegangen (2027)" usw.

## Geforderte Ausgabe

Überarbeite `IMPLEMENTIERUNGSPLAN.md` IN-PLACE (im Workspace) zu **v2 „Zwei parallele Saisons"**:

- Markiere den Stand: `# DeathBot-2000 — Implementierungs- und Architekturplan (v2, Stand 2026-11-14, Zwei-Saison-Modell)`.
- Erhalte die M1/M2-Struktur (Logkanal + Dedup/Linkqualität) im Kern, keine Scan-Log-Regel ändern.
- Passe M3, M4, M5 und die Findings F07/F08/F09-F12 sowie die Fragen/Entscheidungen für die Zwei-Saison-Semantik an.
- Entferne/ersetze Frage 12 durch den jetzt entschiedenen Stand (Anmeldephase JETZT für 2027, 2026 läuft weiter),
  und führe alle NEUEN technischen Fragen ein, die sich aus dem Zwei-Saison-Modell ergeben
  (z.B. "Wie wird 2026 am 1.1.2027 abgeschlossen?", "Review-Queue-Trennung", "Draft-Saison-Referenz").
- Am Ende: „Nächste Schritte" aktualisieren. Der allererste Baustein für den Eigentümer ist weiterhin M1 (Logkanal),
  aber M3/M4 müssen so gebaut werden, dass die 2027er-Anmeldung JETZT (noch im November 2026) eröffnbar ist.
