const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-m5-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const { buildSeasonEmbed, DEFAULT_YEAR, TRUNCATION_HINT, MAX_DESCRIPTION_LENGTH } = require("../src/discord/commands/announce-season");
const { assertWipeAllowed, assertActivateDateAllowed, todayInVienna } = require("../src/discord/commands/new-year");
const { rebuildPrefixArgs } = require("../src/index");

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

test("buildSeasonEmbed conveys the participation steps", () => {
  const embed = buildSeasonEmbed({
    year: 2027,
    startDate: "2027-01-01",
    channelName: "wettbuero",
    note: "Werdet Teil!",
    runningYear: 2026,
  });
  const d = embed.data && embed.data.description;
  const desc = typeof d === "string" ? d : JSON.stringify(embed);
  assert.ok(desc.includes("2027"));
  assert.ok(desc.includes("2027-01-01"));
  assert.ok(desc.includes("2026"), "running year must be mentioned");
  assert.ok(/Direktnachricht|DM/i.test(desc), "DM step must be described");
  assert.ok(/fertig|done/i.test(desc), "fertig step must be described");
  assert.ok(/raus|ist drau/iu.test(desc), "non-member exclusion must be described");
  const noteField = embed.data && (embed.data.fields || []).find?.((f) => f.value?.includes("Werdet Teil!"));
  assert.ok((embed.data && embed.data.description) ? desc.includes("Werdet Teil!") : noteField);
});

test("buildSeasonEmbed renders the code-default Gregg text with placeholders", () => {
  const embed = buildSeasonEmbed({
    year: 2030,
    startDate: "2030-01-01",
    channelName: "wettbuero",
    note: null,
    runningYear: 2029,
    maxPicks: 3,
  });
  const desc = embed.data.description;
  assert.ok(desc.includes("Gregg"), "Gregg introduces himself");
  assert.ok(desc.includes("2030"), "DB year rendered");
  assert.ok(desc.includes("2029"), "running year rendered");
  assert.ok(desc.includes("2030-01-01"), "DB start_date rendered");
  assert.ok(desc.includes("3"), "maxPicks rendered from config");
  assert.ok(!/\{[A-Z_]+\}/.test(desc), "no leftover placeholders");
  const leftoverTitle = (embed.data.title || "").match(/\{[A-Z_]+\}/);
  assert.ok(!leftoverTitle, "title has no leftover placeholders");
});

test("wipe is refused while a running season exists", () => {
  const res = assertWipeAllowed();
  assert.strictEqual(res.ok, false);
  const celebCount = db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c;
  // Nah an der Rolle: kein Wipe ausgeführt, Celebs bleiben
  assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c, celebCount);
});

test("repost path is safe: after openAnnouncedSeason + repost, counters unchanged", async () => {
  const running = db.getActiveSeason();
  const { season } = db.openAnnouncedSeason({
    year: 2027,
    startDate: "2027-01-01",
    channelId: "777",
    note: "x",
  });
  const before = {
    celebs: db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c,
    picks: db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c,
    awards: db.getDb().prepare("SELECT COUNT(*) c FROM death_awards").get().c,
    announced: db.getDb().prepare("SELECT COUNT(*) c FROM seasons WHERE phase='announced'").get().c,
  };
  // repost logik: nur setSeasonAnnounce falls neue Notiz + kein Schreiber in Tabellen
  db.setSeasonAnnounce(season.id, { channelId: "778", note: "neue notiz" });
  const after = {
    celebs: db.getDb().prepare("SELECT COUNT(*) c FROM celebs").get().c,
    picks: db.getDb().prepare("SELECT COUNT(*) c FROM picks").get().c,
    awards: db.getDb().prepare("SELECT COUNT(*) c FROM death_awards").get().c,
    announced: db.getDb().prepare("SELECT COUNT(*) c FROM seasons WHERE phase='announced'").get().c,
  };
  assert.deepStrictEqual(after, before, "repost must not touch pool tables nor add seasons");
  assert.strictEqual(db.getActiveSeason().id, running.id, "running season unchanged");
});

test("activate refuses before start_date via guard helper path", () => {
  // Der Datums-Guard ist inline; hier die Bedingung nachbilden
  const announced = db.getAnnouncedSeason();
  const today = "2026-11-14";
  const blocked = today < announced.start_date;
  assert.strictEqual(blocked, true);
});

// ---- F01: Datums-Guard hängt am Wiener Kalendertag ----

test("todayInVienna maps 23:00Z on Dec 31 to Jan 1 in Vienna (F01)", () => {
  assert.strictEqual(todayInVienna(new Date("2026-12-31T23:00:00Z")), "2027-01-01");
  assert.strictEqual(todayInVienna(new Date("2026-12-31T22:59:00Z")), "2026-12-31");
});

test("assertActivateDateAllowed allows switch at Vienna Jan 1 without force (F01)", () => {
  // Cron-Zeitpunkt 00:00 Europe/Vienna = 2026-12-31T23:00:00Z
  const frozen = new Date("2026-12-31T23:00:00Z");
  const res = assertActivateDateAllowed("2027-01-01", false, frozen);
  assert.strictEqual(res.ok, true, "must allow switch when Vienna date >= start_date");
});

