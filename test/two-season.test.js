const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-season-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "guild-test";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");

let config;
before(() => {
  config = loadConfig();
  db.openDb(config);
  // Test-Umgebung: die initiale Saison ist live (= running wie in Produktion)
  db.setSeasonLive(true);
  // Migration lief bereits mit live=0; phase nachziehen
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makePlayer(discordId, name) {
  return db.upsertPlayer({ displayName: name, discordUserId: discordId });
}

test("migration marks lone live season as running", () => {
  const s = db.getActiveSeason();
  assert.strictEqual(s.phase, "running", "live active season must be phase=running");
});

test("openAnnouncedSeason does not touch the running season", () => {
  const before = db.getActiveSeason();
  const celebCount = db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c;
  const pickCount = db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c;

  const { season, created } = db.openAnnouncedSeason({
    year: 2027,
    startDate: "2027-01-01",
    channelId: "999",
    note: "nächste Runde",
  });

  assert.strictEqual(created, true);
  assert.strictEqual(season.year, 2027);
  assert.strictEqual(season.active, 0);
  assert.strictEqual(season.live, 0);
  assert.strictEqual(season.phase, "announced");
  assert.strictEqual(season.announce_channel_id, "999");

  const after = db.getActiveSeason();
  assert.strictEqual(after.id, before.id, "running season id unchanged");
  assert.strictEqual(after.live, 1, "running season stays live");
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c, celebCount);
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c, pickCount);
});

test("openAnnouncedSeason same year returns created:false, no third season", () => {
  const before = db.getDb().prepare("SELECT COUNT(*) c FROM seasons WHERE phase='announced'").get().c;
  const { created } = db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "1" });
  assert.strictEqual(created, false);
  const after = db.getDb().prepare("SELECT COUNT(*) c FROM seasons WHERE phase='announced'").get().c;
  assert.strictEqual(after, before);
});

test("openAnnouncedSeason for running-year 2026 throws", () => {
  assert.throws(() =>
    db.openAnnouncedSeason({ year: db.getActiveSeason().year, startDate: "2026-01-01", channelId: "1" })
  );
});

test("draft lifecycle on announced season", () => {
  const announced = db.getAnnouncedSeason();
  assert.ok(announced, "announced season must exist");
  const p = makePlayer("7001", "Drafty");

  const draft = db.getOrCreateDraft(p.id, announced.id);
  assert.strictEqual(draft.status, "draft");

  db.addDraftNames(draft.id, ["Person A", "Person B"]);
  db.addDraftNames(draft.id, ["Person C"]);
  let entries = db.listDraftEntries(draft.id);
  assert.strictEqual(entries.length, 3);
  assert.ok(entries.every((e) => e.link_status === "pending"));

  // set one linked
  db.setDraftEntryLinked(entries[0].id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Person_A",
    wikiNorm: "en:person_a",
    qid: "Q1001",
    proposedAge: 70,
    linkStatus: "linked",
  });
  entries = db.listDraftEntries(draft.id);
  assert.strictEqual(entries[0].link_status, "linked");

  // remove
  db.removeDraftEntry(entries[1].id);
  entries = db.listDraftEntries(draft.id);
  assert.strictEqual(entries.length, 2);

  // getOrCreateDraft on running season must throw
  assert.throws(() => db.getOrCreateDraft(p.id, db.getActiveSeason().id));
});

