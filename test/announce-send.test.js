const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-m7-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const log = require("../src/discord/log");
const pageLookup = require("../src/wiki/page-lookup");
const {
  announceAllDeath,
  announceDailySummary,
  announceSimulatedDeath,
  announceRetraction,
  entryDeathDateIso,
  formatReconcileSummary,
  processDeathpoolHit,
  replayUnannounced,
} = require("../src/discord/announce");
const kill = require("../src/discord/commands/kill");
const simulate = require("../src/discord/commands/simulate");
const resurrect = require("../src/discord/commands/resurrect");

const FORMULA = /\(=100\u2212Alter\)/;

let config;

before(() => {
  config = loadConfig();
  db.openDb(config);
  db.setSeasonLive(true);
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
  db.setSeasonDeathpoolChannel(db.getActiveSeason().id, "pool-1");
});

after(() => {
  try {
    db.closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textChannel(sent, send) {
  return {
    id: "pool-1",
    isTextBased: () => true,
    send:
      send ||
      (async (payload) => {
        sent.push(payload);
        return payload;
      }),
  };
}

function clientFor(channel, extra = {}) {
  return {
    ...extra,
    channels: {
      fetch: async () => channel,
    },
  };
}

function detailsOf(payload) {
  const embed = payload.embeds[0];
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
  return data.fields.find((field) => field.name === "Details").value;
}

function fieldOf(payload, name) {
  const embed = payload.embeds[0];
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
  return data.fields.find((field) => field.name === name).value;
}

function insertCeleb(name, extra = {}) {
  const info = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, age_at_pick, is_alive, wiki_confirmed, exclude_from_auto, died_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      db.nameKey(name),
      extra.age === undefined ? null : extra.age,
      extra.alive === undefined ? 1 : extra.alive,
      extra.confirmed === undefined ? 1 : extra.confirmed,
      extra.exclude === undefined ? 0 : extra.exclude,
      extra.diedAt || null
    );
  return db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(info.lastInsertRowid);
}

function replyBag() {
  const replies = [];
  return {
    replies,
    async reply(payload) {
      replies.push(typeof payload === "string" ? payload : payload.content);
      return payload;
    },
  };
}

function seasonYear() {
  return Number(String(db.getActiveSeason().start_date).slice(0, 4));
}

test("entryDeathDateIso rejects day 31 in a short month and keeps real dates", () => {
  assert.strictEqual(entryDeathDateIso({ day: 31, month: 1, year: 2026 }), null);
  assert.strictEqual(entryDeathDateIso({ day: 31, month: 3, year: 2026 }), null);
  assert.strictEqual(entryDeathDateIso({ day: 29, month: 1, year: 2027 }), null);
  assert.strictEqual(entryDeathDateIso({ day: 29, month: 1, year: 2028 }), "2028-02-29");
  assert.strictEqual(entryDeathDateIso({ day: 31, month: 11, year: 2024 }), "2024-12-31");
  assert.strictEqual(entryDeathDateIso({ day: 31, month: null, year: 2026 }), null);
});

test("fetch throw: announceAllDeath throws and markWikiAnnounced is not called", async () => {
  const orig = db.markWikiAnnounced;
  const origLog = log.logError;
  let stamps = 0;
  const logged = [];
  db.markWikiAnnounced = () => {
    stamps += 1;
  };
  log.logError = async (...args) => {
    logged.push(args);
  };
  const entry = {
    id: "en:/wiki/Fetch_Fail",
    url: "https://en.wikipedia.org/wiki/Fetch_Fail",
    text: "Fetch Fail, 70",
    lang: "en",
  };
  try {
    let thrown = null;
    try {
      await announceAllDeath(
        {
          channels: {
            fetch: async () => {
              const err = new Error("Unknown Channel");
              err.code = 10003;
              throw err;
            },
          },
        },
        { ...config, channelAllDeaths: "all-dead" },
        entry
      );
      db.markWikiAnnounced(entry.id);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "announceAllDeath must throw");
    assert.strictEqual(thrown.channelId, "all-dead");
    assert.strictEqual(Number(thrown.code), 10003);
    assert.strictEqual(stamps, 0, "markWikiAnnounced stub must not run");
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0][3].where, "announceAllDeath");
  } finally {
    db.markWikiAnnounced = orig;
    log.logError = origLog;
  }
});

