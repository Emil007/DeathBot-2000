const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-m15-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const liste = require("../src/discord/commands/liste");
const celebs = require("../src/discord/commands/celebs");
const celeb = require("../src/discord/commands/celeb");
const scores = require("../src/discord/commands/scores");
const players = require("../src/discord/commands/players");
const addPoints = require("../src/discord/commands/add-points");
const setPoints = require("../src/discord/commands/set-points");
const { normalizeWikiUrl } = require("../src/wiki/page-lookup");

const SNOW = "100000000000000001";
const SNOW_B = "100000000000000002";
const AUTHOR = "100000000000000009";

function capture(authorId, mentionId) {
  const payloads = [];
  const sink = async (payload) => {
    payloads.push(payload);
  };
  const msg = {
    author: { id: String(authorId) },
    mentions: {
      users: {
        first() {
          return mentionId ? { id: String(mentionId) } : null;
        },
      },
    },
    channel: { send: sink },
    reply: sink,
  };
  return {
    msg,
    payloads,
    text() {
      return payloads.map((p) => (typeof p === "string" ? p : p.content)).join("\n");
    },
  };
}

function assertMentions(payloads) {
  assert.ok(payloads.length > 0, "expected at least one send");
  for (const p of payloads) {
    assert.deepStrictEqual(p.allowedMentions, { parse: [] });
  }
}

function rate429(message) {
  const err = new Error(message || "429 rate limit");
  err.status = 429;
  return err;
}

function chunkHarness(failContent, failures) {
  const attempts = [];
  const sent = [];
  const state = { left: failures };
  const sink = async (payload) => {
    assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
    attempts.push(payload.content);
    if (payload.content === failContent && state.left > 0) {
      state.left -= 1;
      throw rate429("429");
    }
    sent.push(payload.content);
  };
  return {
    attempts,
    sent,
    msg: { reply: sink, channel: { send: sink } },
  };
}

function clearPlayers() {
  db.getDb().exec(`
    DELETE FROM death_awards;
    DELETE FROM pick_death_warnings;
    DELETE FROM player_bonuses;
    DELETE FROM picks;
    DELETE FROM pick_draft_entries;
    DELETE FROM pick_drafts;
    DELETE FROM season_point_snapshots;
    DELETE FROM players;
  `);
}