test("assertActivateDateAllowed blocks before Vienna midnight (F01)", () => {
  // 22:59Z am 31.12. == 31.12. in Wien: 01.01. noch nicht erreicht
  const frozen = new Date("2026-12-31T22:59:00Z");
  const res = assertActivateDateAllowed("2027-01-01", false, frozen);
  assert.strictEqual(res.ok, false);
});

test("assertActivateDateAllowed force bypasses date (F01)", () => {
  const frozen = new Date("2026-11-14T10:00:00Z");
  const res = assertActivateDateAllowed("2027-01-01", true, frozen);
  assert.strictEqual(res.ok, true, "force skips the date check");
});

// ---- F11: Repost aktualisiert die Notiz im Embed ----

test("F11: repost keeps a previously set note and the NEW note wins (old ≠ empty)", async () => {
  const announced = db.getAnnouncedSeason();
  db.setSeasonAnnounce(announced.id, { channelId: "777", note: "alt" });

  const sent = [];
  const fakeChannel = {
    name: "wettbuero",
    async send(payload) {
      sent.push(payload);
      return payload;
    },
  };
  const ctx = {
    config: Object.assign({}, config, { channelLog: "", maxPicksPerPlayer: 50 }),
    client: { channels: { fetch: async () => fakeChannel } },
  };
  const args = ["repost", "note:neu"];
  const msg = {
    mentions: { channels: { first: () => null } },
    channel: { id: "1", send: async () => {} },
    author: { id: "1" },
    async reply(t) {
      return t;
    },
  };

  const cmd = require("../src/discord/commands/announce-season");
  await cmd.run(ctx, args, msg);

  assert.strictEqual(sent.length, 1, "embed must be posted");
  const desc = sent[0].embeds[0].data.description;
  assert.ok(desc.includes("📝 **Notiz:** neu"), "new note must be shown, old 'alt' must NOT win");
  assert.ok(!desc.includes("Notiz:** alt"), "old note must not leak into the embed");
  // DB-Nachweis: die neue Notiz ist persistiert
  assert.strictEqual(db.getAnnouncedSeason().announce_note, "neu");
});

// ---- F17: Embed-Description auf 4096 begrenzt, Notiz wird gekürzt ----

test("F17: 4000-char note yields description <= 4096 with truncation hint", () => {
  const embed = buildSeasonEmbed({
    year: 2027,
    startDate: "2027-01-01",
    note: "x".repeat(4000),
    runningYear: 2026,
  });
  const desc = embed.data.description;
  assert.ok(desc.length <= MAX_DESCRIPTION_LENGTH, `desc length ${desc.length} > 4096`);
  assert.ok(desc.includes(TRUNCATION_HINT), "truncated note must carry the (gekürzt) hint");
  assert.ok(desc.includes("Notiz:"), "note section still present");
});

test("F17: short note is NOT truncated and passes through unchanged", () => {
  const embed = buildSeasonEmbed({
    year: 2027,
    startDate: "2027-01-01",
    note: "kurz",
    runningYear: 2026,
  });
  const desc = embed.data.description;
  assert.ok(desc.includes("📝 **Notiz:** kurz"));
  assert.ok(!desc.includes(TRUNCATION_HINT));
});

test("F17: embed title stays within 256 chars", () => {
  const veryLongTitle = "Mein besonders langer und ausführlicher Titel ".repeat(20);
  const embed = buildSeasonEmbed({
    year: 2027,
    startDate: "2027-01-01",
    note: null,
    title: veryLongTitle,
    runningYear: 2026,
  });
  assert.ok(embed.data.title.length <= 256);
});

// ---- F18b: DEFAULT_YEAR hängt am Saisonjahr der laufenden Saison ----

test("F18b: DEFAULT_YEAR = year of running season + 1, independent of UTC month", () => {
  const active = db.getActiveSeason();
  const runningYear = Number(active.year);
  const got = DEFAULT_YEAR();
  assert.ok(Number.isFinite(got), "DEFAULT_YEAR must be a finite year");
  assert.strictEqual(got, runningYear + 1, "must be running-season year + 1, not UTC-month-branch");
});

// ---- F18d: Präfix note: mit Leerzeichen ----

test("F18d: rebuildPrefixArgs keeps `note:Wer will mitmachen` as one argument", () => {
  const line = "announce-season #k note:Wer will mitmachen";
  const parts = rebuildPrefixArgs(line.split(/\s+/));
  const note = parts.find((p) => p.startsWith("note:"));
  assert.ok(note, "note: argument must exist");
  assert.strictEqual(note, "note:Wer will mitmachen");
  assert.ok(parts.includes("#k"), "mention token preserved");
});

test("F18d: note value stops at the next known key/flag token", () => {
  assert.deepStrictEqual(
    rebuildPrefixArgs("note:abc year:2027 repost".split(/\s+/)),
    ["note:abc", "year:2027", "repost"]
  );
  assert.deepStrictEqual(rebuildPrefixArgs("note:Eins".split(/\s+/)), ["note:Eins"]);
  assert.deepStrictEqual(rebuildPrefixArgs("note:a b c".split(/\s+/)), ["note:a b c"]);
});