test("prestart card with a known age does not show the scoring formula", async () => {
  const year = seasonYear();
  const celeb = insertCeleb("Prestart Known", { age: 44 });
  const sent = [];
  await processDeathpoolHit(
    clientFor(textChannel(sent)),
    config,
    {
      celeb,
      entry: { day: 20, month: 11, year: year - 1, lang: "en" },
      wikiAge: 44,
    },
    { announce: true, confirmed: false, source: "wiki" }
  );
  assert.strictEqual(sent.length, 1);
  const details = detailsOf(sent[0]);
  assert.match(details, /Vor dem Saisonstart → 0 Punkte\./);
  assert.doesNotMatch(details, FORMULA);
  assert.doesNotMatch(details, /Jünger war profitabler/);
  assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
});

test("unknown age says Alter unbekannt and omits the formula", async () => {
  const year = seasonYear();
  const celeb = insertCeleb("Age Unknown", { age: null });
  const sent = [];
  await processDeathpoolHit(
    clientFor(textChannel(sent)),
    config,
    {
      celeb,
      entry: { day: 15, month: 5, year, lang: "en" },
      wikiAge: null,
    },
    { announce: true, confirmed: false, source: "wiki" }
  );
  const details = detailsOf(sent[0]);
  assert.match(details, /Alter unbekannt/);
  // F27 (neuere Spec): unbekanntes Alter zeigt KEINEN irreführenden „0 Punkte"-
  // Zusatz, da der echte Wert aus der Buchung kommt (age_at_pick), nicht fix 0 ist.
  assert.doesNotMatch(details, /0 Punkte\./);
  assert.doesNotMatch(details, FORMULA);
  assert.match(fieldOf(sent[0], "Deathpool"), /Keiner hatte diesen Namen/);
});

test("in-season hit with a known age shows the formula only on that card", async () => {
  const year = seasonYear();
  const celeb = insertCeleb("In Season", { age: 40 });
  const player = db.upsertPlayer({ displayName: "Ada", discordUserId: "m7-ada" });
  db.setPick(player.id, celeb.id, db.getActiveSeason().id);
  const sent = [];
  const result = await processDeathpoolHit(
    clientFor(textChannel(sent)),
    config,
    {
      celeb,
      entry: { day: 2, month: 5, year, lang: "en" },
      wikiAge: 40,
    },
    { announce: true, confirmed: false, source: "wiki" }
  );
  const details = detailsOf(sent[0]);
  assert.match(details, FORMULA);
  assert.match(details, /Jünger war profitabler/);
  assert.match(details, /\*\*40\*\*/);
  assert.match(details, /\*\*60\*\*/);
  assert.match(sent[0].content, /\*\*Treffer\*\* — Promi beerdigt, Tipp gepunktet/);
  assert.match(fieldOf(sent[0], "Deathpool"), /Ada/);
  assert.strictEqual(result.announced, typeof db.markDeathAnnounced === "function");
});

