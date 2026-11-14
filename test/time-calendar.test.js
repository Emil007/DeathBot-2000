const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-time-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const {
  calendarDate,
  calendarYear,
  calendarMonthIndex,
  localMidnightUtc,
  parseCalendarDate,
  addCalendarDays,
  isValidTimeZone,
  applyProcessTimezone,
} = require("../src/db/time");
const { sanitizeDisplayName, mentionOpts } = require("../src/discord/safe-text");

const NYE = "2026-12-31T23:30:00.000Z";
const NEW_YORK_MORNING = "2027-01-01T02:00:00.000Z";
const UNNAMED = "\u201EUnbenannt\u201C";

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("contract worst case: Vienna midnight and non-leap Feb 29", () => {
  assert.strictEqual(
    localMidnightUtc("2027-01-01", "Europe/Vienna"),
    "2026-12-31T23:00:00.000Z"
  );
  assert.strictEqual(parseCalendarDate("2027-02-29"), null);
  assert.strictEqual(parseCalendarDate("2028-02-29"), "2028-02-29");
});

test("calendarDate follows the zone, not the UTC date", () => {
  assert.strictEqual(calendarDate(NYE, "Europe/Vienna"), "2027-01-01");
  assert.strictEqual(calendarDate(NYE, "Europe/Berlin"), "2027-01-01");
  assert.strictEqual(calendarDate(NYE, "UTC"), "2026-12-31");
  assert.strictEqual(calendarDate(NEW_YORK_MORNING, "America/New_York"), "2026-12-31");
  assert.strictEqual(calendarDate(new Date(NYE), "Europe/Vienna"), "2027-01-01");
});

test("calendarYear and calendarMonthIndex use the same civil date", () => {
  assert.strictEqual(calendarYear(NYE, "Europe/Vienna"), 2027);
  assert.strictEqual(calendarMonthIndex(NYE, "Europe/Vienna"), 0);
  assert.strictEqual(calendarYear(NYE, "UTC"), 2026);
  assert.strictEqual(calendarMonthIndex(NYE, "UTC"), 11);
  assert.strictEqual(calendarYear(NEW_YORK_MORNING, "America/New_York"), 2026);
  assert.strictEqual(calendarMonthIndex(NEW_YORK_MORNING, "America/New_York"), 11);
});

test("localMidnightUtc is the UTC instant of local midnight", () => {
  assert.strictEqual(
    localMidnightUtc("2027-01-01", "Europe/Vienna"),
    "2026-12-31T23:00:00.000Z"
  );
  assert.strictEqual(localMidnightUtc("2027-01-01", "UTC"), "2027-01-01T00:00:00.000Z");
  // Sommerzeit Wien (UTC+2): Mitternacht liegt zwei Stunden vor UTC-Mitternacht.
  assert.strictEqual(
    localMidnightUtc("2027-07-01", "Europe/Vienna"),
    "2027-06-30T22:00:00.000Z"
  );
  assert.strictEqual(
    localMidnightUtc("2027-01-01", "America/New_York"),
    "2027-01-01T05:00:00.000Z"
  );
});

test("parseCalendarDate accepts only real YYYY-MM-DD dates", () => {
  for (const bad of ["01.01.2027", "2027/01/01", "2027-1-1", "2027-02-29", "2027-02-31"]) {
    assert.strictEqual(parseCalendarDate(bad), null, bad);
  }
  assert.strictEqual(parseCalendarDate("2027-01-01"), "2027-01-01");
  assert.strictEqual(parseCalendarDate("2028-02-29"), "2028-02-29");
  assert.strictEqual(parseCalendarDate("2027-02-28"), "2027-02-28");
  assert.strictEqual(parseCalendarDate(" 2027-01-01"), null);
  assert.strictEqual(parseCalendarDate("2027-13-01"), null);
  assert.strictEqual(parseCalendarDate(null), null);
});

