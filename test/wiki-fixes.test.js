const { test, after } = require("node:test");
const assert = require("node:assert");
const cheerio = require("cheerio");
const axios = require("axios");

const {
  fetchDeathBrief,
  parseDeathDateText,
  stripTrailingDeathDate,
  shortFromExtract,
} = require("../src/wiki/death-brief");
const {
  extractFromTables,
  monthFlagsFromUrl,
  applyUrlDateFlags,
} = require("../src/wiki/scraper-de");
const { announceAllDeath } = require("../src/discord/announce");

// fetchDeathBrief builds its client via axios.create at call time → swap in a
// fake client that routes Wikipedia / Wikidata requests to canned responses.
const realCreate = axios.create;
after(() => {
  axios.create = realCreate;
});

function mockApi({ page, entity = null, labels = {}, onEntity = null, onLabels = null }) {
  const calls = [];
  axios.create = () => ({
    async get(url, { params } = {}) {
      calls.push({ url, params });
      if (/wikipedia\.org/.test(url)) {
        return { status: 200, data: { query: { pages: { 1: page } } } };
      }
      if (params.props === "claims|descriptions") {
        if (onEntity) return onEntity(params);
        return { status: 200, data: { entities: { [params.ids]: entity } } };
      }
      if (onLabels) {
        const r = onLabels(params, calls);
        if (r) return r;
      }
      const entities = {};
      for (const id of params.ids.split("|")) entities[id] = labels[id];
      return { status: 200, data: { entities } };
    },
  });
  return calls;
}

const item = (id) => ({ mainsnak: { datavalue: { value: { id } } } });
const time = (t) => ({ mainsnak: { datavalue: { value: { time: t } } } });
const labelCalls = (calls) => calls.filter((c) => /wikidata/.test(c.url) && /^labels/.test(c.params.props));

// --- parseDeathDateText / stripTrailingDeathDate / shortFromExtract ---------

test("parseDeathDateText takes the LAST date in the text, not the first month in calendar order", () => {
  assert.deepStrictEqual(
    parseDeathDateText("Gernot Friedel (* 3. Mai 1940 in Innsbruck) … † 8. Oktober"),
    { day: 8, month: 9 }
  );
  assert.deepStrictEqual(
    parseDeathDateText("… 3. Mai 1940 … † 8. Oktober 2026"),
    { day: 8, month: 9, year: 2026 }
  );
  assert.deepStrictEqual(
    parseDeathDateText("born 3 May 1940, died 8 October 2026"),
    { day: 8, month: 9, year: 2026 }
  );
  // invalid day numbers are skipped, the last VALID date wins
  assert.deepStrictEqual(parseDeathDateText("8. Oktober, 45. Mai"), { day: 8, month: 9 });
  assert.strictEqual(parseDeathDateText("Max Muster, 85, deutscher Schauspieler"), null);
});

test("stripTrailingDeathDate drops the trailing date tag only", () => {
  assert.strictEqual(stripTrailingDeathDate("deutscher Schauspieler, 8. Oktober"), "deutscher Schauspieler");
  assert.strictEqual(stripTrailingDeathDate("deutscher Schauspieler, 8. Oktober 2026"), "deutscher Schauspieler");
  assert.strictEqual(stripTrailingDeathDate("deutscher Schauspieler, 8. Oktober 🌍"), "deutscher Schauspieler 🌍");
  assert.strictEqual(stripTrailingDeathDate("geboren am 3. Mai in Bonn, Schauspieler"), "geboren am 3. Mai in Bonn, Schauspieler");
});

test("shortFromExtract pulls the short known-for phrase out of the intro sentence", () => {
  assert.strictEqual(
    shortFromExtract("Gernot Friedel (* 3. Mai 1941 in Innsbruck; † 10. Oktober 2026 in Wien) war ein österreichischer Theater- und Fernsehregisseur."),
    "österreichischer Theater- und Fernsehregisseur"
  );
  assert.strictEqual(
    shortFromExtract("Erika Muster (* 1. Januar 1950) war eine deutsche Schauspielerin, die vor allem durch den Tatort bekannt wurde."),
    "deutsche Schauspielerin"
  );
  assert.strictEqual(
    shortFromExtract("Hans Beispiel (* 1940) war ein deutscher Politiker (SPD) und Mitglied des 12. Deutschen Bundestages. Er lebte in Bonn."),
    "deutscher Politiker (SPD) und Mitglied des 12. Deutschen Bundestages"
  );
  assert.strictEqual(
    shortFromExtract("RJ Mitte (born August 21, 1992) was an American actor, best known for Breaking Bad."),
    "American actor"
  );
  assert.strictEqual(shortFromExtract("Ein Text ohne passende Satzstruktur."), null);
});

