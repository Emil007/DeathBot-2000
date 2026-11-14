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

// ---------------------------------------------------------------- M16 -------------

const { MessageFlags } = require("discord.js");
const SCOPE_REJECT = "`anmeldung` oder `pool`.";
const REVIEW_INTRO =
  "Erst **Bestätigen**, dann zählt der automatische Abgleich. **Kein Wiki** heißt: nie automatisch als tot werten.";
const LOOKUP_FAIL =
  "Lookup fehlgeschlagen. Die URL ist keine Wikipedia-Seite, oder Wikipedia antwortet nicht.";

function pageLookupMod() {
  return require("../src/wiki/page-lookup");
}

async function withLookupStubs(overrides, fn) {
  const mod = pageLookupMod();
  const prev = {
    proposeWikiForName: mod.proposeWikiForName,
    lookupUrl: mod.lookupUrl,
  };
  Object.assign(mod, overrides);
  try {
    await fn();
  } finally {
    mod.proposeWikiForName = prev.proposeWikiForName;
    mod.lookupUrl = prev.lookupUrl;
  }
}

function replyText(payload) {
  return typeof payload === "string" ? payload : payload?.content;
}

test("M16: Review-Buttons heißen deutsch und bleiben unter 80 Zeichen", () => {
  const labels = celebReview
    .buildReviewButtons(1)
    .toJSON()
    .components.map((c) => c.label);
  assert.deepStrictEqual(labels, [
    "Bestätigen",
    "Falscher Link",
    "Alter setzen",
    "Kein Wiki",
    "Überspringen",
  ]);
  for (const label of labels) assert.ok(label.length <= 80, label);
});

test("M16: scope ist eine Slash-Choice anmeldung|pool", () => {
  const opt = reviewCmd.options.find((o) => o.name === "scope");
  assert.deepStrictEqual(
    opt.choices.map((c) => c.value),
    ["anmeldung", "pool"]
  );
  assert.deepStrictEqual(
    reviewCmd.parseSlash({ options: { getString: () => "anmeldung" } }),
    ["scope:anmeldung"]
  );
  assert.deepStrictEqual(reviewCmd.parseSlash({ options: { getString: () => null } }), []);
});

test("M16: scope:poool und andere Tippfehler öffnen die Queue nicht", async () => {
  const origCount = db.countPendingReviews;
  const origNext = db.nextPendingReview;
  let opened = 0;
  db.countPendingReviews = (...a) => {
    opened += 1;
    return origCount(...a);
  };
  db.nextPendingReview = (...a) => {
    opened += 1;
    return origNext(...a);
  };
  try {
    for (const arg of ["scope:poool", "poool", "scope:next", "next", "scope:poolfoo"]) {
      const replies = [];
      let sent = 0;
      const msg = {
        reply: async (m) => replies.push(replyText(m)),
        channel: { send: async () => { sent += 1; } },
        author: { id: "1" },
      };
      await reviewCmd.run({ config: { channelAdmin: "", prefix: "!" } }, [arg], msg);
      assert.deepStrictEqual(replies, [SCOPE_REJECT], arg);
      assert.strictEqual(sent, 0, arg);
    }
    assert.strictEqual(opened, 0, "invalid scope must not read the queue");
  } finally {
    db.countPendingReviews = origCount;
    db.nextPendingReview = origNext;
  }
});

test("M16: ohne Argument bleibt Anmeldung, scope:pool bleibt der laufende Pool", async () => {
  await withLookupStubs(
    {
      proposeWikiForName: async () => {
        throw new Error("propose should not run for cards that already have a url");
      },
    },
    async () => {
      if (db.countPendingReviews({ seasonId: announcedSeason().id }) === 0) {
        enqueueAnnounced("Default Scope Figure");
      }
      const announcedReplies = [];
      const announcedMsg = {
        reply: async (m) => announcedReplies.push(replyText(m)),
        channel: { send: async () => {} },
        author: { id: "1" },
      };
      await reviewCmd.run({ config: { channelAdmin: "", prefix: "!" } }, [], announcedMsg);
      assert.notStrictEqual(announcedReplies[0], SCOPE_REJECT);
      assert.match(announcedReplies[0], /Anmeldung/);

      if (db.countPendingReviews() === 0) {
        const c = db.findOrCreateCeleb({ name: "Pool Scope Figure", age: 70 });
        db.enqueueReview(
          c.celeb.id,
          {
            wikiUrl: "https://en.wikipedia.org/wiki/Pool_Scope_Figure",
            wikiNorm: "en:pool_scope_figure",
            proposedAge: 70,
            lang: "en",
          },
          { seasonId: runningSeason().id }
        );
      }
      const poolReplies = [];
      const poolMsg = {
        reply: async (m) => poolReplies.push(replyText(m)),
        channel: { send: async () => {} },
        author: { id: "1" },
      };
      await reviewCmd.run(
        { config: { channelAdmin: "", prefix: "!" } },
        ["scope:pool"],
        poolMsg
      );
      assert.notStrictEqual(poolReplies[0], SCOPE_REJECT);
      assert.match(poolReplies[0], /laufender Pool/);
    }
  );
});

