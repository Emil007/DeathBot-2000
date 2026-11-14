const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-import-guards-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const celebReview = require("../src/discord/celeb-review");
const { parseDeathDate, parseSheetTable } = require("../src/discord/import-sheet");
const cmd = require("../src/discord/commands/import");

// Wiki-Review würde sonst das Netz anfassen. Import-Guards prüfen die Buchung.
celebReview.queueCelebsForReview = async () => {
  throw new Error("import-guards: review queue was invoked");
};

describe("import guards", { concurrency: false }, () => {
  let config;
  let ctx;
  let seq = 0;

  before(() => {
    config = loadConfig();
    db.openDb(config);
    db.setSeasonStartDate("2026-01-01");
    db.setSeasonLive(true);
    ctx = {
      config,
      adminId: config.adminId,
      client: { channels: { fetch: async () => null }, users: { fetch: async () => null } },
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

  function textOf(payload) {
    return typeof payload === "string" ? payload : payload?.content || "";
  }

  function makeMsg({ authorId, content = "", playerId, username, displayName }) {
    const replies = [];
    const player = { id: playerId, username: username || "Target" };
    const msg = {
      author: { id: authorId, username: "Admin", bot: false },
      content,
      mentions: {
        users: { first: () => player },
        members: { first: () => (displayName ? { displayName } : null) },
      },
      attachments: { first: () => null },
      channel: { id: "ch-import", send: async () => null },
      reply: async (payload) => {
        replies.push(payload);
        return payload;
      },
    };
    msg.replies = replies;
    return msg;
  }

  function seedCeleb(overrides = {}) {
    seq += 1;
    const name = overrides.name || `Celeb ${seq}`;
    const age = overrides.age ?? 40;
    const info = db
      .getDb()
      .prepare(
        `INSERT INTO celebs (
          name, name_key, age_at_pick, sheet_age_hint, is_alive,
          wiki_confirmed, exclude_from_auto, died_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        db.nameKey(name),
        age,
        age,
        overrides.alive ?? 0,
        overrides.confirmed ?? 1,
        overrides.exclude ?? 0,
        overrides.diedAt ?? null
      );
    return db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(info.lastInsertRowid);
  }

  function seedPlayer(points = 0) {
    seq += 1;
    const discordId = `8${String(seq).padStart(17, "0")}`;
    const player = db.upsertPlayer({ displayName: `Spieler ${seq}`, discordUserId: discordId });
    db.setPoints(player.id, points);
    return db.getDb().prepare("SELECT * FROM players WHERE id = ?").get(player.id);
  }

  function playerRow(id) {
    return db.getDb().prepare("SELECT * FROM players WHERE id = ?").get(id);
  }

  function awardRows(playerId) {
    return db
      .getDb()
      .prepare("SELECT * FROM death_awards WHERE player_id = ? ORDER BY id")
      .all(playerId);
  }

  function pickIds(playerId) {
    return db
      .getDb()
      .prepare("SELECT celeb_id FROM picks WHERE player_id = ? ORDER BY celeb_id")
      .all(playerId)
      .map((r) => r.celeb_id);
  }

  function sheet(rows) {
    return ["Name\tAlter\tGestorben", ...rows.map((r) => `${r.name}\t${r.age}\t${r.died}`)].join(
      "\n"
    );
  }

  async function withFind(fn, run) {
    const orig = db.findOrCreateCeleb;
    db.findOrCreateCeleb = (input) => {
      const celeb = fn(input);
      return { celeb, ageConflict: null, created: false };
    };
    try {
      return await run();
    } finally {
      db.findOrCreateCeleb = orig;
    }
  }

  async function runImport({ player, username, displayName, rows, celebFor }) {
    return withFind(celebFor, async () => {
      const authorId = `admin-${player.discord_user_id}`;
      const open = makeMsg({
        authorId,
        playerId: player.discord_user_id,
        username,
        displayName,
      });
      await cmd.run(ctx, [], open);
      const chunk = makeMsg({ authorId, playerId: player.discord_user_id, content: sheet(rows) });
      const buffered = await cmd.tryConsumePaste(ctx, chunk);
      const done = makeMsg({ authorId, playerId: player.discord_user_id, content: "done" });
      const consumed = await cmd.tryConsumePaste(ctx, done);
      return { open, chunk, done, buffered, consumed };
    });
  }

  test("parseDeathDate rejects impossible calendar dates", () => {
    assert.strictEqual(parseDeathDate("31.02.2027"), null);
    assert.strictEqual(parseDeathDate("2027-02-31"), null);
    assert.strictEqual(parseDeathDate("29.02.2027"), null);
    assert.strictEqual(parseDeathDate("29.02.2028"), "2028-02-29");
    assert.strictEqual(parseDeathDate("2026-01-01"), "2026-01-01");
    assert.strictEqual(parseDeathDate("1.2.2026"), "2026-02-01");
    assert.strictEqual(parseDeathDate("???"), null);

    const bad = parseSheetTable("Name\tAlter\tGestorben\nX\t40\t31.02.2027");
    assert.strictEqual(bad.rows[0].diedAt, null);
    assert.strictEqual(bad.rows[0].diedInvalid, true);
    const iso = parseSheetTable("Name\tAlter\tGestorben\nX\t40\t2027-02-31");
    assert.strictEqual(iso.rows[0].diedAt, null);
    assert.strictEqual(iso.rows[0].diedInvalid, true);
    const noise = parseSheetTable("Name\tAlter\tGestorben\nX\t40\t???");
    assert.strictEqual(noise.rows[0].diedAt, null);
    assert.strictEqual(noise.rows[0].diedInvalid, false);
  });

  test("already-dead celeb before start_date, age 40, pays nothing", async () => {
    const pointsBefore = 17;
    const player = seedPlayer(pointsBefore);
    const old = seedCeleb({ name: "Old List Before", alive: 1, confirmed: 1 });
    db.setPick(player.id, old.id, db.getActiveSeason().id);
    const celeb = seedCeleb({
      name: "Historical Dead",
      age: 40,
      alive: 0,
      confirmed: 1,
      exclude: 0,
      diedAt: "2020-01-01",
    });

    const res = await runImport({
      player,
      rows: [{ name: celeb.name, age: 40, died: "31.12.2025" }],
      celebFor: () => celeb,
    });

    assert.strictEqual(playerRow(player.id).base_points, pointsBefore);
    assert.strictEqual(awardRows(player.id).length, 0);
    assert.deepStrictEqual(pickIds(player.id), [celeb.id]);
    const body = textOf(res.done.replies[0]);
    assert.ok(body.includes("Liste ersetzt für"));
    assert.ok(body.includes("Picks"));
    assert.ok(body.includes("Sheet-tot"));
    assert.ok(body.includes("Review"));
    assert.ok(body.includes("Sheet-tot + Punkte: **0**"));
    assert.ok(!body.includes("ungültiges Todesdatum"));
    assert.deepStrictEqual(res.done.replies[0].allowedMentions, { parse: [] });
  });

  test("already-dead celeb on or after start_date, confirmed, not excluded, awards once", async () => {
    const score = db.scoreForAge(40);
    assert.ok(score > 0);

    for (const died of ["01.01.2026", "2026-08-20"]) {
      const player = seedPlayer(0);
      const celeb = seedCeleb({
        name: `Paid Dead ${died}`,
        age: 40,
        alive: 0,
        confirmed: 1,
        exclude: 0,
      });
      const res = await runImport({
        player,
        rows: [{ name: celeb.name, age: 40, died }],
        celebFor: () => celeb,
      });
      const awards = awardRows(player.id);
      assert.strictEqual(awards.length, 1, died);
      assert.strictEqual(awards[0].points, score, died);
      assert.strictEqual(awards[0].celeb_id, celeb.id);
      assert.strictEqual(awards[0].season_id, db.getActiveSeason().id);
      assert.strictEqual(playerRow(player.id).base_points, score, died);
      assert.ok(textOf(res.done.replies[0]).includes("Sheet-tot + Punkte: **1**"));
    }
  });

  test("impossible dates pay nothing and do not abort the rest of the sheet", async () => {
    const pointsBefore = 19;
    const player = seedPlayer(pointsBefore);
    const badDe = seedCeleb({
      name: "Bad DE Date",
      age: 40,
      alive: 0,
      confirmed: 1,
      exclude: 0,
    });
    const badIso = seedCeleb({
      name: "Bad ISO Date",
      age: 40,
      alive: 0,
      confirmed: 1,
      exclude: 0,
    });
    const good = seedCeleb({
      name: "Good After Start",
      age: 40,
      alive: 0,
      confirmed: 1,
      exclude: 0,
    });
    const byName = new Map([
      [badDe.name, badDe],
      [badIso.name, badIso],
      [good.name, good],
    ]);

    const res = await runImport({
      player,
      rows: [
        { name: badDe.name, age: 40, died: "31.02.2027" },
        { name: badIso.name, age: 40, died: "2027-02-31" },
        { name: good.name, age: 40, died: "2026-06-15" },
      ],
      celebFor: (input) => byName.get(input.name),
    });

    const score = db.scoreForAge(40);
    const awards = awardRows(player.id);
    assert.strictEqual(awards.length, 1);
    assert.strictEqual(awards[0].celeb_id, good.id);
    assert.strictEqual(playerRow(player.id).base_points, pointsBefore + score);
    const body = textOf(res.done.replies[0]);
    assert.ok(body.includes("ungültiges Todesdatum"));
    assert.ok(body.includes(badDe.name));
    assert.ok(body.includes(badIso.name));
    assert.ok(body.includes("Picks: **3**"));
    assert.ok(body.includes("Sheet-tot + Punkte: **1**"));
  });

  test("excluded or unconfirmed already-dead rows pay nothing after start", async () => {
    const origQueue = celebReview.queueCelebsForReview;
    celebReview.queueCelebsForReview = async () => 0;
    try {
      const excluded = seedCeleb({
        name: "Excluded Dead",
        age: 40,
        alive: 0,
        confirmed: 1,
        exclude: 1,
      });
      const unconfirmed = seedCeleb({
        name: "Unconfirmed Dead",
        age: 40,
        alive: 0,
        confirmed: 0,
        exclude: 0,
      });
      const player = seedPlayer(8);
      await runImport({
        player,
        rows: [
          { name: excluded.name, age: 40, died: "2026-03-01" },
          { name: unconfirmed.name, age: 40, died: "2026-03-02" },
        ],
        celebFor: (input) => (input.name === excluded.name ? excluded : unconfirmed),
      });
      assert.strictEqual(playerRow(player.id).base_points, 8);
      assert.strictEqual(awardRows(player.id).length, 0);
    } finally {
      celebReview.queueCelebsForReview = origQueue;
    }
  });

  test("applyDeath skipped is not counted as a sheet award", async () => {
    const player = seedPlayer(10);
    const celeb = seedCeleb({
      name: "Skipped Living",
      age: 40,
      alive: 1,
      confirmed: 1,
      exclude: 0,
    });
    const origDeath = db.applyDeath;
    let calls = 0;
    db.applyDeath = () => {
      calls += 1;
      return {
        skipped: true,
        reason: "exclude_from_auto",
        awards: [{ player: { id: player.id }, points: 60 }],
      };
    };
    try {
      const res = await runImport({
        player,
        rows: [{ name: celeb.name, age: 40, died: "2026-05-05" }],
        celebFor: () => celeb,
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(playerRow(player.id).base_points, 10);
      assert.strictEqual(awardRows(player.id).length, 0);
      assert.ok(textOf(res.done.replies[0]).includes("Sheet-tot + Punkte: **0**"));
    } finally {
      db.applyDeath = origDeath;
    }
  });

  test("clearPicksForPlayer runs inside the transaction and rolls back with it", async () => {
    const player = seedPlayer(4);
    const old = seedCeleb({ name: "Keep Old Pick", alive: 1, confirmed: 1 });
    const seasonId = db.getActiveSeason().id;
    db.setPick(player.id, old.id, seasonId);
    const incoming = seedCeleb({ name: "Would Replace", alive: 1, confirmed: 1 });

    const origClear = db.clearPicksForPlayer;
    let inTx = false;
    db.clearPicksForPlayer = (playerId, sid) => {
      inTx = db.getDb().inTransaction;
      origClear(playerId, sid);
      throw new Error("boom");
    };
    try {
      await assert.rejects(
        () =>
          runImport({
            player,
            rows: [{ name: incoming.name, age: 40, died: "" }],
            celebFor: () => incoming,
          }),
        /boom/
      );
    } finally {
      db.clearPicksForPlayer = origClear;
    }

    assert.strictEqual(inTx, true);
    assert.deepStrictEqual(pickIds(player.id), [old.id]);
    assert.strictEqual(playerRow(player.id).base_points, 4);
  });

  test("expired paste is consumed and replaces nothing", async () => {
    const player = seedPlayer(42);
    const old = seedCeleb({ name: "Untouched Pick", alive: 1, confirmed: 1 });
    db.setPick(player.id, old.id, db.getActiveSeason().id);
    const authorId = `admin-expire-${player.discord_user_id}`;
    const open = makeMsg({
      authorId,
      playerId: player.discord_user_id,
      username: "ExpireTarget",
    });
    await cmd.run(ctx, [], open);

    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60 * 1000;
    try {
      const paste = makeMsg({
        authorId,
        playerId: player.discord_user_id,
        content: "Name\tAlter\tGestorben\nSomebody\t40\t2026-07-01",
      });
      const consumed = await cmd.tryConsumePaste(ctx, paste);
      assert.strictEqual(consumed, true);
      assert.strictEqual(
        textOf(paste.replies[0]),
        "Import verworfen, die 15 Minuten sind um. /import neu starten. Nichts wurde ersetzt."
      );
      assert.ok(textOf(paste.replies[0]).includes("Nichts wurde ersetzt"));
      assert.deepStrictEqual(paste.replies[0].allowedMentions, { parse: [] });
    } finally {
      Date.now = realNow;
    }

    const next = makeMsg({
      authorId,
      playerId: player.discord_user_id,
      content: "Keanu Reeves",
    });
    assert.strictEqual(await cmd.tryConsumePaste(ctx, next), false);
    assert.deepStrictEqual(pickIds(player.id), [old.id]);
    assert.strictEqual(playerRow(player.id).base_points, 42);
  });

  test("open prompt is T24 and the live buffer names the import target", async () => {
    const player = seedPlayer(0);
    const celeb = seedCeleb({ name: "Buffer Celeb", alive: 1, confirmed: 1 });
    const nasty = "*A* <@99>";
    const res = await runImport({
      player,
      username: nasty,
      rows: [{ name: celeb.name, age: 40, died: "" }],
      celebFor: () => celeb,
    });

    const season = db.getActiveSeason();
    const prompt = [
      "Import für **A 99**. Die bisherige Liste dieses Spielers wird ersetzt, nicht ergänzt.",
      `Saisonstart **${season.start_date}**. Zeilen schicken, dann \`done\`, \`fertig\` oder \`end\` (oder eine Datei anhängen).`,
    ].join("\n");
    assert.strictEqual(textOf(res.open.replies[0]), prompt);
    assert.deepStrictEqual(res.open.replies[0].allowedMentions, { parse: [] });
    assert.ok(!textOf(res.open.replies[0]).includes("<@"));
    assert.strictEqual(res.buffered, true);
    assert.ok(
      textOf(res.chunk.replies[0]).includes(
        "Das hier ist der Import für A 99, nicht deine eigene Liste."
      )
    );
    assert.deepStrictEqual(res.chunk.replies[0].allowedMentions, { parse: [] });
    assert.ok(textOf(res.done.replies[0]).includes("Liste ersetzt für"));
    assert.ok(textOf(res.done.replies[0]).includes("(**A 99**)"));
    assert.deepStrictEqual(res.done.replies[0].allowedMentions, { parse: [] });
  });
});