test("finalizeDraft writes announced-season picks, keeps running picks", () => {
  const running = db.getActiveSeason();
  const announced = db.getAnnouncedSeason();
  const p = makePlayer("7002", "Finalizer");

  // running pick
  const rc = db.findOrCreateCeleb({ name: "Running Star", age: 60 });
  db.setPick(p.id, rc.celeb.id, running.id);

  const draft = db.getOrCreateDraft(p.id, announced.id);
  db.addDraftNames(draft.id, ["New Person 2027", "Another 2027"]);
  const entries = db.listDraftEntries(draft.id);
  db.setDraftEntryLinked(entries[0].id, {
    wikiUrl: "https://en.wikipedia.org/wiki/New_Person_2027",
    wikiNorm: "en:new_person_2027",
    qid: "Q2001",
    proposedAge: 55,
    linkStatus: "linked",
  });
  db.setDraftEntryLinked(entries[1].id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Another_2027",
    wikiNorm: "en:another_2027",
    proposedAge: 44,
    linkStatus: "linked",
  });

  const res = db.finalizeDraft(p.id, announced.id);
  assert.strictEqual(res.added, 2);
  // announced picks exist with age_at_pick set
  const newPicks = db
    .getDb()
    .prepare(
      `SELECT c.name, pk.age_at_pick FROM picks pk INNER JOIN celebs c ON c.id=pk.celeb_id
       WHERE pk.player_id=? AND pk.season_id=? ORDER BY c.name`
    )
    .all(p.id, announced.id);
  assert.strictEqual(newPicks.length, 2);
  assert.ok(newPicks.some((r) => r.age_at_pick === 55));
  // running pick untouched
  const runningPicks = db
    .getDb()
    .prepare("SELECT COUNT(*) c FROM picks WHERE player_id=? AND season_id=?")
    .get(p.id, running.id).c;
  assert.strictEqual(runningPicks, 1);

  // second finalize locked
  const locked = db.finalizeDraft(p.id, announced.id);
  assert.strictEqual(locked.locked, true);
});

test("finalizeDraft blocks on ambiguous entry", () => {
  const announced = db.getAnnouncedSeason();
  const p = makePlayer("7003", "Ambig");
  const draft = db.getOrCreateDraft(p.id, announced.id);
  db.addDraftNames(draft.id, ["Ambiguous Person"]);
  const e = db.listDraftEntries(draft.id)[0];
  db.setDraftEntryLinked(e.id, {
    candidates_json: JSON.stringify([{ x: 1 }, { x: 2 }]),
    linkStatus: "ambiguous",
  });
  const res = db.finalizeDraft(p.id, announced.id);
  assert.strictEqual(res.blocked, true);
});

test("activateAnnouncedSeason archives running and activates announced", () => {
  const running = db.getActiveSeason();
  const announced = db.getAnnouncedSeason();
  const p = makePlayer("7004", "Switcher");
  // base points so snapshot has content
  db.addPoints(p.id, 42);

  const res = db.activateAnnouncedSeason();
  assert.strictEqual(res.archived.id, running.id);
  assert.strictEqual(res.archived.phase, "archived");
  assert.strictEqual(res.archived.active, 0);
  assert.strictEqual(res.activated.id, announced.id);
  assert.strictEqual(res.activated.phase, "running");
  assert.strictEqual(res.activated.active, 1);
  assert.strictEqual(res.activated.live, 1);

  // snapshot recorded
  const snap = db
    .getDb()
    .prepare("SELECT * FROM season_point_snapshots WHERE season_id=? AND player_id=?")
    .get(running.id, p.id);
  assert.ok(snap, "snapshot must exist");
  assert.ok(snap.total >= 42);

  // base_points reset
  const player = db.getDb().prepare("SELECT * FROM players WHERE id=?").get(p.id);
  assert.strictEqual(player.base_points, 0);

  // getActiveSeason now returns the 2027 row
  assert.strictEqual(db.getActiveSeason().id, announced.id);
  assert.strictEqual(db.isLive(), true);
});

function replyText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  return payload.content || "";
}

test("invalid dates 01.01.2027, 2027-02-29 and 2027/01/01 write no season", async () => {
  const snap = () =>
    JSON.stringify(
      db
        .getDb()
        .prepare(
          "SELECT id, year, start_date, phase, active, live, announce_channel_id, announce_note FROM seasons ORDER BY id"
        )
        .all()
    );
  const before = snap();
  const announce = require("../src/discord/commands/announce-season");
  const seasonCmd = require("../src/discord/commands/season");
  const newYear = require("../src/discord/commands/new-year");
  const replies = [];
  const msg = {
    mentions: { channels: { first: () => null } },
    author: { id: "1" },
    async reply(t) {
      replies.push(replyText(t));
    },
  };
  const ctx = {
    config,
    client: {
      channels: {
        fetch: async () => {
          throw new Error("fetch must not run for a rejected date");
        },
      },
    },
  };
  for (const d of ["01.01.2027", "2027-02-29", "2027/01/01"]) {
    await announce.run(ctx, ["channel:should-not", `start:${d}`, "year:2035"], msg);
    await seasonCmd.run(ctx, [d], msg);
    await newYear.run(ctx, ["wipe", d], msg);
  }
  assert.strictEqual(snap(), before);
  assert.ok(
    replies.every((r) => r.includes("Datum muss YYYY-MM-DD sein, und es muss ein echtes Kalenderdatum sein.")),
    replies.join(" | ")
  );
});

