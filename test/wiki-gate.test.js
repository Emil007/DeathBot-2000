const { test } = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const { withWikiSlot, allowUserWiki } = require("../src/wiki/gate");
const {
  proposeWikiForName,
  lookupUrl,
  resolveEnglishArticle,
} = require("../src/wiki/page-lookup");

function waitFor(pred, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > 2000) {
        return reject(new Error(label || "timed out"));
      }
      setImmediate(tick);
    };
    tick();
  });
}

function withNow(iso, fn) {
  const fixed = new Date(iso).getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  global.Date = FrozenDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

function httpError(status) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status };
  return err;
}

function useGet(get) {
  const realCreate = axios.create;
  axios.create = () => ({ get });
  return () => {
    axios.create = realCreate;
  };
}

async function withoutWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = orig;
  }
}

test("withWikiSlot never runs more than two bodies at once", async () => {
  let current = 0;
  let max = 0;
  let entered = 0;
  const releases = [];
  const tasks = [1, 2, 3].map((n) =>
    withWikiSlot(async () => {
      current += 1;
      entered += 1;
      if (current > max) max = current;
      try {
        await new Promise((resolve) => releases.push(resolve));
      } finally {
        current -= 1;
      }
      return n;
    })
  );

  try {
    await waitFor(() => entered >= 2, "two slots did not start");
    // Worst case is the slot maximum. A run that sees 3 never applied the cap.
    assert.strictEqual(entered, 2, "third call must wait; seeing 3 means the cap is missing");
    assert.strictEqual(current, 2);
    assert.strictEqual(max, 2, "slot maximum is 2; a test that sees 3 missed the cap");

    releases.shift()();
    await waitFor(() => entered >= 3, "queued third call did not start");
    assert.strictEqual(max, 2, "slot maximum is 2; a test that sees 3 missed the cap");
    assert.ok(current <= 2);
  } finally {
    while (releases.length) releases.shift()();
  }

  const results = await Promise.all(tasks);
  assert.deepStrictEqual(results, [1, 2, 3]);
  assert.strictEqual(max, 2);
  assert.strictEqual(current, 0);
});

test("nested withWikiSlot does not deadlock when both slots are held", async () => {
  const tasks = [0, 1].map((n) =>
    withWikiSlot(async () => {
      const inner = await withWikiSlot(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return n;
      });
      return inner;
    })
  );
  const outcome = await Promise.race([
    Promise.all(tasks).then((values) => ({ ok: true, values })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 1000)),
  ]);
  assert.strictEqual(outcome.ok, true, "nested slots must not deadlock when both slots are held");
  assert.deepStrictEqual(outcome.values, [0, 1]);
});

test("a rejected withWikiSlot frees its slot", async () => {
  await assert.rejects(
    withWikiSlot(async () => {
      throw new Error("slot-boom");
    }),
    /slot-boom/
  );

  let current = 0;
  let max = 0;
  const releases = [];
  const tasks = [0, 1].map(() =>
    withWikiSlot(async () => {
      current += 1;
      if (current > max) max = current;
      try {
        await new Promise((resolve) => releases.push(resolve));
      } finally {
        current -= 1;
      }
    })
  );
  try {
    await waitFor(() => current === 2, "both slots should be free after a rejection");
    assert.strictEqual(max, 2);
  } finally {
    while (releases.length) releases.shift()();
  }
  await Promise.all(tasks);
});

test("41st allowUserWiki on the same calendar day is false; the next calendarDate is true", () => {
  const user = "quota-user";
  const tz = "UTC";

  withNow("2026-06-01T12:00:00.000Z", () => {
    for (let i = 1; i <= 40; i++) {
      assert.strictEqual(allowUserWiki(user, tz), true, `resolution ${i} should be allowed`);
    }
    assert.strictEqual(allowUserWiki(user, tz), false, "41st resolution on this calendarDate");
    assert.strictEqual(allowUserWiki(user, tz), false, "still blocked the same day");
    assert.strictEqual(allowUserWiki("quota-other", tz), true, "another user has their own counter");
  });

  // 22:30Z is still 1 June in UTC and already 2 June in Vienna.
  withNow("2026-06-01T22:30:00.000Z", () => {
    assert.strictEqual(allowUserWiki(user, "UTC"), false);
    assert.strictEqual(allowUserWiki(user, "Europe/Vienna"), true, "next calendarDate in tz");
  });

  withNow("2026-06-02T12:00:00.000Z", () => {
    assert.strictEqual(allowUserWiki(user, tz), true, "next UTC calendarDate starts again");
  });

  withNow("2026-06-01T23:00:00.000Z", () => {
    assert.strictEqual(allowUserWiki(user, tz), false, "same calendarDate stays exhausted");
  });
});