test("replayUnannounced does not call applyDeath and stamps only after send", async () => {
  const origApply = db.applyDeath;
  const origList = db.listUnannouncedDeaths;
  const origMark = db.markDeathAnnounced;
  let applies = 0;
  db.applyDeath = () => {
    applies += 1;
    return { skipped: true, reason: "test" };
  };
  const sent = [];
  let attempts = 0;
  const channel = textChannel(sent, async (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error("send failed");
    sent.push(payload);
    return payload;
  });
  const marks = [];
  db.listUnannouncedDeaths = () => [
    { id: 91001, name: "Replay A", is_alive: 0, age_at_pick: 40, died_at: "2026-06-01" },
    { id: 91002, name: "Replay B", is_alive: 0, age_at_pick: 50, died_at: "2026-06-02" },
  ];
  db.markDeathAnnounced = (id) => {
    marks.push({ id, attempts, sent: sent.length });
  };
  try {
    const summary = await replayUnannounced(clientFor(channel), config);
    assert.strictEqual(applies, 0, "replay must not call applyDeath");
    assert.strictEqual(summary.sent, 1);
    assert.strictEqual(summary.failed, 1);
    assert.deepStrictEqual(marks, [{ id: 91002, attempts: 2, sent: 1 }]);
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
  } finally {
    db.applyDeath = origApply;
    if (origList) db.listUnannouncedDeaths = origList;
    else delete db.listUnannouncedDeaths;
    if (origMark) db.markDeathAnnounced = origMark;
    else delete db.markDeathAnnounced;
  }
});