describe("M15 lists and chunks", { concurrency: false }, () => {
  let config;
  let ctx;

  before(() => {
    config = loadConfig();
    db.openDb(config);
    ctx = {
      config,
      client: {
        users: {
          fetch: async () => {
            throw new Error("users.fetch must not run for points");
          },
        },
      },
    };
  });

  after(() => {
    try {
      db.closeDb();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("chunk 2 fails both 429 attempts, chunk 3 still goes out, text names Seite 2", async () => {
    const h = chunkHarness("PAGE-2", 2);
    await liste.sendChunks(h.msg, ["PAGE-1", "PAGE-2", "PAGE-3"]);
    assert.deepStrictEqual(h.sent, [
      "PAGE-1",
      "PAGE-3",
      "Seite 2 ist nicht raus (Discord-Limit).",
    ]);
    assert.ok(h.sent.some((c) => c.includes("Seite 2")));
    assert.strictEqual(h.attempts.filter((c) => c === "PAGE-2").length, 2);
  });

  test("worst case: second chunk throws, third is sent, send order is counted", async () => {
    const h = chunkHarness("PAGE-2", 2);
    const started = Date.now();
    await liste.sendChunks(h.msg, ["PAGE-1", "PAGE-2", "PAGE-3"]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1800, `expected the 2s 429 pause, took ${elapsed}ms`);
    assert.deepStrictEqual(h.attempts, [
      "PAGE-1",
      "PAGE-2",
      "PAGE-2",
      "PAGE-3",
      "Seite 2 ist nicht raus (Discord-Limit).",
    ]);
    const i1 = h.attempts.indexOf("PAGE-1");
    const i2 = h.attempts.indexOf("PAGE-2");
    const i3 = h.attempts.indexOf("PAGE-3");
    const note = h.attempts.findIndex((c) => c.includes("Seite 2"));
    assert.ok(i1 < i2 && i2 < i3 && i3 < note);
    assert.ok(!h.sent.includes("PAGE-2"));
    assert.strictEqual(h.sent[0], "PAGE-1");
    assert.strictEqual(h.sent[1], "PAGE-3");
  });

  test("findPlayerByQuery('%') is null, snowflake hits, add-points does not write on %", async () => {
    clearPlayers();
    const player = db.upsertPlayer({ displayName: "%", discordUserId: SNOW });
    assert.strictEqual(db.findPlayerByQuery("%"), null);
    const found = db.findPlayerByQuery(SNOW);
    assert.ok(found);
    assert.strictEqual(String(found.discord_user_id), SNOW);
    assert.strictEqual(found.id, player.id);

    const origAdd = db.addPoints;
    let adds = 0;
    db.addPoints = (id, pts) => {
      adds += 1;
      return origAdd(id, pts);
    };
    try {
      const denied = capture(AUTHOR);
      await addPoints.run(ctx, ["%", "25"], denied.msg);
      assert.strictEqual(adds, 0);
      assert.strictEqual(
        db.getDb().prepare("SELECT base_points AS p FROM players WHERE id = ?").get(player.id).p,
        0
      );
      assert.strictEqual(denied.text(), liste.NEED_MENTION);
      assertMentions(denied.payloads);

      const named = capture(AUTHOR);
      await addPoints.run(ctx, ["PercentUser", "9"], named.msg);
      assert.strictEqual(adds, 0);
      assert.strictEqual(named.text(), liste.NEED_MENTION);

      const granted = capture(AUTHOR);
      await addPoints.run(ctx, [SNOW, "25"], granted.msg);
      assert.strictEqual(adds, 1);
      assert.strictEqual(
        db.getDb().prepare("SELECT base_points AS p FROM players WHERE id = ?").get(player.id).p,
        25
      );
      assert.match(granted.text(), /\*\*25\*\*/);
      assert.doesNotMatch(granted.text(), /@/);
      assertMentions(granted.payloads);

      const missing = capture(AUTHOR);
      await addPoints.run(ctx, ["555555555555555555", "9"], missing.msg);
      assert.strictEqual(adds, 1);
      assert.match(missing.text(), /Spieler nicht gefunden/);
      assert.strictEqual(
        db.getDb().prepare("SELECT base_points AS p FROM players WHERE id = ?").get(player.id).p,
        25
      );
    } finally {
      db.addPoints = origAdd;
    }
  });

  test("set-points without a mention does not write", async () => {
    const player = db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(SNOW);
    assert.ok(player);
    const orig = db.setPoints;
    let writes = 0;
    db.setPoints = (id, pts) => {
      writes += 1;
      return orig(id, pts);
    };
    try {
      const denied = capture(AUTHOR);
      await setPoints.run(ctx, ["%", "1"], denied.msg);
      assert.strictEqual(writes, 0);
      assert.strictEqual(denied.text(), liste.NEED_MENTION);
      const byName = capture(AUTHOR);
      await setPoints.run(ctx, ["Emil", "1"], byName.msg);
      assert.strictEqual(writes, 0);
      assert.strictEqual(
        db.getDb().prepare("SELECT base_points AS p FROM players WHERE id = ?").get(player.id).p,
        25
      );

      const mention = capture(AUTHOR, SNOW);
      await setPoints.run(ctx, ["4"], mention.msg);
      assert.strictEqual(writes, 1);
      assert.strictEqual(
        db.getDb().prepare("SELECT base_points AS p FROM players WHERE id = ?").get(player.id).p,
        4
      );
      assert.match(mention.text(), /gesetzt/);
      assertMentions(mention.payloads);
    } finally {
      db.setPoints = orig;
    }
  });

  test("liste: U07 when unregistered, names sanitized, foreign only via snowflake, draft sentence", async () => {
    clearPlayers();
    const year = db.getActiveSeason().year;
    const unreg = capture("100000000000000077");
    await liste.run(ctx, [], unreg.msg);
    assert.strictEqual(unreg.text(), liste.NOT_REGISTERED);
    assert.doesNotMatch(unreg.text(), /Tafel ist leer/);
    assertMentions(unreg.payloads);

    const player = db.upsertPlayer({ displayName: "*Ada* @here", discordUserId: AUTHOR });
    const good = db.findOrCreateCeleb({ name: "*Bowie* <@1>", description: "Note\nZwei" });
    const bad = db.findOrCreateCeleb({ name: "EvilUrlCeleb" });
    db.getDb()
      .prepare("UPDATE celebs SET wiki_url = ? WHERE id = ?")
      .run("https://en.wikipedia.org/wiki/David_Bowie", good.celeb.id);
    db.getDb()
      .prepare("UPDATE celebs SET wiki_url = ? WHERE id = ?")
      .run("https://evil.example/wiki/Secret", bad.celeb.id);
    const season = db.getActiveSeason();
    db.setPick(player.id, good.celeb.id, season.id);
    db.setPick(player.id, bad.celeb.id, season.id);

    const own = capture(AUTHOR);
    await liste.run(ctx, [], own.msg);
    const ownText = own.text();
    assert.match(ownText, new RegExp(`Deine Liste ${year} \\(läuft bis 1\\.1\\.${Number(year) + 1}\\)\\.`));
    assert.match(ownText, /Deine Liste — 2 Namen \| Punkte \*\*\d+\*\*/);
    assert.match(ownText, /\*\*Bowie 1\*\*/);
    assert.doesNotMatch(ownText, /<@1>/);
    assert.doesNotMatch(ownText, /evil\.example/);
    assert.match(ownText, /wikipedia\.org\/wiki\/David_Bowie/);
    // Preview-frei: URL in spitzen Klammern statt roher Autolink
    assert.match(ownText, /<https:\/\/en\.wikipedia\.org\/wiki\/David_Bowie>/);
    assert.doesNotMatch(ownText, /(^|\s)https:\/\/en\.wikipedia\.org/);
    assert.match(ownText, /Note Zwei/);
    assert.doesNotMatch(ownText, /Note\nZwei/);
    assertMentions(own.payloads);

    const byName = capture("100000000000000088", null);
    await liste.run(ctx, ["Ada"], byName.msg);
    assert.strictEqual(byName.text(), liste.NEED_MENTION);

    const byWild = capture("100000000000000088");
    await liste.run(ctx, ["%"], byWild.msg);
    assert.strictEqual(byWild.text(), liste.NEED_MENTION);

    const bySnow = capture("100000000000000088", null);
    bySnow.msg.guildId = "guild-test"; // Guild-Kontext: fremde Snowflake-Liste erlaubt
    await liste.run(ctx, [AUTHOR], bySnow.msg);
    assert.match(bySnow.text(), /Liste \*\*Ada here\*\*/);
    assert.match(bySnow.text(), /Namen \| Punkte/);
    assert.doesNotMatch(bySnow.text(), /@here/);
    assert.doesNotMatch(bySnow.text(), /Deine Liste —/);

    const announcedYear = Number(year) + 1;
    db.openAnnouncedSeason({ year: announcedYear, startDate: `${announcedYear}-01-01` });
    const announced = db.getAnnouncedSeason();
    assert.ok(announced);
    db.getOrCreateDraft(player.id, announced.id);
    const draftView = capture(AUTHOR);
    await liste.run(ctx, [], draftView.msg);
    assert.match(draftView.text(), /noch nicht mit `fertig` eingefroren/);
    // DM: der announced-Entwurf (2027) erscheint als eigener Block über der Liste
    assert.match(draftView.text(), new RegExp(`Dein ${announcedYear}-Entwurf`));
    assert.doesNotMatch(draftView.text(), new RegExp(`Dein ${year}-Entwurf`));

    db.getDb()
      .prepare("UPDATE pick_drafts SET status = 'finalized' WHERE player_id = ? AND season_id = ?")
      .run(player.id, announced.id);
    const frozen = capture(AUTHOR);
    await liste.run(ctx, [], frozen.msg);
    assert.match(frozen.text(), /Entwurf/);
    assert.doesNotMatch(frozen.text(), /noch nicht mit `fertig` eingefroren/);
  });

  test("scores uses listScoreboard, T19 header, players share that source", async () => {
    clearPlayers();
    const emptyScores = capture(AUTHOR);
    await scores.run(ctx, [], emptyScores.msg);
    assert.strictEqual(emptyScores.text(), scores.EMPTY);
    assertMentions(emptyScores.payloads);

    const emptyPlayers = capture(AUTHOR);
    await players.run(ctx, [], emptyPlayers.msg);
    assert.strictEqual(emptyPlayers.text(), players.EMPTY);

    const picker = db.upsertPlayer({ displayName: "*Zoe* @everyone", discordUserId: SNOW });
    const idle = db.upsertPlayer({ displayName: "Idle", discordUserId: SNOW_B });
    db.setPoints(picker.id, 10);
    db.setPoints(idle.id, 99);
    db.upsertBonus({ id: "m15", name: "M15", points: 5 });
    db.awardBonus(picker.id, "m15");
    const celebRow = db.findOrCreateCeleb({ name: "ScoreCeleb" });
    db.setPick(picker.id, celebRow.celeb.id, db.getActiveSeason().id);

    const origTotal = db.playerTotal;
    let totals = 0;
    db.playerTotal = (...args) => {
      totals += 1;
      return origTotal(...args);
    };
    try {
      const board = capture(AUTHOR);
      await scores.run(ctx, [], board.msg);
      const playersView = capture(AUTHOR);
      await players.run(ctx, [], playersView.msg);
      assert.strictEqual(totals, 0, "scoreboard must not call playerTotal per row");
      assert.match(board.text(), /📊 \*\*Rangliste\*\* — wer richtig gelegen hat/);
      assert.match(board.text(), new RegExp(`<@${SNOW}> — \\*\\*15\\*\\* Punkte \\(1 Picks\\)`));
      assert.doesNotMatch(board.text(), new RegExp(SNOW_B));
      assert.match(playersView.text(), /\*\*Zoe everyone\*\*/);
      assert.match(playersView.text(), /15 Punkte/);
      assert.match(playersView.text(), /Idle/);
      assert.match(playersView.text(), /99 Punkte/);
      assert.doesNotMatch(playersView.text(), /@everyone/);
      assertMentions(board.payloads);
      assertMentions(playersView.payloads);
    } finally {
      db.playerTotal = origTotal;
    }

    const prev = db.listScoreboard;
    let calls = 0;
    db.listScoreboard = () => {
      calls += 1;
      return [
        {
          discord_user_id: "100000000000000077",
          display_name: "*Stub*",
          total: 42,
          pick_count: 3,
        },
      ];
    };
    try {
      const fromStub = capture(AUTHOR);
      await scores.run(ctx, [], fromStub.msg);
      assert.strictEqual(calls, 1);
      assert.match(fromStub.text(), /<@100000000000000077> — \*\*42\*\* Punkte \(3 Picks\)/);
      const stubPlayers = capture(AUTHOR);
      await players.run(ctx, [], stubPlayers.msg);
      assert.strictEqual(calls, 2);
      assert.match(stubPlayers.text(), /• \*\*Stub\*\* <@100000000000000077>/);
    } finally {
      if (prev) db.listScoreboard = prev;
      else delete db.listScoreboard;
    }
  });

  test("celeb and celebs sanitize names and drop urls normalizeWikiUrl rejects", async () => {
    const bad = db.findOrCreateCeleb({
      name: "*ZqxvCeleb* @everyone",
      description: "Zeile1\nZeile2",
    });
    db.getDb()
      .prepare("UPDATE celebs SET wiki_url = ? WHERE id = ?")
      .run("https://evil.example/wiki/Secret", bad.celeb.id);
    db.addAka(bad.celeb.id, "*Aka* <@2>");
    const good = db.findOrCreateCeleb({ name: "ZqxvWiki" });
    const goodUrl = "https://en.wikipedia.org/wiki/ZqxvWiki";
    db.getDb().prepare("UPDATE celebs SET wiki_url = ? WHERE id = ?").run(goodUrl, good.celeb.id);
    const expected = normalizeWikiUrl(goodUrl).url;

    const one = capture(AUTHOR);
    await celeb.run(ctx, ["ZqxvCeleb"], one.msg);
    assert.match(one.text(), /\*\*ZqxvCeleb everyone\*\*/);
    assert.doesNotMatch(one.text(), /@everyone/);
    assert.doesNotMatch(one.text(), /evil\.example/);
    assert.match(one.text(), /Zeile1 Zeile2/);
    assert.match(one.text(), /Aka 2/);
    assertMentions(one.payloads);

    const wiki = capture(AUTHOR);
    await celeb.run(ctx, ["ZqxvWiki"], wiki.msg);
    assert.match(wiki.text(), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const all = capture(AUTHOR);
    await celebs.run(ctx, [], all.msg);
    assert.match(all.text(), /ZqxvCeleb everyone/);
    assert.doesNotMatch(all.text(), /evil\.example/);
    // Preview-frei: URL in spitzen Klammern
    assert.match(all.text(), /<https:\/\/en\.wikipedia\.org\/wiki\/ZqxvWiki>/);
    assert.match(all.text(), /wikipedia\.org\/wiki\/ZqxvWiki/);
    assert.doesNotMatch(all.text(), /(^|\s)https:\/\/en\.wikipedia\.org/);
    assertMentions(all.payloads);
  });

  test("slash descriptions T26", () => {
    assert.strictEqual(scores.description, "Rangliste: wer richtig gelegen hat");
    assert.strictEqual(liste.description, "Namenliste, deine oder die eines anderen");
    assert.strictEqual(players.description, "Alle Spieler und ihre Punkte");
  });

  test("liste: eigene Liste im DM erlaubt, fremde Liste im DM blockt", async () => {
    clearPlayers();
    const year = db.getActiveSeason().year;
    const player = db.upsertPlayer({ displayName: "Ada", discordUserId: AUTHOR });
    const good = db.findOrCreateCeleb({ name: "Bowie", description: "Note" });
    const season = db.getActiveSeason();
    db.setPick(player.id, good.celeb.id, season.id);

    // DM: eigene Liste ohne Angabe → läuft durch und zeigt die Liste
    const ownDm = capture(AUTHOR);
    await liste.run(ctx, [], ownDm.msg);
    assert.match(ownDm.text(), new RegExp(`Deine Liste ${year}`));
    assert.match(ownDm.text(), /Bowie/);
    assert.doesNotMatch(ownDm.text(), /Fremde Listen/);

    // DM: fremde Liste per Mention → blockt mit DM_FOREIGN_LIST
    const foreignMention = capture("100000000000000077", AUTHOR);
    await liste.run(ctx, [], foreignMention.msg);
    assert.strictEqual(foreignMention.text(), liste.DM_FOREIGN_LIST);

    // DM: fremde Liste per Snowflake → blockt mit DM_FOREIGN_LIST
    const other = capture("100000000000000077");
    db.upsertPlayer({ displayName: "Betty", discordUserId: "100000000000000077", basePoints: 10 });
    await liste.run(ctx, [AUTHOR], other.msg);
    assert.strictEqual(other.text(), liste.DM_FOREIGN_LIST);
  });

  test("sanitizeDisplayName strips markdown and mentions onto one line", () => {
    assert.strictEqual(liste.sanitizeDisplayName("*\nAda_ <@x>"), "Ada x");
    assert.strictEqual(liste.sanitizeDisplayName("***"), "„Unbenannt“");
    const long = "A".repeat(90);
    assert.strictEqual(liste.sanitizeDisplayName(long).length <= 80, true);
  });
});
