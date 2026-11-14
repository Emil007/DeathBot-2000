const { test, after } = require("node:test");
const assert = require("node:assert");
const axios = require("axios");

const { scrapeEn } = require("../src/wiki/scraper-en");
const { scrapeDe } = require("../src/wiki/scraper-de");

// Frozen instant that is 01:30 on 1 Jan 2027 in Europe/Vienna (and still 1 Jan in UTC).
const VIENNA_JAN = "2027-01-01T00:30:00.000Z";
// 00:30 on 1 Jan 2027 in Vienna. UTC is still 31 Dec 2026.
const VIENNA_MIDNIGHT = "2026-12-31T23:30:00.000Z";

const realCreate = axios.create;
after(() => {
  axios.create = realCreate;
});

function stubClient() {
  const urls = [];
  let creates = 0;
  axios.create = () => {
    creates += 1;
    return {
      async get(url) {
        urls.push(String(url));
        return { status: 200, data: "<html></html>" };
      },
    };
  };
  return {
    urls,
    creates: () => creates,
  };
}

function decoded(urls) {
  return urls.map((u) => {
    try {
      return decodeURIComponent(u);
    } catch {
      return u;
    }
  });
}

test("scrapeEn at 2027-01-01T00:30Z Vienna requests Deaths_in_2027, not Deaths_in_2026", async () => {
  const stub = stubClient();
  await scrapeEn("test-agent", { now: VIENNA_JAN, tz: "Europe/Vienna" });
  assert.strictEqual(stub.creates(), 1, "one HTTP client for the run");
  assert.ok(
    stub.urls.some((u) => /\/Deaths_in_2027$/.test(u)),
    stub.urls.join("\n")
  );
  assert.ok(
    !stub.urls.some((u) => /\/Deaths_in_2026$/.test(u)),
    stub.urls.join("\n")
  );
});

test("scrapeDe at 2027-01-01T00:30Z Vienna requests January, not December", async () => {
  const stub = stubClient();
  await scrapeDe("test-agent", { now: VIENNA_JAN, tz: "Europe/Vienna" });
  const urls = decoded(stub.urls);
  assert.strictEqual(stub.creates(), 1, "one HTTP client for the run");
  assert.ok(urls.some((u) => u.includes("Nekrolog_Januar_2027")), urls.join("\n"));
  assert.ok(!urls.some((u) => /Dezember/.test(u)), urls.join("\n"));
  assert.ok(!urls.some((u) => /Nekrolog_2026\b/.test(u)), urls.join("\n"));
});

test("omitted tz defaults to Europe/Vienna for the same January instant", async () => {
  const en = stubClient();
  await scrapeEn("test-agent", { now: VIENNA_JAN });
  assert.ok(en.urls.some((u) => /\/Deaths_in_2027$/.test(u)), en.urls.join("\n"));
  assert.ok(!en.urls.some((u) => /\/Deaths_in_2026$/.test(u)), en.urls.join("\n"));

  const de = stubClient();
  await scrapeDe("test-agent", { now: VIENNA_JAN });
  const urls = decoded(de.urls);
  assert.ok(urls.some((u) => u.includes("Nekrolog_Januar_2027")), urls.join("\n"));
  assert.ok(!urls.some((u) => /Dezember/.test(u)), urls.join("\n"));
});

test("00:30 Vienna on 1 Jan 2027 is still the 2027 January lists", async () => {
  const en = stubClient();
  await scrapeEn("test-agent", { now: VIENNA_MIDNIGHT, tz: "Europe/Vienna" });
  assert.ok(en.urls.some((u) => /\/Deaths_in_2027$/.test(u)), en.urls.join("\n"));
  assert.ok(!en.urls.some((u) => /\/Deaths_in_2026$/.test(u)), en.urls.join("\n"));

  const de = stubClient();
  await scrapeDe("test-agent", { now: VIENNA_MIDNIGHT, tz: "Europe/Vienna" });
  const urls = decoded(de.urls);
  assert.ok(urls.some((u) => u.includes("Nekrolog_Januar_2027")), urls.join("\n"));
  assert.ok(!urls.some((u) => /Dezember/.test(u)), urls.join("\n"));
});

test("opts.tz is honored: Honolulu is still in December 2026 at that instant", async () => {
  const en = stubClient();
  await scrapeEn("test-agent", { now: VIENNA_JAN, tz: "Pacific/Honolulu" });
  assert.ok(en.urls.some((u) => /\/Deaths_in_2026$/.test(u)), en.urls.join("\n"));
  assert.ok(!en.urls.some((u) => /\/Deaths_in_2027$/.test(u)), en.urls.join("\n"));

  const de = stubClient();
  await scrapeDe("test-agent", { now: VIENNA_JAN, tz: "Pacific/Honolulu" });
  const urls = decoded(de.urls);
  assert.ok(urls.some((u) => u.includes("Nekrolog_Dezember_2026")), urls.join("\n"));
  assert.ok(urls.some((u) => /\/Nekrolog_2026$/.test(u)), urls.join("\n"));
  assert.ok(!urls.some((u) => /Nekrolog_2027/.test(u)), urls.join("\n"));
});
