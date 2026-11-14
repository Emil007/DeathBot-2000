const { test } = require("node:test");
const assert = require("node:assert");
const { planAnnouncements, normName } = require("../src/wiki/announce-dedup");

function entry(id, { lang, url, text, redName = false, listUrl = null, qid = null, isHuman = null }) {
  return { id, lang, url, text, redName, listUrl, resolved: { qid, isHuman, url, pageMissing: false, error: null } };
}

test("Young L: person page wins, both band pages bound", () => {
  const person = entry("en:/wiki/Young_L", {
    lang: "en",
    url: "https://en.wikipedia.org/wiki/Young_L",
    text: "Young L, American rapper (The Pack).",
    qid: "Q1",
    isHuman: true,
  });
  const bandEn = entry("en:/wiki/The_Pack_(group)", {
    lang: "en",
    url: "https://en.wikipedia.org/wiki/The_Pack_(group)",
    text: "Young L, 39, US-amerikanischer Rapper 🌍",
    isHuman: false,
  });
  const bandDe = entry("de:/wiki/The_Pack_(Band)", {
    lang: "de",
    url: "https://de.wikipedia.org/wiki/The_Pack_(Band)",
    text: "Young L, 39, US-amerikanischer Rapper",
    redName: true,
    isHuman: false,
  });
  const { post, bind } = planAnnouncements([person, bandEn, bandDe], { qids: new Set(), humanNames: new Set() });
  assert.strictEqual(post.length, 1, "only the person page should be posted");
  assert.strictEqual(post[0].id, "en:/wiki/Young_L");
  const loserIds = bind.map((b) => b.loserId);
  assert.ok(loserIds.includes("en:/wiki/The_Pack_(group)"), "EN band must bind to person");
  assert.ok(loserIds.includes("de:/wiki/The_Pack_(Band)"), "DE band must bind to person");
  const winnerIds = bind.map((b) => b.winnerId);
  assert.ok(winnerIds.every((w) => w === "en:/wiki/Young_L"));
});

test("same QID DE+EN (Åström) -> only EN posted", () => {
  const en = entry("en:/wiki/Karl_Johan_%C3%85str%C3%B6m", {
    lang: "en", text: "Karl Johan Åström, Swedish control theorist.", qid: "Q77", isHuman: true,
  });
  const de = entry("de:/wiki/Karl_Johan_%C3%85str%C3%B6m", {
    lang: "de", text: "Karl Johan Åström, schwedischer Physiker", qid: "Q77", isHuman: true,
  });
  const { post, bind } = planAnnouncements([en, de], { qids: new Set(), humanNames: new Set() });
  assert.strictEqual(post.length, 1);
  assert.strictEqual(post[0].lang, "en");
  assert.strictEqual(bind.length, 1);
});

test("DE without EN sitelink/QID still posted (isDeOnly)", () => {
  const de = entry("de:/wiki/Max_R%C3%B6ssler", {
    lang: "de", text: "Max Rössler, Schweizer Investor", qid: null, isHuman: true,
  });
  const { post, bind } = planAnnouncements([de], { qids: new Set(), humanNames: new Set() });
  assert.strictEqual(post.length, 1);
  assert.strictEqual(post[0].lang, "de");
});

test("resolve error -> defer, not post", () => {
  const e = { id: "de:/wiki/x", lang: "de", text: "Nobody", resolved: { error: "HTTP 429" } };
  const { post, bind, defer } = planAnnouncements([e], { qids: new Set(), humanNames: new Set() });
  assert.strictEqual(post.length, 0);
  assert.strictEqual(defer.length, 1);
});

test("two humans distinct QID with similar names (Mašín) -> both posted", () => {
  const a = entry("en:/wiki/Josef_Ma%C5%A1%C3%ADn", { lang: "en", text: "Josef Mašín, resistance fighter.", qid: "Q1a", isHuman: true });
  const b = entry("de:/wiki/Josef_Ma%C5%A1%C3%ADn_jun.", { lang: "de", text: "Josef Mašín jun., Widerstandskämpfer", qid: "Q1b", isHuman: true });
  const { post } = planAnnouncements([a, b], { qids: new Set(), humanNames: new Set() });
  assert.strictEqual(post.length, 2, "similar names w/ different QID must BOTH be posted");
});

test("non-person posting a person already in history -> bound, not posted", () => {
  const band = entry("de:/wiki/The_Pack_(Band)", {
    lang: "de", text: "Young L, US-amerikanischer Rapper", redName: true, isHuman: false,
  });
  const { post, bind } = planAnnouncements([band], {
    qids: new Set(),
    humanNames: new Set(["young l, american rapper (the pack)"]),
  });
  assert.strictEqual(post.length, 0, "band-name match on recent human name must not post");
  assert.ok(bind.length >= 1);
});

test("historical qid already posted -> nothing posted, stamps", () => {
  const en = entry("en:/wiki/Some_Person", { lang: "en", text: "Some Person, actor.", qid: "Q900", isHuman: true });
  const { post, bind } = planAnnouncements([en], { qids: new Set(["Q900"]), humanNames: new Set() });
  assert.strictEqual(post.length, 0);
  assert.ok(bind.some((b) => b.loserId === en.id && b.winnerId === en.id));
});

test("normName strips [xx] suffix", () => {
  assert.strictEqual(normName("Claudette Soares [pt]"), "claudettesoares");
});