// --- scraper-de: beruf field, red links, age parsing, URL year ---------------

const TABLE_HTML = `<div class="mw-parser-output"><table class="wikitable"><tbody>
<tr><th>Tag</th><th>Name</th><th>Beruf, bekannt als</th><th>Alter</th><th>Beleg</th></tr>
<tr><td>13. Oktober</td><td><a href="https://de.wikipedia.org/wiki/Albert_Houssiau">Albert Houssiau</a></td><td>belgischer   Bischof<sup>[1]</sup></td><td>101[2]</td><td></td></tr>
<tr><td>10. Oktober</td><td><a class="new" href="https://de.wikipedia.org/wiki/Guruvayur_Dorai?action=edit&amp;redlink=1">Guruvayur Dorai</a></td><td>indischer <a href="https://de.wikipedia.org/wiki/Perkussionist">Perkussionist</a></td><td>91</td><td></td></tr>
<tr><td>9. Oktober</td><td><a class="new" href="/w/index.php?title=Hans_Rot&amp;action=edit&amp;redlink=1">Hans Rot</a></td><td>deutscher Politiker (<a href="/wiki/Sozialdemokratische_Partei_Deutschlands">SPD</a>)</td><td>77</td><td></td></tr>
<tr><td>9. Oktober</td><td>Erika Ohnelink</td><td>deutsche <a href="/wiki/Schauspieler">Schauspielerin</a></td><td>88</td><td></td></tr>
<tr><td>8. Oktober</td><td><a href="/wiki/Max_Muster">Max Muster</a></td><td>deutscher Schauspieler</td><td>85–86</td><td></td></tr>
<tr><td>7. Oktober</td><td><a href="/wiki/Eva_Beispiel">Eva Beispiel</a></td><td>deutsche Sängerin</td><td>?</td><td></td></tr>
</tbody></table></div>`;

test("extractFromTables: beruf field, red-linked/unlinked names skipped, refs/ranges in age", () => {
  const entries = extractFromTables(cheerio.load(TABLE_HTML), "de");
  assert.deepStrictEqual(
    entries.map((e) => e.wikiPath),
    ["/wiki/Albert_Houssiau", "/wiki/Max_Muster", "/wiki/Eva_Beispiel"],
    "red-linked / unlinked names must not fall back to Beruf-column links"
  );
  const [albert, max, eva] = entries;
  assert.strictEqual(albert.beruf, "belgischer Bischof");
  assert.strictEqual(albert.text, "Albert Houssiau, 101, belgischer Bischof, 13. Oktober");
  assert.strictEqual(albert.day, 13);
  assert.strictEqual(albert.month, 9);
  assert.strictEqual(max.text, "Max Muster, 85, deutscher Schauspieler, 8. Oktober", "85–86 → 85");
  assert.strictEqual(eva.text, "Eva Beispiel, deutsche Sängerin, 7. Oktober", "'?' age → no age");
});

test("Nekrolog URL supplies year/month; previous-year deaths on a January page", () => {
  assert.deepStrictEqual(monthFlagsFromUrl("https://de.wikipedia.org/wiki/Nekrolog_Dezember_2026"), { month: 11, year: 2026 });
  assert.deepStrictEqual(monthFlagsFromUrl("https://de.wikipedia.org/wiki/Nekrolog_M%C3%A4rz_2026"), { month: 2, year: 2026 });
  assert.deepStrictEqual(monthFlagsFromUrl("https://de.wikipedia.org/wiki/Nekrolog_2026"), { year: 2026 });
  assert.strictEqual(monthFlagsFromUrl("https://de.wikipedia.org/wiki/Hauptseite"), null);

  const [dec] = applyUrlDateFlags([{ day: 28, month: 11 }], "https://de.wikipedia.org/wiki/Nekrolog_Dezember_2026");
  assert.strictEqual(dec.year, 2026, "December page posted in January keeps its own year");

  const jan = applyUrlDateFlags(
    [{ day: 28, month: 11 }, { day: 3, month: 0 }, { day: 1, month: 0, year: 2020 }, {}],
    "https://de.wikipedia.org/wiki/Nekrolog_Januar_2027"
  );
  assert.strictEqual(jan[0].year, 2026, "late-reported December death → previous year");
  assert.strictEqual(jan[1].year, 2027);
  assert.strictEqual(jan[2].year, 2020, "explicit Tag year wins");
  assert.deepStrictEqual(jan[3], { year: 2027, month: 0 });
});

// --- fetchDeathBrief ----------------------------------------------------------

