const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-pickflow-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const { parsePickList } = require("../src/discord/pick-parse");

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

test("parser: huge paste is truncated at 50 names", () => {
  const many = Array.from({ length: 70 }, (_, i) => `Name ${i + 1}`).join("; ");
  const res = parsePickList(many);
  assert.strictEqual(res.truncated, true);
  assert.strictEqual(res.names.length, 50);
});

test("parser: normal list not truncated", () => {
  const res = parsePickList("Keanu Reeves; Viggo Mortensen\nBill Murray");
  assert.strictEqual(res.truncated, undefined);
  assert.strictEqual(res.names.length, 3);
});

test("unlock: draft -> finalize -> unlock -> draft again", () => {
  db.openAnnouncedSeason({
    year: 2027,
    startDate: "2027-01-01",
    channelId: "777",
    note: null,
  });
  const season = db.getAnnouncedSeason();
  const pid = db.getDb().prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('Tester','655','0')").run().lastInsertRowid;

  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Keanu Reeves", "Bill Murray"]);
  // wiki_resolution direkt simulieren (kein Netz): als linked markieren
  const entries = db.listDraftEntries(draft.id);
  entries.forEach((e) =>
    db.setDraftEntryLinked(e.id, {
      wikiUrl: `https://en.wikipedia.org/wiki/${e.raw_name.replace(/ /g, "_")}`,
      wikiNorm: e.raw_name.toLowerCase(),
      qid: "Q" + e.id,
      proposedAge: 60,
      linkStatus: "linked",
    })
  );

  const fin = db.finalizeDraft(pid, season.id);
  assert.strictEqual(fin.error, undefined);
  assert.ok(fin.added === 2);

  // Nach Lock: finale picks vorhanden
  const picks = db.getAnnouncedSeasonPicksForPlayer(pid, season.id);
  assert.strictEqual(picks.length, 2);

  // Unlock -> darf wieder editieren
  const un = db.unlockDraftForPlayer(pid, season.id);
  assert.strictEqual(un.unlocked, true);
  const after = db.getDraftForPlayer(pid, season.id);
  assert.strictEqual(after.status, "draft");
  // picks entfernt -> erneutes finalize erzeugt sie neu
  assert.strictEqual(db.getAnnouncedSeasonPicksForPlayer(pid, season.id).length, 0);
});

test("pre-start death warning rows", () => {
  const season = db.getAnnouncedSeason();
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('Tester2','656','0')")
    .run().lastInsertRowid;
  const cid = db
    .getDb()
    .prepare(
      "INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive, died_at, wiki_confirmed) VALUES ('Xy Test','xytest','https://en.wikipedia.org/wiki/Xy_Test','QXy',0,'2026-11-10',1)"
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, season.id);

  const rows = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(rows.some((r) => r.celeb_id === cid), "dead celeb in announced picks must be found");
  assert.strictEqual(String(rows[0].celeb_died_at) <= String(season.start_date), true);

  // einmal gewarnt -> nicht mehr geliefert
  db.markAnnouncedDeathWarned(season.id, pid, cid);
  const again = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(!again.some((r) => r.celeb_id === cid), "warned rows must not repeat");
});

const assistant = require("../src/discord/pick-assistant");

test("url-target: bare URL binds to next non-linked entry", () => {
  const entries = [
    { id: 1, link_status: "linked" },
    { id: 2, link_status: "ambiguous" },
    { id: 3, link_status: "pending" },
    { id: 4, link_status: "unlinked" },
  ];
  assert.strictEqual(assistant.targetForUrlPaste(entries).id, 3, "pending first");
  const withPendingGone = entries.filter((e) => e.id !== 3);
  assert.strictEqual(assistant.targetForUrlPaste(withPendingGone).id, 2, "then ambiguous");
  const onlyUnlinked = entries.filter((e) => e.id === 4);
  assert.strictEqual(assistant.targetForUrlPaste(onlyUnlinked).id, 4);
  const allLinked = entries.filter((e) => e.id === 1);
  assert.strictEqual(assistant.targetForUrlPaste(allLinked), null, "all linked -> no target");
});

