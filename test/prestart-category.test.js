const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-prestart-cat-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const {
  findAnnouncedDeathsByCategory,
  findPoolDeathsByCategory,
} = require("../src/wiki/category-death");

let config;
before(() => {
  config = loadConfig();
  db.openDb(config);
  db.setSeasonLive(true);
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Mock the MediaWiki API (both EN/DE) so checkUrlDead reports a death category.
const realCreate = axios.create;
after(() => {
  axios.create = realCreate;
});

function mockDeathCategories(deadUrlContains) {
  axios.create = () => ({
    async get(url, { params } = {}) {
      if (params?.action === "query" && params?.prop === "categories") {
        const titles = String(params.titles || "");
        // parseWikiUrl turns wiki_url into { title: "Announced Only" } (space,
        // decoded) and passes it as titles= to the API.
        const dead =
          !deadUrlContains || titles.includes("Announced_Only") || titles.includes("Announced Only");
        return {
          status: 200,
          data: {
            query: {
              pages: {
                1: dead
                  ? { title: "Announced Only", categories: [{ title: "Category:2026 deaths" }] }
                  : { title: "Announced Only", categories: [{ title: "Category:2026 births" }] },
              },
            },
          },
        };
      }
      if (params?.action === "query" && params?.prop === "revisions") {
        return { status: 200, data: { query: { pages: [] } } };
      }
      return { status: 200, data: {} };
    },
  });
}

test("F14c: category hit without a death-list entry marks announced celeb dead → warnable", async () => {
  db.openAnnouncedSeason({
    year: 2027,
    startDate: "2027-01-01",
    channelId: "777",
    note: null,
  });
  const season = db.getAnnouncedSeason();
  assert.ok(season);

  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('CatPick','660','0')")
    .run().lastInsertRowid;

  // 2027-only celeb: wiki_confirmed=1, exclude_from_auto=1 (not in auto pool),
  // picked in the announced season only. No death-list entry exists (via
  // "category" — this simulates the person NOT being on the scraped lists).
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         wiki_confirmed, exclude_from_auto, manual_only)
       VALUES ('Announced Only','announcedonly','https://en.wikipedia.org/wiki/Announced_Only','QAnn',1,
         1, 1, 0)`
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, season.id);

  // Sanity: the auto sweep would NOT see this celeb (exclude_from_auto=1).
  assert.ok(
    !db.getAliveCelebsForAuto().some((c) => c.id === cid),
    "announced celeb must not be in the auto pool"
  );
  assert.ok(
    db.getAliveCelebsForAnnounced().some((c) => c.id === cid),
    "announced celeb must be in getAliveCelebsForAnnounced"
  );

  mockDeathCategories("en.wikipedia.org/wiki/Announced_Only");

  const hits = await findAnnouncedDeathsByCategory("test-user-agent", { delayMs: 0 });
  const mine = hits.find((h) => h.celeb.id === cid);
  assert.ok(mine, "category sweep must catch the announced celeb");
  assert.strictEqual(mine.via, "category");
  assert.strictEqual(mine.announced, true);
  // is_alive is untouched by the scanner itself (applyDeath does the marking) —
  // it reports the celeb snapshot from getAliveCelebsForAnnounced.
  assert.strictEqual(mine.celeb.is_alive, 1);

  // Now apply the hit with announce:false (what the poller does).
  const { processDeathpoolHit } = require("../src/discord/announce");
  const fakeClient = { channels: { fetch: async () => null } };
  const result = await processDeathpoolHit(
    fakeClient,
    { channelDeathpool: "1", userAgent: "test" },
    { celeb: mine.celeb, entry: mine.entry, wikiAge: mine.age },
    { announce: false, confirmed: false, source: "announced-prestart" }
  );
  assert.strictEqual(result.celeb.is_alive, 0, "category death must set is_alive=0");
  // Der Pick liegt in der ANNOUNCED-Saison, applyDeath bedient die AKTIVE Saison –
  // daher keine activen Winner → keine Awards, keine Punkte (R2-8-Semantik).
  assert.strictEqual(result.awards.length, 0, "2027-only pick must award nothing active");
  assert.strictEqual(result.score, 0);

  // The picker should now be warnable: died_at was stored as the detection day
  // here (no scraped date on a category synthetic entry) and the announced
  // season detects pre-start via died_at < start OR detection < start.
  const rows = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(
    rows.some((r) => r.celeb_id === cid),
    "category-marked dead must be warnable via pick_death_warnings"
  );
});

test("F24: category-year before running season → 0 points + warnable, no awards, no active pick points", async () => {
  // Laufende Saison: start_date aus der DB (hier initial 01.01. des Jahres,
  // live=1/running durch before()). Ein 2024-deaths-Kategorie-Fund, der im
  // Dezember erkannt wird, darf in der laufenden Saison KEINE Punkte geben —
  // applyDeath muss über den preStart-Zweig (0 Punkte) laufen, weil das
  // Kategorie-Jahr (2024-12-31) vor dem Saisonstart liegt.
  const active = db.getActiveSeason();
  assert.ok(active && Number(active.live) === 1, "running season must be live");

  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F24Pick','6241','10')")
    .run().lastInsertRowid;

  // Celeb ohne exclude_from_auto (also auch im Auto-Pool denkbar), gestorben
  // 2024 — Kategorie-Fund passiert im announced/category-Lauf.
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         wiki_confirmed, exclude_from_auto, manual_only)
       VALUES ('Old Corpse','oldcorpse','https://en.wikipedia.org/wiki/Old_Corpse','QOld',1,
         1, 0, 0)`
    )
    .run().lastInsertRowid;
  // Pick in der LAUFENDEN (aktiven) Saison — der Fehl-Fall aus F24: hier
  // wurden vorher fälschlich Punkte vergeben, weil diedAt auf den
  // Erkennungstag fiel und der nach dem Saisonstart lag.
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, active.id);
  // UND ein Pick in der announced-Saison: nur so sieht der announced-Lauf den
  // Celeb (getAliveCelebsForAnnounced), und der Kategorie-Entry wandert mit dem
  // Kategorie-Jahr in applyDeath (F24a).
  const ann = db.getAnnouncedSeason();
  assert.ok(ann, "announced season from earlier test");
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, ann.id);

  // Kategorie „2024 deaths“ simulieren (erkannter Tod im Dezember 2026).
  mockDeathCategoriesByYear(cid, "https://en.wikipedia.org/wiki/Old_Corpse", 2024);

  const hits = await findAnnouncedDeathsByCategory("test-user-agent", { delayMs: 0 });
  const mine = hits.find((h) => h.celeb.id === cid);
  assert.ok(mine, "announced sweep must catch the old-category celeb");
  // F24a: Das Kategorie-Jahr ist am Entry gesetzt → entryDeathDateIso liefert
  // „2024-12-31“ (month 0-basiert), NICHT den Erkennungstag.
  const { entryDeathDateIso } = require("../src/discord/announce");
  assert.strictEqual(entryDeathDateIso(mine.entry), "2024-12-31");
  assert.strictEqual(mine.entry.year, 2024);

  const { processDeathpoolHit } = require("../src/discord/announce");
  const fakeClient = { channels: { fetch: async () => null } };
  const result = await processDeathpoolHit(
    fakeClient,
    { channelDeathpool: "1", userAgent: "test" },
    { celeb: mine.celeb, entry: mine.entry, wikiAge: mine.age },
    { announce: false, confirmed: false, source: "announced-prestart" }
  );
  assert.strictEqual(result.celeb.is_alive, 0, "death must be recorded");
  assert.strictEqual(result.celeb.died_at, "2024-12-31", "died_at must carry category year");
  // preStart → kein Award (keine DB-Gutschrift, keine Zeile), Winner bleibt
  // im Result mit 0 Punkten.
  assert.strictEqual(
    db.getDb()
      .prepare("SELECT COUNT(*) c FROM death_awards WHERE celeb_id = ? AND season_id = ?")
      .get(cid, active.id).c,
    0,
    "no death_award row for a pre-start category death"
  );
  assert.strictEqual(result.awards.length, 1, "winner returned with 0 points");
  assert.strictEqual(result.awards[0].points, 0, "0 points for pre-start death");
  assert.strictEqual(result.score, 0);
  // Spieler-Kontostand unverändert (10 Basis), keine Gutschrift.
  const p = db.getDb().prepare("SELECT * FROM players WHERE id = ?").get(pid);
  assert.strictEqual(Number(p.base_points), 10);
  // F24b: Der preStart-Tod wird NUR gewarnt — der Einreicher muss die DM
  // bekommen (died_at 2024-12-31 < announced-start 2027-01-01).
  const warnRows = db.getAnnouncedPreStartDeathsUnwarned(ann.id);
  assert.ok(
    warnRows.some((r) => r.celeb_id === cid),
    "pre-start category death must be warnable via pick_death_warnings"
  );
});