test("M16: gesetztes aber nicht sendbares CHANNEL_ADMIN fällt auf preferDmUser zurück", async () => {
  await withLookupStubs(
    {
      proposeWikiForName: async () => ({
        wikiUrl: "https://en.wikipedia.org/wiki/Dm_Fallback",
        proposedAge: 40,
        lang: "en",
        candidates: [],
      }),
    },
    async () => {
      if (db.countPendingReviews() === 0) {
        const c = db.findOrCreateCeleb({ name: "Dm Fallback Figure", age: 40 });
        db.enqueueReview(
          c.celeb.id,
          {
            wikiUrl: "https://en.wikipedia.org/wiki/Dm_Fallback_Figure",
            wikiNorm: "en:dm_fallback_figure",
            proposedAge: 40,
            lang: "en",
          },
          { seasonId: runningSeason().id }
        );
      }
      const sent = [];
      const dm = { id: "dm-1", send: async (payload) => sent.push(payload) };
      let usedFallback = false;
      const msg = {
        reply: async () => {},
        channel: {
          id: "fallback-channel",
          send: async () => {
            usedFallback = true;
          },
        },
        author: { id: "1", createDM: async () => dm },
      };
      const ctx = {
        config: { channelAdmin: "admin-missing", prefix: "!" },
        client: { channels: { fetch: async () => { throw new Error("not sendable"); } } },
      };
      await reviewCmd.run(ctx, ["pool"], msg);
      assert.strictEqual(usedFallback, false, "must not post the card in the fallback channel");
      assert.ok(sent.length >= 1, "card goes to the admin DM");
      assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
    }
  );
});

test("M16: vorhandene proposed_wiki_url ruft proposeWikiForName nicht auf", async () => {
  db.getDb().prepare("DELETE FROM celeb_review_queue").run();
  const name = "Second *Announced* <@123>";
  const c = db.findOrCreateCeleb({ name, age: 41 });
  const url = "https://en.wikipedia.org/wiki/Second_Announced";
  const queued = db.enqueueReview(
    c.celeb.id,
    { wikiUrl: url, wikiNorm: "en:second_announced", proposedAge: 41, lang: "en" },
    { seasonId: announcedSeason().id }
  );
  assert.strictEqual(queued.queued, true);
  const stored = db
    .getDb()
    .prepare("SELECT proposed_wiki_url, proposed_candidates FROM celeb_review_queue WHERE celeb_id = ?")
    .get(c.celeb.id);
  assert.ok(stored.proposed_wiki_url);
  assert.strictEqual(stored.proposed_candidates, null, "empty candidates used to force a re-search");

  let calls = 0;
  const sent = [];
  await withLookupStubs(
    {
      proposeWikiForName: async () => {
        calls += 1;
        throw new Error("proposeWikiForName must not run");
      },
    },
    async () => {
      await celebReview.sendNextReview(
        { config: { userAgent: "test", adminId: "1" } },
        { send: async (payload) => sent.push(payload) },
        { season: announcedSeason(), seasonId: announcedSeason().id }
      );
    }
  );
  assert.strictEqual(calls, 0);
  assert.strictEqual(sent.length, 1);
  const card = sent[0];
  assert.strictEqual(card.embeds[0].data.title, "Wiki/Alter: Second Announced 123");
  assert.ok(!card.embeds[0].data.title.includes("*"));
  assert.ok(!card.embeds[0].data.title.includes("<@"));
  assert.ok(card.embeds[0].data.description.includes(REVIEW_INTRO));
  assert.ok(card.embeds[0].data.description.includes(url));
  assert.deepStrictEqual(card.allowedMentions, { parse: [] });
  const labels = card.components[card.components.length - 1].toJSON().components.map((b) => b.label);
  assert.deepStrictEqual(labels, [
    "Bestätigen",
    "Falscher Link",
    "Alter setzen",
    "Kein Wiki",
    "Überspringen",
  ]);
});

