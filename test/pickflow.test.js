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
// canParticipate wird für die Flow-Tests auf einen announced-Test-Spieler
// gestubbt (kein echter Discord-Fetch) — Membership-Modul VOR pick-assistant
// laden, damit dessen Destructuring die Stub-Referenz erwischt.
const membership = require("../src/discord/membership");
membership.canParticipate = async () => {
  const g = db.getAnnouncedSeason();
  return g ? { ok: true, season: g } : { ok: false, reason: "closed" };
};
before(() => {
  config = loadConfig();
  db.openDb(config);
  db.setSeasonLive(true);
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
  db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "cT1", note: null });
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

test("global draft cap: addDraftNames across DMs never exceeds maxNames", () => {
  db.openAnnouncedSeason({
    year: 2027,
    startDate: "2027-01-01",
    channelId: "777",
    note: null,
  });
  const season = db.getAnnouncedSeason();
  const pid = db.getDb().prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('Capper','654','0')").run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);

  // ein Limit von 3: drei DMs à 2 Namen -> nur 3 landen im Draft
  const names = Array.from({ length: 6 }, (_, i) => `Name ${i + 1}`);
  const cap = 3;
  const r1 = db.addDraftNames(draft.id, names.slice(0, 2), { maxNames: cap });
  const r2 = db.addDraftNames(draft.id, names.slice(2, 5), { maxNames: cap });
  const r3 = db.addDraftNames(draft.id, names.slice(5), { maxNames: cap });
  assert.strictEqual(r1.added, 2);
  assert.strictEqual(r2.added, 1, "second DM only fills up to cap");
  assert.strictEqual(r2.truncated, true, "excess reported");
  assert.strictEqual(r3.added, 0, "draft full -> nothing added");
  assert.strictEqual(db.listDraftEntries(draft.id).length, cap);
  assert.strictEqual(r3.limit, cap);
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

// Netz-unabhängig testen: die page-lookup-Modulexporte werden VOR dem Laden von
// pick-assistant überschrieben (dessen Destructuring fängt die Referenzen beim
// eigenen Modul-Load ein). So laufen die DM-Flow-Tests ohne Wikipedia-Aufrufe.
const pageLookup = require("../src/wiki/page-lookup");
pageLookup.proposeWikiForName = async () => ({
  wikiUrl: null,
  wikiNorm: null,
  qid: null,
  proposedAge: null,
  candidates: [],
});
pageLookup.lookupUrl = async () => {
  throw new Error("network stubbed out — no lookup in tests");
};
test("F14: wiki death date (entry) before start, detected after start → warned", () => {
  const season = db.getAnnouncedSeason();
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('DecDead','659d','0')")
    .run().lastInsertRowid;

  // Echter Todesfall: Gestorben am 20.12.2026, aber erst am 02.01.2027 erkannt.
  // start_date der announced-Saison ist 2027-01-01 → died_at (2026-12-20) liegt
  // VOR dem Start, detection liegt NACH dem Start.
  const cid = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         died_at, death_detected_at, death_confirmed, wiki_confirmed)
       VALUES ('Dec Corpse','deccorpse','https://en.wikipedia.org/wiki/Dec_Corpse','QDec',
         0, '2026-12-20', '2027-01-02 06:00:00', 0, 1)`
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, cid, season.id);

  // F14b: ein Wiki-Todestag vor dem Start muss gewarnt werden, obwohl die
  // Erkennung nach dem Start liegt.
  const rows = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  const mine = rows.find((r) => r.celeb_id === cid);
  assert.ok(mine, "died_at < start_date must warn even when detected after start");
  assert.strictEqual(mine.celeb_died_at, "2026-12-20");

  // Gegenprobe (F14b): KEIN Wiki-Datum + Erkennung NACH dem Start -> KEINE Warnung.
  const lateNoDate = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         died_at, death_detected_at, death_confirmed, wiki_confirmed)
       VALUES ('Late Unknown','lateunknown','https://en.wikipedia.org/wiki/Late_Unknown','QLate',
         0, NULL, '2027-01-05 10:00:00', 0, 1)`
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, lateNoDate, season.id);
  const rows2 = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(
    !rows2.some((r) => r.celeb_id === lateNoDate),
    "detected-after-start without a wiki date must NOT count as pre-start"
  );

  // Positive Kontrolle: gleiche datumslose Zeile, aber erkannnt VOR dem Start.
  const earlyNoDate = db
    .getDb()
    .prepare(
      `INSERT INTO celebs (name, name_key, wiki_url, wikidata_id, is_alive,
         died_at, death_detected_at, death_confirmed, wiki_confirmed)
       VALUES ('Early Unknown','earlyunknown','https://en.wikipedia.org/wiki/Early_Unknown','QEarly',
         0, NULL, '2026-12-28 02:00:00', 0, 1)`
    )
    .run().lastInsertRowid;
  db.getDb()
    .prepare("INSERT INTO picks (player_id, celeb_id, season_id) VALUES (?, ?, ?)")
    .run(pid, earlyNoDate, season.id);
  const rows3 = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  assert.ok(
    rows3.some((r) => r.celeb_id === earlyNoDate),
    "detected-before-start without a wiki date still warns"
  );
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

// ---- Tipp-Assistent DM-Flow-Tests (F09/F10/F19a) ----

/** Baut eine Fake-DM (ctx + msg + author) für tryConsumePickMessage. */
function fakeCtx(authorId, displayName, opts = {}) {
  const replies = [];
  const sends = [];
  const chan = {
    id: "chan",
    replies,
    sends,
    async reply(...args) {
      replies.push(args);
      return null;
    },
    async send(...args) {
      sends.push(args);
      return { edit: async () => {} };
    },
  };
  const client = {
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };
  const ctx = {
    client,
    config: {
      ...loadConfig(),
      maxPicksPerPlayer: opts.maxPicksPerPlayer ?? 50,
      channelLog: "",
    },
  };
  const msg = {
    guildId: null,
    channel: chan,
    author: { id: String(authorId), username: displayName || String(authorId) },
    content: "",
    reply: (...args) => chan.reply(...args),
  };
  return { ctx, msg };
}

function lastReply(replies) {
  return replies.length ? String(replies[replies.length - 1][0]?.content ?? replies[replies.length - 1][0]) : "";
}

async function sendPick(ctx, msg, text) {
  msg.content = String(text);
  return assistant.tryConsumePickMessage(ctx, msg);
}

function playerId(authorId) {
  return db
    .getDb()
    .prepare("SELECT id FROM players WHERE discord_user_id = ?")
    .get(String(authorId))?.id || null;
}

function draftFor(authorId, seasonId) {
  const pid = playerId(authorId);
  return pid ? db.getDraftForPlayer(pid, seasonId) : null;
}

/** Laufender Auto-Resolver ist fire-and-forget — in Tests nachlaufen lassen. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test("F10: second paste of same name does not add a second line and reports Duplikat", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F10user", "F10 User");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F10 User','F10user','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);

  // erste DM: Merkel
  await sendPick(ctx, msg, "Merkel");
  let entries = db.listDraftEntries(draft.id);
  assert.strictEqual(entries.length, 1, "first Merkel lands in draft");
  const firstId = entries[0].id;

  // zweite DM: Merkel erneut -> KEINE neue Zeile, Doppel-Meldung
  const res = await sendPick(ctx, msg, "Merkel");
  assert.strictEqual(res, true, "message consumed");
  await settle();
  entries = db.listDraftEntries(draft.id);
  assert.strictEqual(entries.length, 1, "second Merkel must not add a line");
  assert.strictEqual(entries[0].id, firstId, "original line untouched");
  const text = msg.channel.replies.map((r) => String(r[0]?.content ?? r[0])).join("\n");
  assert.match(text, /Doppelt/i, "DM names the duplicate");
});

test("F10: different accent case is still the same name across DMs", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F10buser", "F10b User");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F10b','F10buser','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  await sendPick(ctx, msg, "Jürgen Müller");
  await sendPick(ctx, msg, "Jurgen Muller");
  await settle();
  assert.strictEqual(db.listDraftEntries(draft.id).length, 1, "accent-normalized duplicate must fold");
});

test("F09: `ändern 3 Neuer Name` changes line 3 and adds NO new name", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F09user", "F09 User");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F09 User','F09user','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Person A", "Person B", "Person C"]);

  const res = await sendPick(ctx, msg, "ändern 3 Neuer Name");
  assert.strictEqual(res, true, "CHANGE command consumed");
  await settle();
  const entries = db.listDraftEntries(draft.id);
  assert.strictEqual(entries.length, 3, "no new name appended");
  assert.strictEqual(entries[2].raw_name, "Neuer Name", "line 3 replaced");
});

test("F09: regex also matches aendere/ändere/change variants", () => {
  for (const cmd of ["aendere 2 X", "ändere 1 Y", "aendern 2 Z", "change 1 Foo", "ändern 2 Bar"]) {
    assert.ok(assistant.CHANGE_RE.test(cmd), `CHANGE_RE must match: ${cmd}`);
  }
  assert.ok(!assistant.CHANGE_RE.test("ändern Foo"), "no number -> no match");
});

test("F09: command-like typo is not imported as a name", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F09cuser", "F09c");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F09c','F09cuser','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);

  const res = await sendPick(ctx, msg, "aendrn 3 Jemand");
  assert.strictEqual(res, false, "unknown cmd-like line not consumed as a name");
  assert.strictEqual(db.listDraftEntries(draft.id).length, 0, "no draft entry created");
});

test("F19a: fertig on empty draft says names missing, not unknown name", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F19auser", "F19a");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F19a','F19auser','0')")
    .run().lastInsertRowid;
  db.getOrCreateDraft(pid, season.id);

  const res = await sendPick(ctx, msg, "fertig");
  assert.strictEqual(res, true);
  const text = lastReply(msg.channel.replies);
  assert.match(text, /noch keine Namen/i, "empty draft gets its own message");
  assert.ok(!/unklar/i.test(text), "must not say 'unklar'");
});

test("F10: truncation text no longer suggests splitting into multiple DMs", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F10tuser", "F10t", { maxPicksPerPlayer: 5 });
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F10t','F10tuser','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Keep A", "Keep B", "Keep C", "Keep D"], { maxNames: 5 });

  const res = await sendPick(ctx, msg, "A; B; C; D; E; F; G; H");
  assert.strictEqual(res, true);
  await settle();
  const text = lastReply(msg.channel.replies);
  assert.match(text, /erkannt/i, "recognized count mentioned");
  assert.ok(!/mehrere Meldungen/i.test(text), "splitting hint removed");
  assert.match(text, /entfernen/i, "only 'removing' frees space");
  assert.strictEqual(db.listDraftEntries(draft.id).length, 5, "cap reached");
});

// ---- F08: Wiki-URL-Auflösung und Race-Schutz ----

function rawEntry(authorId, seasonId, index = 0) {
  const pid = playerId(authorId);
  const draft = db.getDraftForPlayer(pid, seasonId);
  return db.listDraftEntries(draft.id)[index];
}

test("F08: bare URL binds to the entry, claim survives until lookup resolves", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F08user", "F08 User");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F08 User','F08user','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Manuel Person"]);

  // lookupUrl auf „Erfolg” schalten, damit der Link-Pfad durchläuft
  const origLookup = pageLookup.lookupUrl;
  pageLookup.lookupUrl = async (ua, url) => ({
    wikiUrl: "https://en.wikipedia.org/wiki/Resolved_Page",
    wikiNorm: "en:resolved_page",
    qid: "QR",
    proposedAge: 42,
    title: "Resolved Page",
    candidates: [],
  });
  try {
    const res = await sendPick(ctx, msg, "https://de.wikipedia.org/wiki/Manuel_Person");
    assert.strictEqual(res, true, "bare URL consumed");
    await settle();
    const e = rawEntry("F08user", season.id);
    assert.strictEqual(e.link_status, "linked", "URL resolved the entry");
    assert.strictEqual(e.wiki_norm, "en:resolved_page");
  } finally {
    pageLookup.lookupUrl = origLookup;
  }
});

test("F08: failed URL leaves the entry NOT pending (no fertig deadlock)", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F08buser", "F08b");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F08b','F08buser','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Mister Fail"]);

  // lookupUrl bleibt der Stub, der WIRFT -> Link-Pfad fängt, markiert unlinked
  const res = await sendPick(ctx, msg, "https://en.wikipedia.org/wiki/Nope");
  assert.strictEqual(res, true);
  await settle();
  const e = rawEntry("F08buser", season.id);
  assert.strictEqual(e.link_status, "unlinked", "failed URL must not stay pending (F8/F08a)");
});

test("F08: link N <url> while a resolver run is active is NOT ignored (rerun + interrupt)", async () => {
  const season = db.getAnnouncedSeason();
  const { ctx, msg } = fakeCtx("F08cuser", "F08c");
  const pid = db
    .getDb()
    .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES ('F08c','F08cuser','0')")
    .run().lastInsertRowid;
  const draft = db.getOrCreateDraft(pid, season.id);
  db.addDraftNames(draft.id, ["Ziel Person", "Andere Person"]);
  const entries = db.listDraftEntries(draft.id);

  // laufenden Auto-Lauf simulieren und `link 1 <url>` schicken
  const origLookup = pageLookup.lookupUrl;
  pageLookup.lookupUrl = async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { wikiUrl: "https://en.wikipedia.org/wiki/Keanu_Reeves", wikiNorm: "en:keanu_reeves", qid: "Q1", proposedAge: 60, title: "Keanu Reeves", candidates: [] };
  };
  try {
    await assistant.resolvePendingSynchronous(ctx, msg.channel, "F08cuser", season, draft.id, "add");
    assert.strictEqual(assistant.busyUsers.has("F08cuser"), false, "run must clear busyUsers in finally");
    assert.strictEqual(assistant.interruptUsers.has("F08cuser"), false, "interrupt cleared after real run");

    // jetzt eine DM während eines laufenden Runs (busyUsers set) -> wird NICHT drippt
    assistant.busyUsers.add("F08cuser");
    try {
      const res = await sendPick(ctx, msg, "link 1 https://en.wikipedia.org/wiki/Keanu_Reeves");
      assert.strictEqual(res, true, "link DM consumed even while busy");
      assert.strictEqual(assistant.rerunUsers.has("F08cuser"), true, "rerun requested so the link is applied");
      assert.strictEqual(assistant.interruptUsers.has("F08cuser"), true, "running resolver interrupted");
      // Claim ist bereits in der Zeile gespeichert
      const e = db.listDraftEntries(draft.id)[0];
      assert.strictEqual(e.link_status, "pending", "entry claimed pending");
      assert.ok(/keanu/i.test(String(e.wiki_url)), "URL stored in draft line before async");
    } finally {
      assistant.busyUsers.delete("F08cuser");
      assistant.interruptUsers.delete("F08cuser");
      assistant.rerunUsers.delete("F08cuser");
    }
  } finally {
    pageLookup.lookupUrl = origLookup;
  }
});