test("addCalendarDays shifts the civil date, including across a non-leap February", () => {
  assert.strictEqual(addCalendarDays("2027-02-28", 1), "2027-03-01");
  assert.strictEqual(addCalendarDays("2028-02-28", 1), "2028-02-29");
  assert.strictEqual(addCalendarDays("2028-02-29", 1), "2028-03-01");
  assert.strictEqual(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(addCalendarDays("2027-01-01", -1), "2026-12-31");
  assert.strictEqual(addCalendarDays("2027-03-28", 1), "2027-03-29");
  assert.throws(() => addCalendarDays("2027-02-29", 1), /Invalid calendar date/);
});

test("isValidTimeZone is false when Intl rejects the zone", () => {
  assert.strictEqual(isValidTimeZone("Not/AZone"), false);
  assert.strictEqual(isValidTimeZone(""), false);
  assert.strictEqual(isValidTimeZone("Europe/Vienna"), true);
  assert.strictEqual(isValidTimeZone("UTC"), true);
});

function withConfigEnv(patch, fn) {
  const keys = Object.keys(patch);
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  const errors = [];
  const orig = console.error;
  console.error = (...args) => {
    errors.push(args.map((part) => String(part)).join(" "));
  };
  try {
    for (const key of keys) {
      if (patch[key] === undefined) delete process.env[key];
      else process.env[key] = patch[key];
    }
    return fn(errors);
  } finally {
    console.error = orig;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("loadConfig falls back on an invalid TZ and does not set process.env.TZ", () => {
  withConfigEnv({ TZ: "Not/AZone" }, (errors) => {
    const cfg = loadConfig();
    assert.strictEqual(cfg.tz, "Europe/Vienna");
    assert.strictEqual(process.env.TZ, "Not/AZone");
    assert.ok(errors.length >= 1);
    assert.match(errors.join("\n"), /Invalid time zone "Not\/AZone"/);
    assert.match(errors.join("\n"), /Europe\/Vienna/);
  });
});

test("loadConfig logs and falls back when TZ is empty", () => {
  for (const empty of ["", "   "]) {
    withConfigEnv({ TZ: empty }, (errors) => {
      const cfg = loadConfig();
      assert.strictEqual(cfg.tz, "Europe/Vienna");
      assert.strictEqual(process.env.TZ, empty);
      assert.match(errors.join("\n"), /TZ is empty/);
      assert.match(errors.join("\n"), /Europe\/Vienna/);
    });
  }
});

test("loadConfig keeps a valid TZ and defaults when TZ is unset, without touching process.env.TZ", () => {
  withConfigEnv({ TZ: "UTC" }, (errors) => {
    const cfg = loadConfig();
    assert.strictEqual(cfg.tz, "UTC");
    assert.strictEqual(process.env.TZ, "UTC");
    assert.deepStrictEqual(errors, []);
  });
  withConfigEnv({ TZ: undefined }, (errors) => {
    const cfg = loadConfig();
    assert.strictEqual(cfg.tz, "Europe/Vienna");
    assert.strictEqual(process.env.TZ, undefined);
    assert.deepStrictEqual(errors, []);
  });
});

test("loadConfig throws when DISCORD_GUILD_ID is missing", () => {
  withConfigEnv({ DISCORD_GUILD_ID: undefined }, () => {
    assert.throws(() => loadConfig(), { message: "Missing required env: DISCORD_GUILD_ID" });
  });
  withConfigEnv({ DISCORD_GUILD_ID: "   " }, () => {
    assert.throws(() => loadConfig(), { message: "Missing required env: DISCORD_GUILD_ID" });
  });
});

test("applyProcessTimezone assigns process.env.TZ and nothing else", () => {
  const prevTz = process.env.TZ;
  const token = process.env.TOKEN;
  try {
    applyProcessTimezone({ tz: "UTC" });
    assert.strictEqual(process.env.TZ, "UTC");
    assert.strictEqual(process.env.TOKEN, token);
    applyProcessTimezone({ tz: "Europe/Vienna" });
    assert.strictEqual(process.env.TZ, "Europe/Vienna");
    assert.strictEqual(process.env.TOKEN, token);
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test("sanitizeDisplayName strips to one line and mentionOpts blocks parses", () => {
  assert.strictEqual(sanitizeDisplayName("Ada Lovelace"), "Ada Lovelace");
  assert.strictEqual(sanitizeDisplayName("  Ada   Lovelace  "), "Ada Lovelace");
  assert.strictEqual(sanitizeDisplayName("**Ada** _Lovelace_"), "Ada Lovelace");
  assert.strictEqual(sanitizeDisplayName("*_~|`<>@[]()"), UNNAMED);
  assert.strictEqual(sanitizeDisplayName("Foo\nBar"), "FooBar");
  assert.strictEqual(sanitizeDisplayName("Foo \n Bar"), "Foo Bar");
  assert.strictEqual(sanitizeDisplayName("Müller"), "Müller");
  assert.strictEqual(sanitizeDisplayName(""), UNNAMED);
  assert.strictEqual(sanitizeDisplayName("   \n\t"), UNNAMED);
  assert.strictEqual(sanitizeDisplayName(null), UNNAMED);
  assert.strictEqual(sanitizeDisplayName("A".repeat(81)), "A".repeat(80));
  assert.strictEqual(sanitizeDisplayName("A".repeat(80)), "A".repeat(80));
  const opts = mentionOpts();
  assert.deepStrictEqual(opts, { allowedMentions: { parse: [] } });
  opts.allowedMentions.parse.push("users");
  assert.deepStrictEqual(mentionOpts(), { allowedMentions: { parse: [] } });
});
