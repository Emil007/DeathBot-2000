# DeathBot-2000: Live-DB-Analyse (2026-11-14, DB von NAS)

## Kontext
- Aktive Saison: 2026, start_date 2026-01-01, live=1
- Spieler: Emil007 (203P), guardtristan (0P), jw202 (15P)
- announced_deaths gesamt: 14.456 | letzte 14 Tage: 704 | wiki_seen: en 9.508 / de 4.954

## Duplikate (30-Tage-Fenster, gleiche Person, oft DIFFERENTE URLs)
1. **Thomas Rudy** (de,de) — 2×
2. **Michał Oksiński** (de,de) — 2×
3. **Josef Mašín** (en,en) + **Josef Mašín jun.** (de,de) — 4 Karten für EINE Person
4. **James Pavatt** (en,en) — 2×
5. **Danny Watson** (en,en) — 2×
6. **Choi Hyung-woo [ko]** (en,en) — 2×

## Konkrete Doppel/Trim letzte 7 Tage (aus Sample von 60 Karten)
- **Young L** 3×: `de:The_Pack_(Band)` (15:21:36) + `en:The_Pack_(group)` (15:21:34) + eigene Personenseite `en:Young_L` (03:29:20) → Band-Seiten wurden als Karte gepostet (redName-Fall), obwohl eine Personenseite existiert.
- **Peter Antony Moran** (de 17:51) + **Peter Moran** (en 17:21) — gleiche Person (bishop of Aberdeen).
- **Herb Grubel** (en 06:44) + **Herbert Grubel** (de 10:44).
- **Claudette Soares [pt]** (15:51) + **Claudete Soares [pt]** (15:36) — Rechtschreibvariante derselben Person.
- **Christian Cousins** (en 18:36, eigene Seite) + (de 13:51, `Christian_und_Joseph_Cousins` Zwillinge-Sammelseite).
- **Masaaki Yamazaki** (de 06:59 + en 05:14).
- **Vyacheslav Briukhovetskyi** (en) + **Wjatscheslaw Brjuchowezkyj** (de) — DE+EN für gleiche Person trotz DE→EN-Brücke.
- **Karl Johan Åström** (de + en bei 20-21 Uhr) — DE+EN-Paar kurz hintereinander.

## Strukturelle Beobachtungen
- EN-URL-Varianten gleicher Person: `Brian_Tracy`, `Peter_Moran_(bishop)` vs `Peter_Antony_Moran`.
- Karten tragen Interlanguage-Suffixe im Namen: `Claudette Soares [pt]`, `Choi Hyung-woo [ko]`, `Jan Pijnenburg [nl]`.
- Die DE-Karte "Young L … The_Pack_(Band)" ist ein redName-Fall, der fälschlich eine eigene Karte bekam.

## Offene Fragen an Grok
1. Dedup zuverlässig "gleiche Person, andere Schreibweise/Seite" VOR dem Posten quer über EN/DE + Transliterationen?
2. Verhindern, dass Band/Org-Sammelseiten (redName) als Karte gepostet werden, wenn eine Personenseite existiert?
3. Wann sollen DE+EN BEIDE gepostet werden, wann reicht EN (Wann ist DE-only korrekt)?