test("running season keeps its start date and answers with the setup-only guard", async () => {
  const start = db.getActiveSeason().start_date;
  const replies = [];
  const seasonCmd = require("../src/discord/commands/season");
  await seasonCmd.run({ config, client: {} }, ["2028-03-01"], {
    async reply(t) {
      replies.push(replyText(t));
    },
  });
  assert.strictEqual(
    replies.join("\n"),
    "Das Startdatum der laufenden Saison ist fest. Das nächste Datum setzt `/announce-season`. Dieser Befehl gilt nur in der Setup-Phase."
  );
  assert.strictEqual(db.getActiveSeason().start_date, start);
});

test("announce embed appends the death line and keeps the tariff", () => {
  const { buildSeasonEmbed, DEFAULT_ANNOUNCE_TEMPLATE } = require("../src/discord/commands/announce-season");
  assert.match(DEFAULT_ANNOUNCE_TEMPLATE, /\{START_DATE\}/);
  assert.match(DEFAULT_ANNOUNCE_TEMPLATE, /unbekanntem Alter[\s\S]*0 Punkte/);
  const embed = buildSeasonEmbed({
    year: 2031,
    startDate: "2031-01-01",
    runningYear: 2030,
    maxPicks: 50,
  });
  assert.ok(
    embed.data.description.includes(
      "Die Zeit des Todes naht. Deine Namen ändern daran nichts. Sie ändern nur, wer neben der Leiche steht."
    )
  );
});

test("ungo completion 50027 leaves the season paused", async () => {
  assert.strictEqual(db.getAnnouncedSeason(), null);
  db.setSeasonLive(true);
  const wikiPollPath = require.resolve("../src/jobs/wiki-poll");
  const prev = require.cache[wikiPollPath];
  require.cache[wikiPollPath] = {
    id: wikiPollPath,
    filename: wikiPollPath,
    loaded: true,
    exports: { runWikiPoll: async () => ({ hits: [] }) },
  };
  const ungoPath = require.resolve("../src/discord/commands/ungo");
  delete require.cache[ungoPath];
  const ungo = require(ungoPath);
  let n = 0;
  try {
    await ungo.run(
      { config, client: { channels: { fetch: async () => null } } },
      ["confirm"],
      {
        author: { id: "1" },
        async reply() {
          n += 1;
          if (n >= 3) {
            const err = new Error("Invalid Webhook Token");
            err.code = 50027;
            throw err;
          }
        },
      }
    );
    assert.strictEqual(db.isLive(), false);
    assert.ok(n >= 3);
  } finally {
    if (prev) require.cache[wikiPollPath] = prev;
    else delete require.cache[wikiPollPath];
  }
});

test("wipe throw in clearSeasonForNewYear leaves picks and new-year.js has no DELETE FROM picks", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/discord/commands/new-year.js"), "utf8");
  assert.doesNotMatch(src, /DELETE\s+FROM\s+picks/);
  assert.doesNotMatch(src, /activateAnnouncedSeason/);

  db.getDb().prepare("UPDATE seasons SET phase = 'archived' WHERE phase = 'announced'").run();
  db.getDb().prepare("UPDATE seasons SET phase = 'setup', live = 0 WHERE active = 1").run();
  const picksBefore = db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c;
  assert.ok(picksBefore > 0);

  const orig = db.clearSeasonForNewYear;
  let called = 0;
  db.clearSeasonForNewYear = () => {
    called += 1;
    throw new Error("wipe boom");
  };
  const newYearPath = require.resolve("../src/discord/commands/new-year");
  delete require.cache[newYearPath];
  const newYear = require(newYearPath);
  try {
    await assert.rejects(
      () =>
        newYear.run(
          { config, client: { channels: { fetch: async () => null } } },
          ["wipe"],
          { author: { id: "1" }, async reply() {} }
        ),
      /wipe boom/
    );
  } finally {
    db.clearSeasonForNewYear = orig;
  }
  assert.strictEqual(called, 1);
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c, picksBefore);
});