test("M16: neue Suche ohne Queue-URL ruft proposeWikiForName auf", async () => {
  db.getDb().prepare("DELETE FROM celeb_review_queue").run();
  const c = db.findOrCreateCeleb({ name: "Needs A Search", age: 50 });
  db.enqueueReview(
    c.celeb.id,
    { proposedAge: 50 },
    { seasonId: announcedSeason().id }
  );
  let calls = 0;
  await withLookupStubs(
    {
      proposeWikiForName: async () => {
        calls += 1;
        return {
          wikiUrl: "https://en.wikipedia.org/wiki/Needs_A_Search",
          wikiNorm: "en:needs_a_search",
          proposedAge: 50,
          lang: "en",
          qid: "Q50",
          candidates: [],
        };
      },
    },
    async () => {
      await celebReview.sendNextReview(
        { config: { userAgent: "test", adminId: "1" } },
        { send: async () => {} },
        { season: announcedSeason(), seasonId: announcedSeason().id }
      );
    }
  );
  assert.strictEqual(calls, 1);
});

test("M16: crev:url deferReply vor einem 5s-Lookup, danach editReply", async () => {
  const c = db.findOrCreateCeleb({ name: "Wiki *Star* <@5>", age: 44 });
  db.enqueueReview(
    c.celeb.id,
    { proposedAge: 44 },
    { seasonId: announcedSeason().id }
  );
  const order = [];
  let deferOpts = null;
  let release;
  let released = false;
  const proposal = {
    wikiUrl: "https://en.wikipedia.org/wiki/Wiki_Star",
    wikiNorm: "en:wiki_star",
    proposedAge: 44,
    qid: "Q555",
    lang: "en",
    candidates: [
      {
        title: "Wiki Star",
        url: "https://en.wikipedia.org/wiki/Wiki_Star",
        norm: "en:wiki_star",
        lang: "en",
        proposedAge: 44,
        qid: "Q555",
      },
    ],
  };
  // Worst case: der Lookup hängt 5s. deferReply muss der erste Call sein,
  // sonst ist das 3s-Ack weg. Der Test löst den Stub auf Zuruf auf.
  const LOOKUP_WORST_CASE_MS = 5000;
  const started = Date.now();
  let editPayload = null;
  const interaction = {
    customId: celebReview.reviewCustomId("url", c.celeb.id),
    user: { id: "1" },
    channel: { send: async () => order.push("send") },
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    isRepliable: () => true,
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: () => "https://en.wikipedia.org/wiki/Wiki_Star",
    },
    deferReply: async (opts) => {
      order.push("deferReply");
      deferOpts = opts;
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      order.push("editReply");
      editPayload = payload;
    },
    reply: async () => {
      order.push("reply");
    },
  };

  await withLookupStubs(
    {
      lookupUrl: () => {
        order.push("lookupUrl");
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(proposal), LOOKUP_WORST_CASE_MS);
          release = () => {
            if (released) return;
            released = true;
            clearTimeout(timer);
            resolve(proposal);
          };
        });
      },
      proposeWikiForName: async () => proposal,
    },
    async () => {
      const pending = celebReview.handleReviewInteraction(
        { config: { adminId: "1", userAgent: "test" } },
        interaction
      );
      const deadline = Date.now() + 1000;
      while (!order.includes("lookupUrl") && Date.now() < deadline) {
        await new Promise((r) => setImmediate(r));
      }
      assert.deepStrictEqual(order, ["deferReply", "lookupUrl"]);
      assert.notStrictEqual(order[0], "lookupUrl");
      assert.ok(Date.now() - started < LOOKUP_WORST_CASE_MS, "ack must not wait out the lookup");
      assert.strictEqual(deferOpts.flags, MessageFlags.Ephemeral);
      release();
      await pending;
    }
  );
  assert.ok(order.indexOf("deferReply") < order.indexOf("lookupUrl"));
  assert.ok(order.includes("editReply"));
  assert.ok(!order.includes("reply"), "success path must edit the deferred reply");
  assert.match(editPayload.content, /Wiki Star 5/);
  assert.ok(!editPayload.content.includes("<@"));
  assert.ok(!editPayload.content.includes("*Star*"));
  assert.ok(editPayload.content.includes("https://en.wikipedia.org/wiki/Wiki_Star"));
  assert.deepStrictEqual(editPayload.allowedMentions, { parse: [] });
});