test("worst case: all-deaths fetch throw leaves the stamp unset, and the prestart card has no formula", async () => {
  const orig = db.markWikiAnnounced;
  let stamps = 0;
  db.markWikiAnnounced = () => {
    stamps += 1;
  };
  const entry = {
    id: "en:/wiki/Worst_Case",
    url: "https://en.wikipedia.org/wiki/Worst_Case",
    text: "Worst Case, 80",
    lang: "en",
  };
  try {
    let thrown = null;
    try {
      await announceAllDeath(
        {
          channels: {
            fetch: async () => {
              const err = new Error("Missing Access");
              err.code = 50001;
              throw err;
            },
          },
        },
        { ...config, channelAllDeaths: "all-worst" },
        entry
      );
      db.markWikiAnnounced(entry.id, null, null);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.strictEqual(thrown.channelId, "all-worst");
    assert.strictEqual(Number(thrown.code), 50001);
    assert.strictEqual(stamps, 0, "stamp stays off when the fetch throws");

    const year = seasonYear();
    const celeb = insertCeleb("Worst Prestart", { age: 70 });
    const sent = [];
    await processDeathpoolHit(
      clientFor(textChannel(sent)),
      config,
      {
        celeb,
        entry: { day: 31, month: 11, year: year - 1, lang: "en" },
        wikiAge: 71,
      },
      { announce: true, confirmed: false, source: "wiki" }
    );
    const details = detailsOf(sent[0]);
    assert.match(details, /Vor dem Saisonstart → 0 Punkte\./);
    assert.doesNotMatch(details, FORMULA);
    assert.doesNotMatch(JSON.stringify(sent[0].content), FORMULA);
  } finally {
    db.markWikiAnnounced = orig;
  }
});

test("deathpool send failure does not mark the death announced", async () => {
  const origLog = log.logError;
  const origMark = db.markDeathAnnounced;
  const logged = [];
  log.logError = async (...args) => {
    logged.push(args);
  };
  let marked = false;
  db.markDeathAnnounced = () => {
    marked = true;
  };
  const celeb = insertCeleb("Send Fails", { age: 55 });
  const channel = textChannel([], async () => {
    const err = new Error("Missing Permissions");
    err.code = 50013;
    throw err;
  });
  try {
    await assert.rejects(
      () =>
        processDeathpoolHit(
          clientFor(channel),
          config,
          { celeb, entry: { day: 3, month: 6, year: seasonYear(), lang: "en" }, wikiAge: 55 },
          { announce: true, confirmed: false, source: "wiki" }
        ),
      (err) => {
        assert.strictEqual(err.channelId, "pool-1");
        assert.strictEqual(Number(err.code), 50013);
        return true;
      }
    );
    assert.strictEqual(marked, false);
    assert.strictEqual(logged.length, 1);
    const row = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(celeb.id);
    assert.strictEqual(row.is_alive, 0, "the booking already happened");
  } finally {
    log.logError = origLog;
    if (origMark) db.markDeathAnnounced = origMark;
    else delete db.markDeathAnnounced;
  }
});

test("skipped applyDeath does not send and does not throw", async () => {
  const orig = db.applyDeath;
  db.applyDeath = () => ({ skipped: true, reason: "unconfirmed" });
  const celeb = insertCeleb("Skip Me", { age: 30 });
  const sent = [];
  try {
    const result = await processDeathpoolHit(
      clientFor(textChannel(sent)),
      config,
      { celeb, entry: { day: 1, month: 0, year: seasonYear(), lang: "en" }, wikiAge: 30 },
      { announce: true, confirmed: false, source: "wiki" }
    );
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(sent.length, 0);
    const row = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(celeb.id);
    assert.strictEqual(row.is_alive, 1);
  } finally {
    db.applyDeath = orig;
  }
});

test("unavailable guild is not reported as a missing channel", async () => {
  let fetched = 0;
  const client = {
    guilds: { cache: { values: () => [{ available: false }] } },
    channels: {
      fetch: async () => {
        fetched += 1;
        return textChannel([]);
      },
    },
  };
  await assert.rejects(
    () => announceDailySummary(client, config),
    (err) => {
      assert.strictEqual(err.unavailable, true);
      assert.strictEqual(err.channelId, "pool-1");
      assert.doesNotMatch(String(err.message), /Kanal fehlt/);
      return true;
    }
  );
  assert.strictEqual(fetched, 0);
});

test("429 on fetch is unavailable and is not logged as 10003", async () => {
  const origLog = log.logError;
  let logs = 0;
  log.logError = async () => {
    logs += 1;
  };
  try {
    await assert.rejects(
      () =>
        announceSimulatedDeath(
          {
            channels: {
              fetch: async () => {
                const err = new Error("HTTP 429");
                err.status = 429;
                throw err;
              },
            },
          },
          config,
          { name: "Rate", age: 40 }
        ),
      (err) => {
        assert.strictEqual(err.unavailable, true);
        assert.strictEqual(err.channelId, "pool-1");
        assert.doesNotMatch(String(err.message), /Kanal fehlt/);
        return true;
      }
    );
    assert.strictEqual(logs, 0);
  } finally {
    log.logError = origLog;
  }
});

test("daily summary uses the three review sentences and stays quiet while offline", async () => {
  db.setSeasonLive(false);
  let fetched = 0;
  await announceDailySummary(
    {
      channels: {
        fetch: async () => {
          fetched += 1;
          throw new Error("should not fetch");
        },
      },
    },
    config
  );
  assert.strictEqual(fetched, 0);
  db.setSeasonLive(true);

  const empty = [];
  await announceDailySummary(clientFor(textChannel(empty)), config);
  assert.match(empty[0].content, /Die Sense gähnt/);
  assert.deepStrictEqual(empty[0].allowedMentions, { parse: [] });

  db.getDb()
    .prepare(
      `INSERT INTO announced_deaths (entry_id, name, url, lang, announced_at)
       VALUES ('en:/wiki/Daily_Person', 'Daily Person', 'https://en.wikipedia.org/wiki/Daily_Person', 'en', datetime('now'))`
    )
    .run();
  const filled = [];
  await announceDailySummary(clientFor(textChannel(filled)), config);
  assert.match(
    filled[0].content,
    /Tagesbericht\*\* — 1 neue Einträge seit gestern\. Nicht jeder davon stand auf einer Tippliste\./
  );
  assert.match(filled[0].content, /🌍 \*\*International:\*\*/);
});

test("formatReconcileSummary uses the Review 7 German sentences", () => {
  const text = formatReconcileSummary(
    [
      {
        celeb: { name: "Ada *@Lovelace*" },
        wikiAge: 80,
        result: {
          age: 40,
          score: 60,
          awards: [],
        },
      },
    ],
    { start_date: "2026-01-01", live: 0 }
  );
  assert.match(text, /📋 \*\*Abgleich\*\* \(Setup, vor Live — keine Kanal-Ankündigungen\)/);
  assert.match(text, /Saisonstart: \*\*2026-01-01\*\* · Live: \*\*nein\*\*/);
  assert.match(text, /Neu als tot markiert: \*\*1\*\*/);
  assert.match(text, /Pool-Alter 40 → 60 Punkte/);
  assert.match(text, /Wiki-Alter 80/);
  assert.match(text, /\| niemand/);
  assert.match(text, /Große Lücke Pool-Alter gegen Wiki-Alter:/);
  assert.match(text, /Weiter: `\/scores`, danach `\/go`, falls noch nicht live\./);
  assert.doesNotMatch(text, /@/);
  const live = formatReconcileSummary([], { start_date: "2027-01-01", live: 1 });
  assert.match(live, /Live: \*\*ja\*\*/);
});

test("retraction send stamps only after the message, and a failed send leaves the flag", async () => {
  const celeb = insertCeleb("False Alarm", { age: 33, alive: 0, diedAt: "2026-06-01" });
  const player = db.upsertPlayer({ displayName: "@Neo", discordUserId: "m7-neo" });
  db.getDb()
    .prepare(
      "INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (?, ?, ?, ?)"
    )
    .run(celeb.id, player.id, 12, db.getActiveSeason().id);
  const origMark = db.markRetractionAnnounced;
  let marked = 0;
  db.markRetractionAnnounced = () => {
    marked += 1;
  };
  const sent = [];
  try {
    await announceRetraction(clientFor(textChannel(sent)), config, {
      celeb,
      awards: [{ player_id: player.id, points: 12 }],
    });
    assert.strictEqual(marked, 1);
    assert.match(sent[0].content, /↩️ \*\*Fehlalarm\*\* — False Alarm steht nicht mehr zuverlässig/);
    assert.match(sent[0].content, /Widerruf innerhalb von 7 Tagen\. Punkte zurückgebucht:/);
    assert.match(sent[0].content, /\*\*Neo\*\*/);
    assert.doesNotMatch(sent[0].content, /@/);
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });

    const failing = textChannel([], async () => {
      throw new Error("no send");
    });
    await assert.rejects(() =>
      announceRetraction(clientFor(failing), config, { celeb, awards: [] })
    );
    assert.strictEqual(marked, 1, "a failed send must not stamp again");
  } finally {
    if (origMark) db.markRetractionAnnounced = origMark;
    else delete db.markRetractionAnnounced;
  }
});