test("DE brief without P106: short knownFor from extract, no long sentence, disambiguator stripped", async () => {
  mockApi({
    page: {
      title: "Peter Müller (Politiker, 1940)",
      extract:
        "Peter Müller (* 3. Mai 1940 in Bonn; † 8. Oktober 2026 in Köln) war ein deutscher Politiker (SPD), der von 1990 bis 2002 dem Deutschen Bundestag angehörte. Er war außerdem Bürgermeister.",
      pageprops: { wikibase_item: "Q1" },
      fullurl: "https://de.wikipedia.org/wiki/Peter_M%C3%BCller_(Politiker,_1940)",
    },
    entity: {
      claims: {
        P31: [item("Q5")],
        P569: [time("+1940-05-03T00:00:00Z")],
        P570: [time("+2026-10-08T00:00:00Z")],
      },
      descriptions: {},
    },
  });
  const b = await fetchDeathBrief("https://de.wikipedia.org/wiki/Peter_M%C3%BCller_(Politiker,_1940)", "test");
  assert.strictEqual(b.name, "Peter Müller");
  assert.strictEqual(b.knownFor, "deutscher Politiker (SPD)");
  assert.strictEqual(b.summary, null, "summary must not swap in the long extract");
  assert.strictEqual(b.age, 86);
  assert.strictEqual(b.lifespan, "1940–2026");
});

test("DE brief: short beruf wins as knownFor; summary equal to knownFor → null", async () => {
  mockApi({
    page: {
      title: "Max Muster",
      extract: "Max Muster (* 1. Januar 1940) war ein deutscher Schauspieler. Er spielte in über hundert Filmen mit.",
      description: "deutscher Schauspieler",
      pageprops: { wikibase_item: "Q2" },
    },
    entity: {
      claims: { P31: [item("Q5")], P106: [item("Q33999")] },
      descriptions: { de: { value: "deutscher Schauspieler" } },
    },
    labels: { Q33999: { labels: { de: { value: "Schauspieler" } } } },
  });
  const b = await fetchDeathBrief("https://de.wikipedia.org/wiki/Max_Muster", "test", {
    listText: "Max Muster, 85, deutscher Schauspieler, 8. Oktober",
    beruf: "deutscher Schauspieler",
  });
  assert.strictEqual(b.knownFor, "deutscher Schauspieler", "beruf preferred over P106 labels");
  assert.strictEqual(b.summary, null);
});

test("Wikidata failure keeps the Wikipedia data (no empty fallback card)", async () => {
  mockApi({
    page: {
      title: "Erika Muster",
      extract: "Erika Muster (* 1950) war eine deutsche Schauspielerin.",
      description: "deutsche Schauspielerin",
      thumbnail: { source: "https://upload.example/erika.jpg" },
      pageprops: { wikibase_item: "Q3" },
      fullurl: "https://de.wikipedia.org/wiki/Erika_Muster",
    },
    onEntity: () => {
      throw new Error("socket hang up");
    },
  });
  const b = await fetchDeathBrief("https://de.wikipedia.org/wiki/Erika_Muster", "test");
  assert.strictEqual(b.name, "Erika Muster");
  assert.strictEqual(b.thumb, "https://upload.example/erika.jpg");
  assert.strictEqual(b.url, "https://de.wikipedia.org/wiki/Erika_Muster");
  assert.strictEqual(b.knownFor, "deutsche Schauspielerin");
});

test("occupation labels retry on 429 instead of silently returning []", async () => {
  const calls = mockApi({
    page: { title: "Max Muster", extract: "", pageprops: { wikibase_item: "Q4" } },
    entity: { claims: { P31: [item("Q5")], P106: [item("Q33999")] }, descriptions: {} },
    labels: { Q33999: { labels: { de: { value: "Schauspieler" } } } },
    onLabels: (params, all) => (labelCalls(all).length === 1 ? { status: 429, data: {} } : null),
  });
  const b = await fetchDeathBrief("https://de.wikipedia.org/wiki/Max_Muster", "test");
  assert.strictEqual(labelCalls(calls).length, 2, "one retry after the 429");
  assert.strictEqual(b.knownFor, "Schauspieler");
});

test("DE female person gets the female occupation label (P2521), best effort", async () => {
  const female = {
    page: { title: "Erika Muster", extract: "", pageprops: { wikibase_item: "Q5x" } },
    entity: { claims: { P31: [item("Q5")], P21: [item("Q6581072")], P106: [item("Q33999")] }, descriptions: {} },
    labels: {
      Q33999: {
        labels: { de: { value: "Schauspieler" } },
        claims: { P2521: [{ mainsnak: { datavalue: { value: { text: "Schauspielerin", language: "de" } } } }] },
      },
    },
  };
  let calls = mockApi(female);
  let b = await fetchDeathBrief("https://de.wikipedia.org/wiki/Erika_Muster", "test");
  assert.strictEqual(b.knownFor, "Schauspielerin");
  assert.strictEqual(labelCalls(calls)[0].params.props, "labels|claims");

  // claims request fails → plain labels, card still fine
  calls = mockApi({
    ...female,
    onLabels: (params) => {
      if (params.props === "labels|claims") throw new Error("timeout");
      return null;
    },
  });
  b = await fetchDeathBrief("https://de.wikipedia.org/wiki/Erika_Muster", "test");
  assert.strictEqual(b.knownFor, "Schauspieler");
  assert.deepStrictEqual(labelCalls(calls).map((c) => c.params.props), ["labels|claims", "labels"]);
});