test("M16: Lookup-Fehler nach deferReply ruft reply nicht noch einmal auf", async () => {
  const c = db.findOrCreateCeleb({ name: "Broken Lookup", age: 33 });
  const order = [];
  let editPayload = null;
  const interaction = {
    customId: celebReview.reviewCustomId("url", c.celeb.id),
    user: { id: "1" },
    channel: { send: async () => order.push("send") },
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    isRepliable: () => true,
    deferred: false,
    replied: false,
    fields: { getTextInputValue: () => "https://en.wikipedia.org/wiki/Not_A_Page" },
    deferReply: async () => {
      order.push("deferReply");
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      order.push("editReply");
      editPayload = payload;
    },
    reply: async () => {
      order.push("reply");
    },
  };
  await withLookupStubs(
    {
      lookupUrl: async () => {
        order.push("lookupUrl");
        throw new Error("ENOTFOUND secret internals");
      },
    },
    async () => {
      await celebReview.handleReviewInteraction(
        { config: { adminId: "1", userAgent: "test" } },
        interaction
      );
    }
  );
  assert.deepStrictEqual(order.slice(0, 2), ["deferReply", "lookupUrl"]);
  assert.ok(!order.includes("reply"));
  assert.ok(order.includes("editReply"));
  assert.strictEqual(editPayload.content, LOOKUP_FAIL);
  assert.ok(!editPayload.content.includes("ENOTFOUND"));
  assert.ok(!editPayload.content.includes("secret"));
  assert.ok(!editPayload.content.includes(":"));
});

test("M16: Alter-Modal und Kandidatenwahl nennen Bestätigen", async () => {
  const announced = announcedSeason();
  const aged = db.findOrCreateCeleb({ name: "Age *Button*", age: 60 });
  db.enqueueReview(
    aged.celeb.id,
    {
      wikiUrl: "https://en.wikipedia.org/wiki/Age_Button",
      wikiNorm: "en:age_button",
      proposedAge: 60,
      lang: "en",
    },
    { seasonId: announced.id }
  );
  const ageReplies = [];
  await celebReview.handleReviewInteraction(
    { config: { adminId: "1", userAgent: "test" } },
    {
      customId: celebReview.reviewCustomId("age", aged.celeb.id),
      user: { id: "1" },
      isButton: () => false,
      isModalSubmit: () => true,
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      fields: { getTextInputValue: () => "70" },
      reply: async (payload) => ageReplies.push(payload),
    }
  );
  assert.match(ageReplies[0].content, /Danach \*\*Bestätigen\*\*\./);
  assert.strictEqual(ageReplies[0].flags, MessageFlags.Ephemeral);
  assert.deepStrictEqual(ageReplies[0].allowedMentions, { parse: [] });

  const picked = db.findOrCreateCeleb({ name: "Pick Target", age: 61 });
  const urlA = "https://en.wikipedia.org/wiki/Ada_One";
  const urlB = "https://en.wikipedia.org/wiki/Ada_Two";
  db.enqueueReview(
    picked.celeb.id,
    {
      wikiUrl: urlA,
      wikiNorm: "en:ada_one",
      proposedAge: 61,
      lang: "en",
      candidates: [
        { title: "Ada *One*", url: urlA, norm: "en:ada_one", lang: "en", proposedAge: 61, qid: "Q1" },
        { title: "Ada Two", url: urlB, norm: "en:ada_two", lang: "en", proposedAge: 62, qid: "Q2" },
      ],
    },
    { seasonId: announced.id }
  );
  const updates = [];
  await withLookupStubs(
    {
      proposeWikiForName: async () => ({
        wikiUrl: urlA,
        proposedAge: 61,
        lang: "en",
        candidates: [],
      }),
    },
    async () => {
      await celebReview.handleReviewInteraction(
        { config: { adminId: "1", userAgent: "test" } },
        {
          customId: celebReview.reviewCustomId("pick", picked.celeb.id),
          user: { id: "1" },
          channel: { send: async () => {} },
          isButton: () => false,
          isModalSubmit: () => false,
          isStringSelectMenu: () => true,
          isRepliable: () => true,
          values: ["0"],
          update: async (payload) => updates.push(payload),
          reply: async () => {
            throw new Error("pick should update, not reply");
          },
        }
      );
    }
  );
  assert.match(updates[0].content, /Jetzt \*\*Bestätigen\*\*\./);
  assert.match(updates[0].content, /Ada One/);
  assert.ok(!updates[0].content.includes("*One*"));
  assert.deepStrictEqual(updates[0].allowedMentions, { parse: [] });
});