test("/kill says live-announced only after the stamp, and skipped stays serious", async () => {
  const liveCeleb = insertCeleb("Kill Live", { age: 48 });
  const origMark = db.markDeathAnnounced;
  let marked = 0;
  db.markDeathAnnounced = () => {
    marked += 1;
  };
  const sent = [];
  const msg = replyBag();
  try {
    await kill.run(
      { client: clientFor(textChannel(sent)), config },
      ["Kill", "Live"],
      msg
    );
    assert.strictEqual(marked, 1);
    assert.ok(msg.replies.some((line) => line.includes("Erledigt (live angekündigt): Kill Live")));
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
  } finally {
    if (origMark) db.markDeathAnnounced = origMark;
    else delete db.markDeathAnnounced;
  }

  const skipped = insertCeleb("Kill Skip", { age: 22 });
  const orig = db.applyDeath;
  db.applyDeath = () => ({ skipped: true, reason: "exclude" });
  const skipMsg = replyBag();
  try {
    await kill.run({ client: clientFor(textChannel([])), config }, ["Kill", "Skip"], skipMsg);
    assert.deepStrictEqual(skipMsg.replies, [
      "Nicht angekündigt: der Celeb ist nicht bestätigt oder von der Automatik ausgenommen.",
    ]);
    const row = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(skipped.id);
    assert.strictEqual(row.is_alive, 1);
  } finally {
    db.applyDeath = orig;
  }

  db.setSeasonLive(false);
  const setup = insertCeleb("Kill Setup", { age: 19 });
  const setupMsg = replyBag();
  let fetched = 0;
  try {
    await kill.run(
      {
        client: {
          channels: {
            fetch: async () => {
              fetched += 1;
              return textChannel([]);
            },
          },
        },
        config,
      },
      ["Kill", "Setup"],
      setupMsg
    );
    assert.strictEqual(fetched, 0);
    assert.ok(setupMsg.replies[0].includes("Erledigt (Setup, ohne Channel-Ping): Kill Setup"));
    assert.ok(setup);
  } finally {
    db.setSeasonLive(true);
  }
});