test("F24: warn predicate is strict < start_date (no warn at exactly season start)", () => {
  const season = db.getAnnouncedSeason();
  assert.ok(season, "announced season from earlier test");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('StartExact','6242','0')")
    .run().lastInsertRowid;
  // Gestorben EXAKT am Saisonstart (start 2027-01-01 → died_at 2027-01-01).
  // Punktesperre: diedAt < start → NICHT vor-Start. Warnung: died_at < start
  // → also keine Warn-DM. Beide Prädikate konsistent (F24c).
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         died_at, death_detected_at, death_confirmed, wiki_confirmed)
       VALUES ('StartExact','startexact','https://en.wikipedia.org/wiki/StartExact','QStartEx',
         0, '2027-01-01', '2027-01-01 00:30:00', 0, 1)`
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, season.id);
  const rows = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(
    !rows.some((r) => r.celeb_id === cid),
    "death exactly at season start must NOT trigger the pre-start warning DM"
  );

  // Kontrolle: einen Tag vorher (2026-12-31) wird weiterhin gewarnt.
  const beforeStart = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         died_at, death_detected_at, death_confirmed, wiki_confirmed)
       VALUES ('BeforeStart','beforestart','https://en.wikipedia.org/wiki/BeforeStart','QBs',
         0, '2026-12-31', '2027-01-01 06:00:00', 0, 1)`
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, beforeStart, season.id);
  const rows2 = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(
    rows2.some((r) => r.celeb_id === beforeStart),
    "death one day before season start must still warn"
  );
});