test("allowUserWiki without a user id is not counted", () => {
  for (let i = 0; i < 45; i++) {
    assert.strictEqual(allowUserWiki(undefined, "UTC"), true);
    assert.strictEqual(allowUserWiki(null, "UTC"), true);
    assert.strictEqual(allowUserWiki("", "Europe/Vienna"), true);
  }
});

test("proposeWikiForName on HTTP 500 returns lookup-failed, not a silent miss", async () => {
  let calls = 0;
  const restore = useGet(async () => {
    calls += 1;
    throw httpError(500);
  });
  try {
    const result = await withoutWarn(() =>
      proposeWikiForName("ua-http-500", "Ada Lovelace", "2026-01-01", 40)
    );
    assert.strictEqual(result.error, "lookup-failed");
    assert.strictEqual(result.wikiUrl, null);
    assert.strictEqual(calls, 2, "500 is not retried; EN and DE are each tried once");
  } finally {
    restore();
  }
});

test("an empty EN search plus a DE 500 is lookup-failed, not a miss", async () => {
  let calls = 0;
  const restore = useGet(async (url) => {
    calls += 1;
    if (String(url).includes("en.wikipedia.org")) {
      return { status: 200, data: { query: { search: [] } } };
    }
    throw httpError(500);
  });
  try {
    const result = await withoutWarn(() =>
      proposeWikiForName("ua-partial-500", "Nobody Partial", "2026-01-01", null)
    );
    assert.strictEqual(result.error, "lookup-failed");
    assert.strictEqual(result.wikiUrl, null);
    assert.strictEqual(calls, 2);
  } finally {
    restore();
  }
});

test("a finished search with no person is a miss and has no error", async () => {
  let calls = 0;
  const restore = useGet(async () => {
    calls += 1;
    return { status: 200, data: { query: { search: [] } } };
  });
  try {
    const result = await proposeWikiForName("ua-miss", "Nobody Zzzzz", "2026-01-01", 12);
    assert.strictEqual(result.wikiUrl, null);
    assert.strictEqual(result.proposedAge, 12);
    assert.strictEqual(Object.hasOwn(result, "error"), false);
    assert.strictEqual(calls, 2);
  } finally {
    restore();
  }
});