// --- announceAllDeath card ------------------------------------------------------

function fakeDiscord() {
  const sent = [];
  const channel = { isTextBased: () => true, send: async (m) => sent.push(m) };
  return { client: { channels: { fetch: async () => channel } }, sent };
}
const CONFIG = { channelAllDeaths: "1", userAgent: "test" };
const field = (embed, name) => (embed.fields || []).find((f) => f.name === name);

test("DE card: beruf as 'Bekannt für', no duplicated date/beruf in Wikipedia-Liste", async () => {
  mockApi({
    page: {
      title: "Gernot Friedel",
      extract: "Gernot Friedel (* 3. Mai 1941 in Innsbruck; † 10. Oktober 2026 in Wien) war ein österreichischer Regisseur.",
      description: "österreichischer Regisseur",
      thumbnail: { source: "https://upload.example/gf.jpg" },
    },
  });
  const { client, sent } = fakeDiscord();
  await announceAllDeath(client, CONFIG, {
    id: "de:/wiki/Gernot_Friedel",
    url: "https://de.wikipedia.org/wiki/Gernot_Friedel",
    text: "Gernot Friedel, 85, österreichischer Theater- und Fernsehregisseur, 10. Oktober",
    beruf: "österreichischer Theater- und Fernsehregisseur",
    lang: "de",
    day: 10,
    month: 9,
    year: 2026,
  }, { isDeOnly: true });
  const embed = sent[0].embeds[0].toJSON();
  const kurz = field(embed, "Kurzinfo").value;
  assert.match(kurz, /Gestorben: \*\*10\. Oktober 2026\*\*/);
  assert.match(kurz, /Bekannt für: österreichischer Theater- und Fernsehregisseur/);
  assert.doesNotMatch(kurz, /war ein/);
  assert.strictEqual(embed.description, "österreichischer Regisseur");
  assert.strictEqual(field(embed, "Wikipedia-Liste"), undefined, "listNote == beruf/knownFor → not repeated");
});

test("bridged card: trailing '…, 8. Oktober' not repeated when Gestorben is shown", async () => {
  mockApi({
    page: {
      title: "Max Muster",
      extract: "Max Muster was a German actor.",
      description: "German actor",
      thumbnail: { source: "https://upload.example/mm.jpg" },
    },
  });
  const { client, sent } = fakeDiscord();
  await announceAllDeath(client, CONFIG, {
    id: "en:/wiki/Max_Muster",
    url: "https://en.wikipedia.org/wiki/Max_Muster",
    text: "Max Muster, 85, deutscher Schauspieler, 8. Oktober 🌍",
    lang: "en",
    fromDe: true,
    day: 8,
    month: 9,
    year: 2025,
  });
  const embed = sent[0].embeds[0].toJSON();
  assert.match(field(embed, "Kurzinfo").value, /Gestorben: \*\*8\. Oktober 2025\*\*/, "propagated DE year");
  assert.strictEqual(embed.description, "deutscher Schauspieler 🌍");
});

test("listNote strips the death-line name even when the article title differs", async () => {
  mockApi({
    page: {
      title: "Christopher Welsh (musician)",
      extract: "Christopher Welsh was an Australian musician.",
      description: "Australian musician",
      thumbnail: { source: "https://upload.example/cw.jpg" },
      pageprops: { wikibase_item: "Q6" },
    },
    entity: { claims: { P31: [item("Q5")] }, descriptions: { en: { value: "Australian rock drummer" } } },
  });
  const { client, sent } = fakeDiscord();
  // no day flag and no date in the text: must not crash on the date fallback
  await announceAllDeath(client, CONFIG, {
    id: "en:/wiki/Chris_Welsh_(musician)",
    url: "https://en.wikipedia.org/wiki/Chris_Welsh_(musician)",
    text: "Chris Welsh, 70, Australian drummer (Died Pretty), cancer.",
    lang: "en",
  });
  const embed = sent[0].embeds[0].toJSON();
  assert.strictEqual(embed.title, "🌍 Christopher Welsh");
  assert.strictEqual(embed.description, "Australian rock drummer");
  assert.strictEqual(field(embed, "Wikipedia-Liste").value, "Australian drummer (Died Pretty), cancer.");
});
