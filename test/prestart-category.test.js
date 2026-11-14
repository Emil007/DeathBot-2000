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

test("F14c: auto sweep still ignores announced-only celebs (no false pool hits)", async () => {
  mockDeathCategories("en.wikipedia.org/wiki/Announced_Only");
  const hits = await findPoolDeathsByCategory("test-user-agent", { delayMs: 0 });
  assert.ok(
    !hits.some((h) => h.celeb.name === "Announced Only"),
    "exclude_from_auto=1 celeb must NOT appear in the auto category sweep"
  );
});