test("a non-person page is a miss, not lookup-failed", async () => {
  const restore = useGet(async (url, opts = {}) => {
    const params = opts.params || {};
    if (params.list === "search") {
      if (String(url).includes("de.wikipedia.org")) {
        return { status: 200, data: { query: { search: [] } } };
      }
      return {
        status: 200,
        data: { query: { search: [{ title: "Some Film", snippet: "a movie" }] } },
      };
    }
    if (String(params.prop || "").includes("pageprops")) {
      return {
        status: 200,
        data: {
          query: {
            pages: {
              1: {
                title: "Some Film",
                pageprops: { wikibase_item: "Q9" },
                fullurl: "https://en.wikipedia.org/wiki/Some_Film",
              },
            },
          },
        },
      };
    }
    if (String(url).includes("wikidata.org")) {
      return {
        status: 200,
        data: {
          entities: {
            Q9: {
              claims: {
                P31: [{ mainsnak: { datavalue: { value: { id: "Q11424" } } } }],
              },
            },
          },
        },
      };
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await proposeWikiForName("ua-film", "Some Film", "2026-01-01", null);
    assert.strictEqual(result.wikiUrl, null);
    assert.strictEqual(Object.hasOwn(result, "error"), false);
    assert.deepStrictEqual(result.candidates, []);
  } finally {
    restore();
  }
});

test("proposeWikiForName stops when the first hit is unambiguously human", async () => {
  const titles = [];
  const urls = [];
  const restore = useGet(async (url, opts = {}) => {
    const params = opts.params || {};
    urls.push(String(url));
    if (params.titles) titles.push(params.titles);
    if (params.list === "search") {
      return {
        status: 200,
        data: {
          query: {
            search: [
              { title: "Ada Lovelace", snippet: "mathematician" },
              { title: "Ada Lovelace (film)", snippet: "film" },
              { title: "Ada Lovelace Prize", snippet: "award" },
            ],
          },
        },
      };
    }
    if (String(params.prop || "").includes("pageprops")) {
      return {
        status: 200,
        data: {
          query: {
            pages: {
              1: {
                title: params.titles,
                pageprops: { wikibase_item: "Q7259" },
                fullurl: "https://en.wikipedia.org/wiki/Ada_Lovelace",
              },
            },
          },
        },
      };
    }
    if (String(url).includes("wikidata.org")) {
      return {
        status: 200,
        data: {
          entities: {
            Q7259: {
              claims: {
                P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }],
                P569: [{ mainsnak: { datavalue: { value: { time: "+1815-12-10T00:00:00Z" } } } }],
              },
              sitelinks: { enwiki: { title: "Ada Lovelace" } },
            },
          },
        },
      };
    }
    throw new Error(`unexpected ${url} ${JSON.stringify(params)}`);
  });
  try {
    const result = await proposeWikiForName("ua-unambig-q5", "Ada Lovelace", "2026-01-01", null);
    assert.strictEqual(Object.hasOwn(result, "error"), false);
    assert.strictEqual(result.candidates.length, 1);
    assert.match(result.wikiUrl, /Ada_Lovelace/);
    assert.deepStrictEqual(titles, ["Ada Lovelace"]);
    assert.strictEqual(urls.filter((u) => u.includes("de.wikipedia.org")).length, 0);
    // Search plus the one page. No category fetch once Wikidata says human.
    assert.strictEqual(urls.filter((u) => u.includes("en.wikipedia.org")).length, 2);
  } finally {
    restore();
  }
});