// F24-Testhilfe: Kategorie-Jahr parametrisierbar machen (statt fix 2026).
function mockDeathCategoriesByYear(celebId, url, year) {
  axios.create = () => ({
    async get(requestUrl, { params } = {}) {
      if (params?.action === "query" && params?.prop === "categories") {
        const titles = String(params.titles || "");
        const isTarget = titles.includes(
          String(url).split("/wiki/")[1].replace(/_/g, " ")
        );
        return {
          status: 200,
          data: {
            query: {
              pages: {
                1: isTarget
                  ? { title: "Old Corpse", categories: [{ title: `Category:${year} deaths` }] }
                  : { title: "Other", categories: [{ title: "Category:2026 births" }] },
              },
            },
          },
        };
      }
      if (params?.action === "query" && params?.prop === "revisions") {
        return { status: 200, data: { query: { pages: [] } } };
      }
      return { status: 200, data: {} };
    },
  });
}

test("F14c: auto sweep still ignores announced-only celebs (no false pool hits)", async () => {
  mockDeathCategories("en.wikipedia.org/wiki/Announced_Only");
  const hits = await findPoolDeathsByCategory("test-user-agent", { delayMs: 0 });
  assert.ok(
    !hits.some((h) => h.celeb.name === "Announced Only"),
    "exclude_from_auto=1 celeb must NOT appear in the auto category sweep"
  );
});

test("F27: unknown age on a real hit prints 'Alter unbekannt' (no misleading 0-Punkte sentence)", async () => {
  const active = db.getActiveSeason();
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('NoAge','6629','0')")
    .run().lastInsertRowid;
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         wiki_confirmed, exclude_from_auto, manual_only)
       VALUES ('NoAgeCeleb','noageceleb','https://en.wikipedia.org/wiki/NoAgeCeleb','QNoAge',1,
         1, 1, 0)`
    )
    .run().lastInsertRowid;
  const ann = db.getAnnouncedSeason();
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, ann.id);

  mockDeathCategoriesByYear(cid, "https://en.wikipedia.org/wiki/NoAgeCeleb", ann.year);
  const hits = await findAnnouncedDeathsByCategory("test-user-agent", { delayMs: 0 });
  const mine = hits.find((h) => h.celeb.id === cid);
  assert.ok(mine, "category sweep must find no-age celeb");

  const sent = [];
  const channel = { isTextBased: () => true, send: async (m) => sent.push(m) };
  const fakeClient = { channels: { fetch: async () => channel } };
  const { processDeathpoolHit } = require("../src/discord/announce");
  await processDeathpoolHit(
    fakeClient,
    { channelDeathpool: "1", userAgent: "test", alertEmojiRepeat: 1, alertEmoji: "💀" },
    { celeb: mine.celeb, entry: mine.entry, wikiAge: mine.age },
    { announce: true, confirmed: false, source: "announced-prestart" }
  );
  assert.strictEqual(sent.length, 1, "announce must be posted");
  const details = sent[0].embeds[0].data.fields.find((f) => f.name === "Details").value;
  assert.match(details, /Alter unbekannt/, "unknown age must be called out");
  assert.doesNotMatch(details, /0 Punkte/, "no misleading 0-Punkte hint for unknown age");
});
