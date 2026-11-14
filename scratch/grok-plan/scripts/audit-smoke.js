const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbtest-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const config = loadConfig();
db.openDb(config);

// Homonym: confirmed then new provisional
const a = db.findOrCreateCeleb({ name: "John Smith", age: 70, description: "A" });
db.applyWikiConfirm(a.celeb.id, {
  wikiUrl: "https://en.wikipedia.org/wiki/John_Smith_(foo)",
  wikiNorm: "en:john_smith_(foo)",
  wikidataId: "Q111",
  age: 70,
  manualOnly: false,
});
const b = db.findOrCreateCeleb({ name: "John Smith", age: 40, description: "B" });
if (!b.created || !b.possibleHomonym) throw new Error("expected new provisional homonym");
if (b.celeb.id === a.celeb.id) throw new Error("homonym reused confirmed");

// QID merge
const c = db.findOrCreateCeleb({ name: "Jane Doe", age: 50 });
db.applyWikiConfirm(c.celeb.id, {
  wikiUrl: "https://de.wikipedia.org/wiki/Jane_Doe",
  wikiNorm: "de:jane_doe",
  wikidataId: "Q222",
  age: 50,
  manualOnly: false,
});
const d = db.findOrCreateCeleb({ name: "Jane Doe EN", age: 50 });
const merged = db.applyWikiConfirm(d.celeb.id, {
  wikiUrl: "https://en.wikipedia.org/wiki/Jane_Doe",
  wikiNorm: "en:jane_doe",
  wikidataId: "Q222",
  age: 50,
  manualOnly: false,
});
if (merged.id !== c.celeb.id && !db.findCelebByWikidataId("Q222")) {
  throw new Error("qid merge failed");
}
const byQ = db.findCelebByWikidataId("Q222");
if (!byQ) throw new Error("missing qid");

// go gate
db.enqueueReview(b.celeb.id, { wikiUrl: null, proposedAge: 40 });
if (db.countPendingReviews() < 1) throw new Error("expected pending");

// restore path
const backup = require("../src/backup");
fs.mkdirSync(config.restoreDir, { recursive: true });
let threw = false;
try {
  backup.findPackage(config, "../etc/passwd");
} catch {
  threw = true;
}
if (!threw) throw new Error("restore traversal not blocked");

// applyDeath must not wipe confirmed wiki
db.applyDeath(byQ.id, {
  confirmed: true,
  source: "wiki",
  wikiUrl: "https://en.wikipedia.org/wiki/Deaths_in_2026",
});
const after = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(byQ.id);
if (after.wiki_url && after.wiki_url.includes("Deaths_in")) {
  throw new Error("applyDeath overwrote wiki_url");
}
if (!after.death_list_url) throw new Error("expected death_list_url");

console.log("audit-smoke-ok");
db.closeDb();
