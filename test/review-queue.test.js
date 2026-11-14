const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Isoliertes DB-Verzeichnis + Admin-Env VOR jedem Module-Require (Konvention).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-review-queue-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.CHANNEL_ADMIN = ""; // kein Admin-Channel → Fallback = msg.channel
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const celebReview = require("../src/discord/celeb-review");
const reviewCmd = require("../src/discord/commands/review");

let config;
before(() => {
  config = loadConfig();
  db.openDb(config);
  // Produktionszustand: aktive Saison ist running+live, dazu eine announced-Saison.
  db.setSeasonLive(true);
  db.getDb().prepare("UPDATE seasons SET phase = 'running' WHERE active = 1").run();
  db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "99", note: "" });
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

const announcedSeason = () => db.getAnnouncedSeason();
const runningSeason = () => db.getActiveSeason();

/** Celeb anlegen und mit einem fülligen Vorschlag in die angegebene Saison einreihen. */
function enqueueAnnounced(name, { qid = null } = {}) {
  const c = db.findOrCreateCeleb({ name, age: 60 });
  const wikidataId = qid || `Q${Math.floor(100000 + Math.random() * 899999)}`;
  const norm = `en:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const url = `https://en.wikipedia.org/wiki/${name.replace(/ /g, "_")}`;
  const r = db.enqueueReview(
    c.celeb.id,
    {
      wikiUrl: url,
      wikiNorm: norm,
      proposedAge: 60,
      lang: "en",
      candidates: [{ title: name, url, norm, lang: "en", proposedAge: 60, qid: wikidataId }],
    },
    { seasonId: announcedSeason().id }
  );
  assert.strictEqual(r.queued, true, `enqueue ${name} in announced must succeed`);
  return { celeb: c.celeb, wikidataId, norm, url };
}

// ---------------------------------------------------------------- F12 -------------

test("F12: scope:pool zählt nur den laufenden Pool, nicht fremde (announced) Saisons", () => {
  const announced = announcedSeason();
  // 3 announced-pending, KEINE pool-pending
  enqueueAnnounced("Pool Only A");
  enqueueAnnounced("Pool Only B");
  enqueueAnnounced("Pool Only C");

  // Anmeldung sieht ihre 3
  assert.strictEqual(db.countPendingReviews({ seasonId: announced.id }), 3);

  // Pool (default-Pfad ohne seasonId) sieht 0 — nicht 3
  assert.strictEqual(db.countPendingReviews(), 0, "pool count must ignore announced rows");
  assert.strictEqual(
    db.countPendingReviews({ seasonId: db.getActiveSeason().id }),
    0,
    "active season has its own pending count 0"
  );

  // Der aktive Season-Weg von nextPendingReview(null) liefert auch nichts → konsistent
  assert.strictEqual(db.nextPendingReview(null), undefined, "pool has nothing to serve");
});

test("F12: /review scope:pool bricht bei 0 Pool-Karten sauber ab, ohne announced-Karte zu liefern", async () => {
  // Zustand aus dem vorigen Test: 3 announced-pending, 0 pool-pending.
  const replies = [];
  const msg = { reply: async (m) => replies.push(typeof m === "string" ? m : (m && m.content) || m) };
  const ctx = { config: { channelAdmin: "", prefix: "!" } };

  await reviewCmd.run(ctx, ["pool"], msg);

  // GENAU eine Antwort: die Leer-Meldung. Vor dem Fix kam „3 offen (laufender Pool)…
  // Nächste Karte:” + „Review-Warteschlange leer.” — Beweis, dass sendNextReview
  // hier nicht mit einer (announced-)ID gerufen wird.
  assert.strictEqual(replies.length, 1, "only one reply expected");
  assert.strictEqual(replies[0], "Review-Warteschlange ist leer.");
});

// ---------------------------------------------------------------- F13 -------------

