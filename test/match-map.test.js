const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-m9-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const {
  extractAge,
  entryMatchesCeleb,
  findPoolMatches,
  findPoolMatchesForAnnounced,
  buildPoolIndex,
  matchEntriesToIndex,
} = require("../src/wiki/match");

function sides(celebs, akas = {}, blacklist = {}) {
  const akaById = new Map();
  const blacklistById = new Map();
  for (const c of celebs) {
    akaById.set(c.id, akas[c.id] || []);
    blacklistById.set(c.id, blacklist[c.id] || []);
  }
  return { akaById, blacklistById };
}

function brute(celebs, entries, akaById, blacklistById) {
  const matches = [];
  for (const celeb of celebs) {
    const akas = akaById.get(celeb.id) || [];
    const blacklist = blacklistById.get(celeb.id) || [];
    for (const entry of entries) {
      if (entryMatchesCeleb(entry, celeb, akas, blacklist)) {
        matches.push({
          id: celeb.id,
          entry,
          age: extractAge(entry.text) ?? celeb.age_at_pick ?? null,
        });
        break;
      }
    }
  }
  return matches;
}

describe("pool name index", { concurrency: false }, () => {
  before(() => {
    db.openDb(loadConfig());
  });

  after(() => {
    try {
      db.closeDb();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("30 celebs × 200 entries: nameKey runs once per celeb, not as a cross product", () => {
    const celebs = [];
    const akaById = new Map();
    const blacklistById = new Map();
    for (let i = 0; i < 30; i++) {
      const id = i + 1;
      celebs.push({
        id,
        name: `Celeb Number ${i}`,
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: `https://en.wikipedia.org/wiki/Celeb_Number_${i}`,
        wiki_url_de: `https://de.wikipedia.org/wiki/Celeb_Nummer_${i}`,
        age_at_pick: 40 + (i % 40),
      });
      akaById.set(id, [`Alias Name ${i}`]);
      blacklistById.set(id, []);
    }

    const entries = [];
    for (let j = 0; j < 200; j++) {
      entries.push({
        id: `e${j}`,
        text: `Obituary ${j} about nobody in particular, aged 70`,
        wikiPath: `/wiki/Unrelated_Person_${j}`,
      });
    }
    entries[0] = {
      id: "hit-alias",
      text: "Alias Name 3, 77, example",
      wikiPath: "/wiki/Alias_Name_3",
    };
    entries[10] = {
      id: "hit-url",
      text: "A blurb with no age",
      wikiPath: "/wiki/Celeb_Number_7",
    };
    // A later page for the same celeb must not replace the first hit.
    entries[80] = {
      id: "later-url",
      text: "Celeb Number 7, 99, too late",
      wikiPath: "/wiki/Celeb_Number_7",
    };

    const orig = db.nameKey;
    let calls = 0;
    db.nameKey = (s) => {
      calls += 1;
      return orig(s);
    };
    const RealURL = global.URL;
    const RealRegExp = global.RegExp;
    let urls = 0;
    let regs = 0;
    try {
      const index = buildPoolIndex(celebs, { akaById, blacklistById });
      assert.strictEqual(calls, 30, "index builds one nameKey per celeb");

      global.URL = function URL(u, b) {
        urls += 1;
        return new RealURL(u, b);
      };
      global.RegExp = function RegExp(p, f) {
        regs += 1;
        return new RealRegExp(p, f);
      };
      const hits = matchEntriesToIndex(index, entries, { mode: "auto" });
      assert.strictEqual(calls, 30, "matching must not call nameKey again");
      assert.notStrictEqual(calls, 30 * 200);
      assert.strictEqual(urls, 0, "confirmed misses must not reparse URLs");
      assert.strictEqual(regs, 0, "confirmed pool must not build token regexps");

      const aliasHit = hits.find((h) => h.celeb.id === 4);
      const urlHit = hits.find((h) => h.celeb.id === 8);
      assert.ok(aliasHit, "aka title is indexed on the celeb");
      assert.strictEqual(aliasHit.entry.id, "hit-alias");
      assert.strictEqual(aliasHit.payable, true);
      assert.strictEqual(aliasHit.age, 77);
      assert.ok(urlHit, "wiki path is indexed once per celeb");
      assert.strictEqual(urlHit.entry.id, "hit-url");
      assert.strictEqual(urlHit.age, 40 + (7 % 40));
    } finally {
      db.nameKey = orig;
      global.URL = RealURL;
      global.RegExp = RealRegExp;
    }
  });

  test("auto omits unconfirmed and excluded; announced keeps unconfirmed as not payable", () => {
    const unconfirmed = {
      id: 1,
      name: "Ada Lovelace",
      wiki_confirmed: 0,
      exclude_from_auto: 0,
      wiki_url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
      age_at_pick: 36,
    };
    const excluded = {
      id: 2,
      name: "Bob Dylan",
      wiki_confirmed: 1,
      exclude_from_auto: 1,
      wiki_url: "https://en.wikipedia.org/wiki/Bob_Dylan",
      age_at_pick: 83,
    };
    const confirmed = {
      id: 3,
      name: "Alan Turing",
      wiki_confirmed: 1,
      exclude_from_auto: 0,
      wiki_url: "https://en.wikipedia.org/wiki/Alan_Turing",
      age_at_pick: 41,
    };
    const celebs = [unconfirmed, excluded, confirmed];
    const index = buildPoolIndex(celebs, sides(celebs));
    const entries = [
      { text: "Ada Lovelace, 36, mathematician", wikiPath: "/wiki/Ada_Lovelace" },
      { text: "Bob Dylan, 83, songwriter", wikiPath: "/wiki/Bob_Dylan" },
      { text: "Alan Turing, 41, mathematician", wikiPath: "/wiki/Alan_Turing" },
    ];

    const auto = matchEntriesToIndex(index, entries, { mode: "auto" });
    assert.deepStrictEqual(
      auto.map((h) => h.celeb.id),
      [3]
    );
    assert.strictEqual(auto[0].payable, true);
    assert.ok(!auto.some((h) => h.celeb.id === 1 && h.payable));
    assert.ok(!auto.some((h) => !h.payable));

    const announced = matchEntriesToIndex(index, entries, { mode: "announced" });
    const ada = announced.find((h) => h.celeb.id === 1);
    const bob = announced.find((h) => h.celeb.id === 2);
    const alan = announced.find((h) => h.celeb.id === 3);
    assert.ok(ada, "announced mode still returns the unconfirmed celeb");
    assert.strictEqual(ada.payable, false);
    assert.ok(bob);
    assert.strictEqual(bob.payable, true);
    assert.ok(alan);
    assert.strictEqual(alan.payable, true);
  });

  test("auto discards unconfirmed before token regexps; announced builds them once", () => {
    const celebs = [];
    for (let i = 0; i < 5; i++) {
      celebs.push({
        id: i + 1,
        name: `Tokenperson${i} Lastname${i}`,
        wiki_confirmed: 0,
        exclude_from_auto: 1,
        age_at_pick: 50,
      });
    }
    const index = buildPoolIndex(celebs, sides(celebs));
    const entries = [];
    for (let j = 0; j < 40; j++) {
      entries.push({ text: `nothing relevant ${j}`, wikiPath: `/wiki/Nope_${j}` });
    }
    entries.push({
      text: "tokenperson0 lastname0 has died",
      wikiPath: "/wiki/Nope_final",
    });

    const RealRegExp = global.RegExp;
    let regs = 0;
    global.RegExp = function RegExp(p, f) {
      regs += 1;
      return new RealRegExp(p, f);
    };
    try {
      const auto = matchEntriesToIndex(index, entries, { mode: "auto" });
      assert.strictEqual(auto.length, 0);
      assert.strictEqual(regs, 0, "no token regexp before the auto filter");

      const announced = matchEntriesToIndex(index, entries, { mode: "announced" });
      assert.strictEqual(regs, 10, "five celebs × two tokens, not × entries");
      assert.strictEqual(announced.length, 1);
      assert.strictEqual(announced[0].celeb.id, 1);
      assert.strictEqual(announced[0].payable, false);
    } finally {
      global.RegExp = RealRegExp;
    }
  });

  test("index matches entryMatchesCeleb, including blacklist, aka, DE path and confirmed blurbs", () => {
    const celebs = [
      {
        id: 1,
        name: "Ada Lovelace",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
        wiki_url_de: "https://de.wikipedia.org/wiki/Ada_Lovelace",
        age_at_pick: 36,
      },
      {
        id: 2,
        name: "José Mourinho",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/Jos%C3%A9_Mourinho",
        age_at_pick: 61,
      },
      {
        id: 3,
        name: "Kim Jong Un",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/Kim_Jong_Un",
        age_at_pick: 40,
      },
      {
        id: 4,
        name: "Norma Jeane Mortenson",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/Norma_Jeane_Mortenson",
        age_at_pick: 36,
      },
      {
        id: 5,
        name: "Zaphod Beeblebrox",
        wiki_confirmed: 0,
        exclude_from_auto: 1,
        age_at_pick: 42,
      },
      {
        id: 6,
        name: "Ann Underwood",
        wiki_confirmed: 0,
        exclude_from_auto: 0,
        age_at_pick: 70,
      },
      { id: 7, name: "Li", wiki_confirmed: 0, exclude_from_auto: 0 },
      { id: 8, name: "Plato", wiki_confirmed: 0, exclude_from_auto: 0, age_at_pick: 80 },
      {
        id: 9,
        name: "Bob Dylan",
        wiki_confirmed: 1,
        exclude_from_auto: 1,
        wiki_url: "https://en.wikipedia.org/wiki/Bob_Dylan",
        age_at_pick: 83,
      },
      {
        id: 10,
        name: "Jean-Luc Picard",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "not a url",
        age_at_pick: 59,
      },
      {
        id: 11,
        name: "Helmut Kohl",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/Wrong_Person",
        wiki_url_de: "https://de.wikipedia.org/wiki/Helmut_Kohl",
        age_at_pick: 87,
      },
      {
        id: 12,
        name: "Ada Lovelace",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/Ada_Lovelace_(disambiguation)",
        age_at_pick: 20,
      },
      {
        id: 13,
        name: "Prince Nelson",
        wiki_confirmed: 0,
        exclude_from_auto: 0,
        age_at_pick: 57,
      },
      {
        id: 14,
        name: "The Pack",
        wiki_confirmed: 1,
        exclude_from_auto: 0,
        wiki_url: "https://en.wikipedia.org/wiki/The_Pack_(group)",
        age_at_pick: 20,
      },
    ];
    const akas = { 4: ["Marilyn Monroe"], 13: ["The Artist"] };
    const blacklist = { 2: ["football"] };
    const { akaById, blacklistById } = sides(celebs, akas, blacklist);
    const entries = [
      { text: "advisor to Kim Jong Un, 90, general", wikiPath: "/wiki/Some_General" },
      { text: "José Mourinho, 61, football manager", wikiPath: "/wiki/Jos%C3%A9_Mourinho" },
      { text: "José Mourinho, 61, Portuguese coach", wikiPath: "/wiki/Jose_Mourinho" },
      { text: "Ada Lovelace, 36, mathematician", wikiPath: "/wiki/Ada_Lovelace" },
      { text: "Marilyn Monroe, 36, actress", wikiPath: "/wiki/Marilyn_Monroe" },
      { text: "zaphod beeblebrox died aged 42", wikiPath: "/wiki/Other_Z" },
      { text: "lived under a bridge for years", wikiPath: "/wiki/Bridge" },
      { text: "ann underwood died at 70", wikiPath: "/wiki/Nope" },
      { text: "li died yesterday", wikiPath: "/wiki/Other_Page" },
      { text: "page about Li", wikiPath: "/wiki/Li" },
      { text: "plato, 80, philosopher", wikiPath: "/wiki/Nope2" },
      { text: "Jean-Luc Picard, 59, captain", wikiPath: "/wiki/Jean-Luc_Picard" },
      { text: "Helmut Kohl died in Germany", wikiPath: "/wiki/Helmut_Kohl" },
      { text: "Bob Dylan, 83, songwriter", wikiPath: "/wiki/Bob_Dylan" },
      { text: "the artist opened a show", wikiPath: "/wiki/Nope3" },
      { text: "prince only", wikiPath: "/wiki/Nope4" },
      { text: "The Pack (group) split up", wikiPath: "/wiki/The_Pack_(group)" },
      { text: "Ada Lovelace, 99, later blurb", wikiPath: "/wiki/Ada_Lovelace" },
    ];

    const index = buildPoolIndex(celebs, { akaById, blacklistById });
    const announced = matchEntriesToIndex(index, entries, { mode: "announced" });
    const expected = brute(celebs, entries, akaById, blacklistById);
    assert.strictEqual(announced.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.strictEqual(announced[i].celeb.id, expected[i].id);
      assert.strictEqual(announced[i].entry, expected[i].entry);
      assert.strictEqual(announced[i].age, expected[i].age);
      assert.strictEqual(announced[i].payable, announced[i].celeb.wiki_confirmed == 1);
    }
    assert.ok(!announced.some((h) => h.celeb.id === 3), "confirmed blurb mention is not a death");
    assert.ok(announced.some((h) => h.celeb.id === 5 && h.payable === false));

    const auto = matchEntriesToIndex(index, entries, { mode: "auto" });
    const autoExpected = expected.filter((h) => {
      const c = celebs.find((x) => x.id === h.id);
      return c.wiki_confirmed == 1 && c.exclude_from_auto != 1;
    });
    assert.deepStrictEqual(
      auto.map((h) => h.celeb.id),
      autoExpected.map((h) => h.id)
    );
    assert.ok(auto.every((h) => h.payable === true));
  });

  test("findPoolMatches loads aka once per auto celeb and keys each celeb once", () => {
    const insert = db.getDb().prepare(
      `INSERT INTO celebs (
         name, name_key, age_at_pick, is_alive, wiki_url,
         wiki_confirmed, manual_only, exclude_from_auto
       ) VALUES (?, ?, ?, 1, ?, ?, 0, ?)`
    );
    const alpha = insert.run(
      "Confirmed Alpha Person",
      db.nameKey("Confirmed Alpha Person"),
      70,
      "https://en.wikipedia.org/wiki/Confirmed_Alpha_Person",
      1,
      0
    ).lastInsertRowid;
    const beta = insert.run(
      "Confirmed Beta Person",
      db.nameKey("Confirmed Beta Person"),
      65,
      "https://en.wikipedia.org/wiki/Confirmed_Beta_Person",
      1,
      0
    ).lastInsertRowid;
    const gamma = insert.run(
      "Unconfirmed Gamma Person",
      db.nameKey("Unconfirmed Gamma Person"),
      44,
      null,
      0,
      1
    ).lastInsertRowid;
    db.addAka(alpha, "Quuxly Alias");
    db.addBlacklist(beta, "not this blurb");

    const entries = [];
    for (let j = 0; j < 30; j++) {
      entries.push({
        text: `filler obituary ${j}, 80`,
        wikiPath: `/wiki/Filler_${j}`,
      });
    }
    entries.push({
      text: "Quuxly Alias, 70, performer",
      wikiPath: "/wiki/Quuxly_Alias",
    });
    entries.push({
      text: "not this blurb Confirmed Beta Person, 65",
      wikiPath: "/wiki/Confirmed_Beta_Person",
    });
    entries.push({
      text: "Confirmed Beta Person, 65, clean",
      wikiPath: "/wiki/Confirmed_Beta_Person",
    });

    const origKey = db.nameKey;
    const origAka = db.getAkas;
    const origBl = db.getBlacklist;
    let keys = 0;
    let akas = 0;
    let bl = 0;
    db.nameKey = (s) => {
      keys += 1;
      return origKey(s);
    };
    db.getAkas = (id) => {
      akas += 1;
      return origAka(id);
    };
    db.getBlacklist = (id) => {
      bl += 1;
      return origBl(id);
    };
    try {
      const hits = findPoolMatches(entries);
      assert.strictEqual(keys, 2, "two auto celebs, not 2×30");
      assert.notStrictEqual(keys, 2 * entries.length);
      assert.strictEqual(akas, 2);
      assert.strictEqual(bl, 2);
      assert.deepStrictEqual(
        hits.map((h) => h.celeb.id).sort((a, b) => a - b),
        [alpha, beta].sort((a, b) => a - b)
      );
      const alphaHit = hits.find((h) => h.celeb.id === alpha);
      assert.strictEqual(alphaHit.entry.wikiPath, "/wiki/Quuxly_Alias");
      assert.strictEqual(alphaHit.payable, true);
      const betaHit = hits.find((h) => h.celeb.id === beta);
      assert.strictEqual(betaHit.entry.text, "Confirmed Beta Person, 65, clean");
      assert.ok(!hits.some((h) => h.celeb.id === gamma));
    } finally {
      db.nameKey = origKey;
      db.getAkas = origAka;
      db.getBlacklist = origBl;
    }

    const player = db.upsertPlayer({ displayName: "M9", discordUserId: "m9-user" });
    const opened = db.openAnnouncedSeason({
      year: 2099,
      startDate: "2099-01-01",
      channelId: "chan-m9",
      note: "m9",
    });
    db.setPick(player.id, gamma, opened.season.id);

    const announcedEntries = [];
    for (let j = 0; j < 25; j++) {
      announcedEntries.push({ text: `quiet ${j}`, wikiPath: `/wiki/Quiet_${j}` });
    }
    announcedEntries.push({
      text: "unconfirmed gamma person died aged 44",
      wikiPath: "/wiki/Quiet_gamma",
    });

    let announcedKeys = 0;
    let announcedAkas = 0;
    db.nameKey = (s) => {
      announcedKeys += 1;
      return origKey(s);
    };
    db.getAkas = (id) => {
      announcedAkas += 1;
      return origAka(id);
    };
    try {
      const hits = findPoolMatchesForAnnounced(announcedEntries);
      const pool = hits.filter((h) => h.celeb.id === gamma);
      assert.strictEqual(pool.length, 1);
      assert.strictEqual(pool[0].payable, false);
      assert.strictEqual(announcedKeys, 1, "one announced celeb, not one key per entry");
      assert.strictEqual(announcedAkas, 1);
      assert.ok(announcedKeys < announcedEntries.length);
    } finally {
      db.nameKey = origKey;
      db.getAkas = origAka;
    }
  });
});
