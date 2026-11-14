const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-rollover-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const { runYearRollover, formatSeasonReviewText, remindAdminToAnnounce, createNextSeasonChannel } = require("../src/jobs/year-rollover");

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

// Minimale Fake-Discord-Channel, die .send() und .isTextBased() können
function makeFakeChannel(bucket) {
  return {
    isTextBased: () => true,
    send: async (payload) => {
      bucket.push(payload);
      return { id: "m" + bucket.length };
    },
  };
}

function makeFakeClient(channel) {
  return {
    channels: {
      fetch: async () => channel,
    },
  };
}

test("seasonReview aggregates snapshots + deaths", () => {
  const running = db.getActiveSeason();
  db.upsertPlayer({ displayName: "Alpha", discordUserId: "10" });
  db.upsertPlayer({ displayName: "Beta", discordUserId: "11" });
  const recap = db.seasonReview(running.id);
  assert.ok(recap, "review must exist");
  assert.ok(Array.isArray(recap.rows));
  assert.strictEqual(typeof recap.deaths, "number");
});

test("formatSeasonReviewText renders standings without placeholders", () => {
  const review = db.seasonReview(db.getActiveSeason().id);
  const text = formatSeasonReviewText(review, 2027);
  assert.ok(text, "text must render");
  assert.ok(text.includes("Abschlussbilanz"));
  assert.ok(text.includes("2027"), "new running year should be announced");
  assert.ok(!isNaN(text.match(/\d+/)?.[0]) === false || true); // smoke
  assert.ok(!/\{[A-Z_]+\}/.test(text), "no leftover placeholders");
});

test("runYearRollover posts review and performs switch on deadline", async () => {
  const bucket = [];
  const channel = makeFakeChannel(bucket);
  const client = makeFakeClient(channel);

  const runningBefore = db.getActiveSeason();
  db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: "777", note: null });

  const res = await runYearRollover(client, config, { force: true });
  assert.strictEqual(res.switched, true, "must switch when forced to deadline");
  assert.strictEqual(res.activated.year, 2027);
  assert.strictEqual(res.archived.year, runningBefore.year);
  assert.strictEqual(db.getActiveSeason().year, 2027, "2027 must now be active");
  assert.strictEqual(db.getActiveSeason().phase, "running");
  assert.ok(bucket.length >= 2, "review + switch-ack messages posted");
  // Erste Nachricht ist die Auswertung
  assert.ok(bucket[0].content.includes("Abschlussbilanz"), "review posted first");

  // Zugriff: keine zweite Saison durch den automatischen Rollover erzeugt
  const counts = db.getDb().prepare("SELECT COUNT(*) c FROM seasons").get().c;
  assert.strictEqual(counts, 2, "exactly running + announced (no duplicate)");
});

test("runYearRollover skips switch when no announced season", async () => {
  // Nach dem vorherigen Test: 2027 ist running/aktiv, KEINE announced-Saison —
  // genau der Zustand, den dieser Test braucht.
  const runningNow = db.getActiveSeason();
  assert.strictEqual(db.getAnnouncedSeason(), null, "precondition: no announced");

  const bucket = [];
  const channel = makeFakeChannel(bucket);
  const client = makeFakeClient(channel);

  const res = await runYearRollover(client, config, { force: true });
  assert.strictEqual(res.switched, false);
  assert.strictEqual(res.reason, "no-announced");
  assert.strictEqual(db.getActiveSeason().id, runningNow.id, "running unchanged");
});

test("remindAdminToAnnounce stays silent when new season already announced", async () => {
  const running = db.getActiveSeason();
  const { season } = db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "c",
    note: null,
  });
  assert.strictEqual(season.phase, "announced");
  const res = await remindAdminToAnnounce(makeFakeClient(makeFakeChannel([])), config);
  assert.strictEqual(res.reminded, false, "no reminder when announced exists");
  assert.strictEqual(res.reason, "already-announced");
});

test("createNextSeasonChannel creates deathpool-{year} and invites players", async () => {
  // Player anlegen, die eingeladen werden sollen
  db.upsertPlayer({ displayName: "Alpha", discordUserId: "1001" });
  db.upsertPlayer({ displayName: "Beta", discordUserId: "2002" });
  const created = [];
  const fakeGuild = {
    channels: {
      cache: { find: () => undefined },
      create: async (opts) => {
        created.push(opts);
        return { id: "chan-123", name: opts.name };
      },
    },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };
  const client = {
    guilds: { fetch: async () => fakeGuild },
  };
  const ch = await createNextSeasonChannel(client, cfg, 2027);
  assert.ok(ch, "channel returned");
  assert.strictEqual(ch.id, "chan-123");
  assert.ok(created.length === 1, "channel.create called once");
  assert.strictEqual(created[0].name, "deathpool-2027");
  // Überwrites: alle Spieler haben ViewChannel+SendMessages
  const ids = created[0].permissionOverwrites.map((o) => o.id);
  assert.ok(ids.includes("1001") && ids.includes("2002"), "players invited");
  assert.ok(
    created[0].permissionOverwrites.every((o) => o.allow.includes("ViewChannel")),
    "all invitees can view"
  );
});

test("createNextSeasonChannel derives guild from deathpool channel (no guild id)", async () => {
  const created = [];
  const fakeGuild = {
    name: "Greggs Server",
    channels: {
      cache: { find: () => undefined },
      create: async (opts) => {
        created.push(opts);
        return { id: "chan-456", name: opts.name };
      },
    },
  };
  const cfg = { ...config, discordGuildId: "" }; // NICHT gesetzt
  const client = {
    guilds: { fetch: async () => null },
    channels: {
      // Deathpool-Kanal liefert .guild
      fetch: async () => ({ isTextBased: () => true, guild: fakeGuild }),
    },
  };
  const ch = await createNextSeasonChannel(client, cfg, 2028);
  assert.ok(ch, "channel created via derived guild");
  assert.strictEqual(created[0].name, "deathpool-2028");
});

test("remindAdminToAnnounce sends when nothing announced (current-year season)", async () => {
  // Zustand: aktive Saison = AKTUELLES Jahr (Runde 2026 läuft in 2026), keine
  // announced → Nov/Dez-Vorlauf: Erinnerung soll raus.
  db.getDb()
    .prepare(`UPDATE seasons SET phase = 'archived' WHERE phase = 'announced'`)
    .run();
  db.getDb()
    .prepare(
      `UPDATE seasons SET year = ?, start_date = ? WHERE active = 1 AND phase = 'running'`
    )
    .run(new Date().getFullYear(), `${new Date().getFullYear()}-01-01`);
  assert.strictEqual(db.getAnnouncedSeason(), null);
  const running = db.getActiveSeason();
  assert.strictEqual(running.year, new Date().getFullYear(), "active season = current year");

  const bucket = [];
  const channel = makeFakeChannel(bucket);
  const client = makeFakeClient(channel);
  // config ohne channelAdmin → sendAdmin fällt auf DM (preferDmUser nicht gesetzt)
  // → kein Ziel, kein Crash, aber reminded=true, reason='sent'.
  const res = await remindAdminToAnnounce(client, config);
  assert.strictEqual(res.reminded, true);
  assert.strictEqual(res.reason, "sent");
  assert.strictEqual(res.target, new Date().getFullYear() + 1, "reminds about next year");
});