test("/simulate says sent only when the announcement does not throw", async () => {
  const origLookup = pageLookup.lookupUrl;
  const origGet = axios.get;
  pageLookup.lookupUrl = async () => ({
    title: "Probe Person",
    wikiUrl: null,
    wikiUrlDe: null,
    qid: null,
    wikiNorm: null,
    proposedAge: 66,
  });
  axios.get = async () => ({ status: 200, data: { query: { pages: {} } } });
  const msg = replyBag();
  try {
    await assert.rejects(() =>
      simulate.run(
        {
          client: {
            channels: {
              fetch: async () => {
                const err = new Error("Missing Permissions");
                err.code = 50013;
                throw err;
              },
            },
          },
          config,
        },
        ["https://en.wikipedia.org/wiki/Probe_Person"],
        msg
      )
    );
    assert.ok(!msg.replies.some((line) => line.includes("Simulation gesendet")));

    const sent = [];
    const ok = replyBag();
    await simulate.run(
      { client: clientFor(textChannel(sent)), config },
      ["https://en.wikipedia.org/wiki/Probe_Person"],
      ok
    );
    assert.ok(ok.replies[0].includes("Simulation gesendet: **Probe Person**"));
    assert.match(sent[0].content, /\*\*Simulation\*\* — Probeleiche, kein DB-Write, keine Pings/);
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
  } finally {
    pageLookup.lookupUrl = origLookup;
    axios.get = origGet;
  }
});

test("/resurrect success follows the retraction send; a failed send names the next poll", async () => {
  const dead = insertCeleb("@Everyone", { alive: 0, diedAt: "2026-04-01" });
  const failMsg = replyBag();
  db.setSeasonDeathpoolChannel(db.getActiveSeason().id, null);
  try {
    await resurrect.run({ client: clientFor(textChannel([])), config }, ["Everyone"], failMsg);
    assert.deepStrictEqual(failMsg.replies, [
      "Punkte sind zurück, die Nachricht nicht. Der nächste Poll holt sie nach.",
    ]);
    const row = db.getDb().prepare("SELECT is_alive FROM celebs WHERE id = ?").get(dead.id);
    assert.strictEqual(row.is_alive, 1);
  } finally {
    db.setSeasonDeathpoolChannel(db.getActiveSeason().id, "pool-1");
  }

  const again = insertCeleb("Back Alive", { alive: 0, diedAt: "2026-05-01" });
  const origMark = db.markRetractionAnnounced;
  let marked = 0;
  db.markRetractionAnnounced = () => {
    marked += 1;
  };
  const sent = [];
  const ok = replyBag();
  try {
    await resurrect.run({ client: clientFor(textChannel(sent)), config }, ["Back", "Alive"], ok);
    assert.strictEqual(marked, 1);
    assert.match(ok.replies[0], /Back Alive lebt wieder\. 0 Punkte-Buchungen rückgängig\./);
    assert.match(sent[0].content, /Fehlalarm/);
    assert.ok(!ok.replies.some((line) => line.includes("nächste Poll")));
  } finally {
    if (origMark) db.markRetractionAnnounced = origMark;
    else delete db.markRetractionAnnounced;
  }
  assert.ok(again.id);
});