test("command regexes match user input", () => {
  assert.ok(assistant.WIKI_URL_RE.test("https://en.wikipedia.org/wiki/Keanu_Reeves"));
  assert.ok(assistant.WIKI_URL_RE.test("de.wikipedia.org/wiki/Karl_Lagerfeld"));
  assert.ok(!assistant.WIKI_URL_RE.test("Keanu Reeves"));
  assert.ok(assistant.LINK_URL_RE.test("link 3 https://en.wikipedia.org/wiki/X"));
  assert.ok(assistant.LINK_URL_RE.test("link 2 de.wikipedia.org/wiki/X"));
  assert.ok(assistant.WRONG_RE.test("falsch"));
  assert.ok(assistant.WRONG_RE.test("falsch 3"));
  assert.ok(assistant.WRONG_RE.test("nein 2"));
});

test("R2-2: relink ohne qid löscht das alte qid (kein COALESCE-Stale)", () => {
  const season = db.getAnnouncedSeason();
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('R2T','657','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Alpha Test"]);
  const e = db.listDraftEntries(draft.id)[0];

  // erst Person A mit qid QA verlinken
  db.setDraftEntryLinked(e.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Alpha_Test",
    wikiNorm: "alpha test",
    qid: "QA",
    linkStatus: "linked",
  });
  assert.strictEqual(db.listDraftEntries(draft.id)[0].qid, "QA");

  // relink auf Person B OHNE qid (Seite hat keine Wikidata) → QA muss weg
  db.setDraftEntryLinked(e.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Beta_Test",
    wikiNorm: "beta test",
    qid: null,
    linkStatus: "linked",
  });
  const after = db.listDraftEntries(draft.id)[0];
  assert.strictEqual(after.qid, null, "stale qid must be cleared on relink");
  assert.strictEqual(after.wiki_norm, "beta test");

  // qid undefined = Teil nicht angefasst (z.B. nur linkStatus-Update)
  db.setDraftEntryLinked(e.id, { wikiUrl: "https://en.wikipedia.org/wiki/Beta_Test", wikiNorm: "beta test", qid: "QB", linkStatus: "linked" });
  db.setDraftEntryLinked(e.id, { linkStatus: "linked" });
  assert.strictEqual(db.listDraftEntries(draft.id)[0].qid, "QB", "undefined qid keeps existing");
});

test("R2-3: Confirm (ohne Alter-Button) übernimmt Alter auf picks.age_at_pick", () => {
  db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "c1", note: null });
  const season = db.getAnnouncedSeason();
  assert.ok(season, "announced season must exist");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('R2A','658','0')")
    .run().lastInsertRowid;
  const c = db.findOrCreateCeleb({ name: "Aged Person", age: null });
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id, age_at_pick) VALUES (?, ?, ?, NULL)")
    .run(pid, c.celeb.id, season.id);
  // Die Queue-Zeile MUSS die announced-Saison tragen, damit applyWikiConfirm
  // in den announced-Zweig läuft (sonst läuft der 2026er-Branch).
  db.enqueueReview(c.celeb.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Aged_Person",
    wikiNorm: "en:aged_person",
    proposedAge: 67,
  }, { seasonId: season.id });

  db.applyWikiConfirm(c.celeb.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Aged_Person",
    wikiNorm: "en:aged_person",
    age: 67,
    manualOnly: false,
  });

  const pick = db
    .getDb()
    .prepare("SELECT age_at_pick FROM picks WHERE celeb_id = ? AND season_id = ?")
    .get(c.celeb.id, season.id);
  assert.strictEqual(pick.age_at_pick, 67, "confirm alone must fill picks.age_at_pick");
});