test("search keeps going until a hit is unambiguous, then stops", async () => {
  const pageTitles = [];
  const restore = useGet(async (url, opts = {}) => {
    const params = opts.params || {};
    if (params.list === "search") {
      return {
        status: 200,
        data: {
          query: {
            search: [
              { title: "Pat Example", snippet: "one" },
              { title: "Pat Other", snippet: "two" },
              { title: "Pat Third", snippet: "three" },
            ],
          },
        },
      };
    }
    if (String(params.prop || "").includes("categories")) {
      return { status: 200, data: { query: { pages: { 1: { categories: [] } } } } };
    }
    if (String(params.prop || "").includes("pageprops")) {
      pageTitles.push(params.titles);
      const qid = params.titles === "Pat Example" ? "Q1" : "Q2";
      return {
        status: 200,
        data: {
          query: {
            pages: {
              1: {
                title: params.titles,
                pageprops: { wikibase_item: qid },
                fullurl: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(params.titles).replace(/ /g, "_"))}`,
              },
            },
          },
        },
      };
    }
    if (String(url).includes("wikidata.org")) {
      if (params.ids === "Q1") {
        return {
          status: 200,
          data: {
            entities: {
              Q1: {
                claims: {
                  P569: [{ mainsnak: { datavalue: { value: { time: "+1980-01-01T00:00:00Z" } } } }],
                },
                sitelinks: { enwiki: { title: "Pat Example" } },
              },
            },
          },
        };
      }
      return {
        status: 200,
        data: {
          entities: {
            Q2: {
              claims: {
                P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }],
                P569: [{ mainsnak: { datavalue: { value: { time: "+1970-05-05T00:00:00Z" } } } }],
              },
              sitelinks: { enwiki: { title: "Pat Other" } },
            },
          },
        },
      };
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await proposeWikiForName("ua-unambig-second", "Pat", "2026-01-01", null);
    assert.strictEqual(Object.hasOwn(result, "error"), false);
    assert.deepStrictEqual(
      result.candidates.map((c) => c.title),
      ["Pat Example", "Pat Other"]
    );
    assert.deepStrictEqual(pageTitles, ["Pat Example", "Pat Other"]);
  } finally {
    restore();
  }
});

test("person categories without a non-person category stop the search", async () => {
  const urls = [];
  const restore = useGet(async (url, opts = {}) => {
    const params = opts.params || {};
    urls.push(url);
    if (params.list === "search") {
      return {
        status: 200,
        data: {
          query: {
            search: [
              { title: "Sam Sample", snippet: "person" },
              { title: "Sam Sample Jr", snippet: "other" },
            ],
          },
        },
      };
    }
    if (String(params.prop || "").includes("categories")) {
      return {
        status: 200,
        data: {
          query: {
            pages: {
              1: { categories: [{ title: "Category:1950 births" }, { title: "Category:Living people" }] },
            },
          },
        },
      };
    }
    if (String(params.prop || "").includes("pageprops")) {
      return {
        status: 200,
        data: {
          query: {
            pages: {
              1: {
                title: "Sam Sample",
                fullurl: "https://en.wikipedia.org/wiki/Sam_Sample",
              },
            },
          },
        },
      };
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await proposeWikiForName("ua-unambig-cat", "Sam Sample", "2026-01-01", 44);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.title, "Sam Sample");
    assert.match(result.wikiUrl, /Sam_Sample/);
    assert.strictEqual(result.proposedAge, 44);
    assert.ok(!urls.some((u) => String(u).includes("wikidata.org")));
    assert.ok(!urls.some((u) => String(u).includes("de.wikipedia.org")));
  } finally {
    restore();
  }
});

test("lookupUrl throws Keine Wikipedia-URL when the URL cannot be normalized", async () => {
  for (const url of ["https://example.com/wiki/Foo", "Ada Lovelace", "", null]) {
    await assert.rejects(
      () => lookupUrl("ua-bad-url", url, "2026-01-01", null),
      (err) => {
        assert.strictEqual(err.message, "Keine Wikipedia-URL.");
        return true;
      }
    );
  }
});

test("lookupUrl HTTP 500 throws instead of returning a miss", async () => {
  let calls = 0;
  const restore = useGet(async () => {
    calls += 1;
    throw httpError(500);
  });
  try {
    await assert.rejects(
      () => lookupUrl("ua-lookup-500", "https://en.wikipedia.org/wiki/Ada_Lovelace", "2026-01-01", null),
      (err) => {
        assert.notStrictEqual(err.message, "Keine Wikipedia-URL.");
        assert.match(err.message, /500/);
        return true;
      }
    );
    assert.strictEqual(calls, 1);
  } finally {
    restore();
  }
});

test("resolveEnglishArticle reuses one client per user agent", async () => {
  let creates = 0;
  const realCreate = axios.create;
  axios.create = () => {
    creates += 1;
    return {
      async get() {
        return {
          status: 200,
          data: { query: { pages: { 1: { langlinks: [{ "*": "Ada Lovelace" }] } } } },
        };
      },
    };
  };
  try {
    const first = await resolveEnglishArticle("ua-reuse", "https://de.wikipedia.org/wiki/Ada_Lovelace");
    const second = await resolveEnglishArticle("ua-reuse", "https://de.wikipedia.org/wiki/Bertha_Benz");
    assert.strictEqual(creates, 1);
    assert.strictEqual(first, "https://en.wikipedia.org/wiki/Ada_Lovelace");
    assert.strictEqual(second, first);
    const other = await resolveEnglishArticle("ua-reuse-other", "https://de.wikipedia.org/wiki/Ada_Lovelace");
    assert.strictEqual(creates, 2);
    assert.strictEqual(other, first);
  } finally {
    axios.create = realCreate;
  }
});

test("proposeWikiForName treats exhausted HTTP 429 as lookup-failed", { timeout: 20000 }, async () => {
  let calls = 0;
  const restore = useGet(async () => {
    calls += 1;
    throw httpError(429);
  });
  const started = Date.now();
  try {
    const result = await withoutWarn(() =>
      proposeWikiForName("ua-429", "Rate Limited", "2026-01-01", null)
    );
    const elapsed = Date.now() - started;
    assert.strictEqual(result.error, "lookup-failed");
    assert.strictEqual(result.wikiUrl, null);
    assert.strictEqual(calls, 6, "three tries for EN and three for DE");
    assert.ok(elapsed >= 3500, `429 backoff should wait, took ${elapsed}ms`);
  } finally {
    restore();
  }
});