test("F13: Confirm mit QID-Merge hält die announced-Saison für die nächste Karte", async () => {
  const announced = announcedSeason();
  const running = runningSeason();

  // Self-contained: F12-Tests haben announced-Karten hinterlassen, die hier sonst
  // als „nächste Karte“ vorziehen würden (Aufsteigen nach Queue-ID).
  db.getDb().prepare("DELETE FROM celeb_review_queue").run();
  assert.strictEqual(db.countPendingReviews(), 0, "pool clean");
  assert.strictEqual(db.countPendingReviews({ seasonId: announced.id }), 0, "announced clean");

  // 2026er-Kanonik: bereits bestätigt mit QID + running-Pick (bleibt unberührt).
  const canon = db.findOrCreateCeleb({ name: "Canonical Figure", age: 55 });
  db.applyWikiConfirm(canon.celeb.id, {
    wikiUrl: "https://en.wikipedia.org/wiki/Canonical_Figure",
    wikiNorm: "en:canonical_figure",
    wikidataId: "Q900001",
    age: 55,
  });
  const p = db.upsertPlayer({ displayName: "Merger", discordUserId: "77001" });
  db.setPick(p.id, canon.celeb.id, running.id);
  assert.strictEqual(db.celebHasRunningPick(canon.celeb.id), true);

  // 2027er-Dublette: gleiche Person (Q900001 als Kandidat) — confirm merge't sie.
  // Separat anlegen (findOrCreateCeleb macht wegen bestätigtem Namen eine neue Zeile).
  const dup = db.findOrCreateCeleb({ name: "Canonical Figure", age: 60 });
  const dupNorm = "en:canonical_figure";
  const dupUrl = "https://en.wikipedia.org/wiki/Canonical_Figure";
  const dupQueue = db.enqueueReview(
    dup.celeb.id,
    {
      wikiUrl: dupUrl,
      wikiNorm: dupNorm,
      proposedAge: 60,
      lang: "en",
      candidates: [{ title: "Canonical Figure", url: dupUrl, norm: dupNorm, lang: "en", proposedAge: 60, qid: "Q900001" }],
    },
    { seasonId: announced.id }
  );
  assert.strictEqual(dupQueue.queued, true);

  // Zweite announced-Karte: MUSS nach dem Merge als Nächstes kommen.
  const nextAnnounced = enqueueAnnounced("Second Announced Figure (B1)");

  // Lockvogel im laufenden Pool: würde beim (alten) aktiven-Fallback stattdessen erscheinen.
  const poolDecoy = db.findOrCreateCeleb({ name: "Pool Decoy Figure", age: 70 });
  const decoyNorm = "en:pool_decoy_figure";
  const decoyUrl = "https://en.wikipedia.org/wiki/Pool_Decoy_Figure";
  db.enqueueReview(
    poolDecoy.celeb.id,
    { wikiUrl: decoyUrl, wikiNorm: decoyNorm, proposedAge: 70, lang: "en" },
    { seasonId: running.id }
  );
  assert.ok(db.countPendingReviews({ seasonId: running.id }) >= 1, "pool decoy present");

  // sendNextReview-Ziel: fake channel zeichnet die gesendete Karte auf.
  let sent = [];
  const channel = { send: async (payload) => sent.push(payload) };

  const interaction = {
    customId: celebReview.reviewCustomId("confirm", dup.celeb.id),
    user: { id: "1" },
    channel,
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isRepliable: () => true,
    update: async (payload) => sent.push({ __update: payload }),
    reply: async () => {},
    deferUpdate: async () => {},
  };

  await celebReview.handleReviewInteraction(
    { config: { adminId: "1", userAgent: "test" } },
    interaction
  );

  // Merge passiert: kanonik ist wiederverwendet, Dublette weg.
  const merged = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(canon.celeb.id);
  assert.strictEqual(merged.wiki_confirmed, 1);
  assert.strictEqual(merged.wikidata_id, "Q900001");
  assert.strictEqual(
    db.getDb().prepare("SELECT COUNT(*) c FROM celeb_review_queue WHERE celeb_id = ?").get(dup.celeb.id).c,
    0,
    "duplicate queue row must be gone after merge"
  );

  // Die nächste Karte kam AUS DER ANNOUNCED-QUEUE (nicht dem Pool-Lockvogel).
  const cardSent = sent.find((s) => s && s.embeds && s.embeds.length);
  assert.ok(cardSent, "sendNextReview must have sent a card after confirm");
  const title = cardSent.embeds[0].data.title;
  assert.match(title, /Second Announced Figure/, `served card should be the announced one, got: ${title}`);
  assert.doesNotMatch(title, /Pool Decoy/, "must NOT fall back to the running-season queue");

  // Und die zweite announced-Karte trägt weiterhin die announced-Season-ID.
  const q = db
    .getDb()
    .prepare("SELECT season_id FROM celeb_review_queue WHERE celeb_id = ?")
    .get(nextAnnounced.celeb.id);
  assert.strictEqual(q.season_id, announced.id, "second pending card keeps the announced season id");
});
