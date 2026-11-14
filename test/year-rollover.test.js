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
const {
  runYearRollover,
  formatSeasonReviewText,
  remindAdminToAnnounce,
  createNextSeasonChannel,
  todayInVienna,
} = require("../src/jobs/year-rollover");

let config;
before(() => {
  config = loadConfig();
  db.openDb(config);
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Frischer Ausgangszustand für Rollover-Tests: KEIN announced, die aktive Saison
 * ist das aktuelle Jahr (2026) als running. Der Reset nutzt bewusst nur
 * ensureActiveSeason + setSeasonLive — keine manuelle phase-SQL (das ist der
 * Punkt von F05: setSeasonLive muss die phase selbst setzen).
 */
function resetToRunningCurrentYear() {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true); // F05: setzt automatisch phase='running'
}

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
// ---- F01: todayInVienna ----

test("todayInVienna formats in Europe/Vienna (F01)", () => {
  // 2026-12-31T23:00:00Z == 00:00 am 01.01. in Wien
  assert.strictEqual(todayInVienna(new Date("2026-12-31T23:00:00Z")), "2027-01-01");
  // 22:59 UTC == 23:59 am 31.12. in Wien
  assert.strictEqual(todayInVienna(new Date("2026-12-31T22:59:00Z")), "2026-12-31");
  // null -> jetzt (kein Absturz / keine Epoch-Koersion)
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(todayInVienna(null)));
});

// ---- F01: Guard-Weg mit überschriebenem Datum (kein force) ----

test("runYearRollover switches at 23:00Z on Dec 31 (= Jan 1 Vienna) without force (F01)", async () => {
  resetToRunningCurrentYear();
  const runningBefore = db.getActiveSeason();
  assert.strictEqual(runningBefore.year, new Date().getFullYear());

  db.openAnnouncedSeason({
    year: new Date().getFullYear() + 1,
    startDate: `${new Date().getFullYear() + 1}-01-01`,
    channelId: "777",
    note: null,
  });

  const bucket = [];
  const channel = makeFakeChannel(bucket);
  const client = makeFakeClient(channel);

  // Eingefrorener Instant: Cron-Zeitpunkt 00:00 Europe/Vienna am 01.01. =
  // 2026-12-31T23:00:00Z. start_date (2027-01-01) ist erreicht => Wechsel OHNE force.
  const frozen = new Date("2026-12-31T23:00:00Z");
  const res = await runYearRollover(client, config, { force: false, now: frozen });

  assert.strictEqual(res.switched, true, "must switch at Vienna Jan 1 without force");
  assert.strictEqual(res.reason, undefined);
  assert.strictEqual(res.activated.year, new Date().getFullYear() + 1);
  assert.strictEqual(res.archived.year, runningBefore.year);
  assert.strictEqual(db.getActiveSeason().year, new Date().getFullYear() + 1, "new season active");
  assert.strictEqual(db.getActiveSeason().phase, "running");

  // Bilanz (first message) + Switch-Ack
  assert.ok(bucket.length >= 2, "review + switch-ack messages posted");
  assert.ok(bucket[0].content.includes("Abschlussbilanz"), "review posted first");
  // F03: Live-Satz NUR auf dem committeten Pfad, kein 'null' im Text
  assert.ok(bucket[0].content.includes("ist live"), "live sentence when switched");
  assert.ok(!bucket[0].content.includes("null"), "no 'null' in live text");
});

test("runYearRollover does NOT switch before Vienna midnight (F01 guard)", async () => {
  resetToRunningCurrentYear();
  db.openAnnouncedSeason({
    year: new Date().getFullYear() + 1,
    startDate: `${new Date().getFullYear() + 1}-01-01`,
    channelId: "777",
    note: null,
  });

  const bucket = [];
  const client = makeFakeClient(makeFakeChannel(bucket));
  // 22:59 UTC am 31.12. == 31.12. in Wien: start_date (01.01.) noch NICHT erreicht
  const frozen = new Date("2026-12-31T22:59:00Z");
  const res = await runYearRollover(client, config, { force: false, now: frozen });

  assert.strictEqual(res.switched, false);
  assert.strictEqual(res.reason, "not-yet");
  assert.strictEqual(db.getActiveSeason().phase, "running", "active unchanged");
  assert.strictEqual(db.getActiveSeason().year, new Date().getFullYear(), "still current year");
});

// ---- F02: Nachhol-Run nach erfolgreichem Wechsel -> no-announced ----

test("runYearRollover after success is a no-op (F02 catch-up safety)", async () => {
  // Zustand: Wechsel von 2026 -> 2027 bereits committet, KEINE announced-Saison.
  resetToRunningCurrentYear();
  db.openAnnouncedSeason({
    year: new Date().getFullYear() + 1,
    startDate: `${new Date().getFullYear() + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  const first = await runYearRollover(makeFakeClient(makeFakeChannel([])), config, {
    force: true,
  });
  assert.strictEqual(first.switched, true, "setup switch happens");

  // Zweiter Lauf (z. B. Start-Nachhol nach Restart): announced verbraucht.
  const bucket = [];
  const client = makeFakeClient(makeFakeChannel(bucket));
  const res = await runYearRollover(client, config, { force: false });

  assert.strictEqual(res.switched, false, "no second switch");
  assert.strictEqual(res.reason, "no-announced");
  assert.strictEqual(db.getActiveSeason().year, new Date().getFullYear() + 1, "no double switch");
  // Kein Live-Satz, kein 'null' im Text (F03)
  assert.ok(bucket.length >= 1, "review of running season still posted");
  assert.ok(!bucket[bucket.length - 1].content.includes("ist live"), "no live sentence without switch");
  assert.ok(!bucket[bucket.length - 1].content.includes("null"), "no 'null' in text");
});

// ---- F05: setSeasonLive setzt phase mit ----

test("setSeasonLive(true/false) maintains phase without manual SQL (F05)", () => {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason(); // phase='setup', live=0

  let s = db.getActiveSeason();
  assert.strictEqual(s.phase, "setup");
  assert.strictEqual(s.live, 0);

  db.setSeasonLive(true); // wie /go — KEINE manuelle phase-SQL
  s = db.getActiveSeason();
  assert.strictEqual(s.live, 1);
  assert.strictEqual(s.phase, "running", "setSeasonLive(true) must set phase running");

  db.setSeasonLive(false); // wie /ungo
  s = db.getActiveSeason();
  assert.strictEqual(s.live, 0);
  assert.strictEqual(s.phase, "setup", "setSeasonLive(false) must reset phase to setup");
});

// ---- F05: activateAnnouncedSeason klappt NACH /go ohne manuelles SQL ----

test("activateAnnouncedSeason works after setSeasonLive(true) with no manual update (F05)", () => {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true); // /go Äquivalent: live=1 + phase='running' automatisch

  const running = db.getActiveSeason();
  assert.strictEqual(running.phase, "running");

  db.openAnnouncedSeason({
    year: new Date().getFullYear() + 1,
    startDate: `${new Date().getFullYear() + 1}-01-01`,
    channelId: "777",
    note: null,
  });

  const res = db.activateAnnouncedSeason(); // darf NICHT „Aktive Saison ist nicht running" werfen
  assert.strictEqual(res.archived.phase, "archived");
  assert.strictEqual(res.activated.phase, "running");
  assert.strictEqual(db.getActiveSeason().phase, "running");
});

// ---- F03: formatSeasonReviewText(null) / wiederkehrende Darstellung ----

test("formatSeasonReviewText omits live sentence when runningYear is null (F03)", () => {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true);
  const review = db.seasonReview(db.getActiveSeason().id);
  assert.ok(review, "review must exist");

  const withoutLive = formatSeasonReviewText(review, null);
  assert.ok(withoutLive, "text renders with null runningYear");
  assert.ok(withoutLive.includes("Abschlussbilanz"));
  assert.ok(!withoutLive.includes("ist live"), "no live sentence on no-announced path");
  assert.ok(!withoutLive.includes("null"), "no 'null' placeholder leaked");
});

test("formatSeasonReviewText renders standings + live sentence when switched", () => {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true);
  const review = db.seasonReview(db.getActiveSeason().id);
  const text = formatSeasonReviewText(review, 2027);
  assert.ok(text.includes("Abschlussbilanz"));
  assert.ok(text.includes("2027"), "new running year should be announced");
  assert.ok(!/\{[A-Z_]+\}/.test(text), "no leftover placeholders");
});

// ---- F07: Admin-Erinnerung mit DM-Fallback ----

test("remindAdminToAnnounce sends DM when no channelAdmin (F07)", async () => {
  // Zustand: keine announced-Saison
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true);
  assert.strictEqual(db.getAnnouncedSeason(), null);
  const running = db.getActiveSeason();

  const dmSent = [];
  const fakeClient = {
    channels: { fetch: async () => null }, // kein CHANNEL_ADMIN-Kanal
    users: {
      fetch: async (id) => ({
        id,
        createDM: async () => ({
          send: async (payload) => {
            dmSent.push(payload);
            return {};
          },
        }),
      }),
    },
  };
  const cfg = { ...config, channelAdmin: "" }; // CHANNEL_ADMIN leer

  const res = await remindAdminToAnnounce(fakeClient, cfg);
  assert.strictEqual(res.reminded, true, "reminder actually delivered");
  assert.strictEqual(res.reason, "sent");
  assert.strictEqual(dmSent.length, 1, "exactly one DM sent");
  assert.strictEqual(res.target, running.year + 1, "reminds about next year");
  assert.ok(dmSent[0].content.includes(String(running.year + 1)), "DM mentions target year");
});

test("remindAdminToAnnounce returns no-target without sendable target (F07)", async () => {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true);
  assert.strictEqual(db.getAnnouncedSeason(), null);

  const fakeClient = {
    channels: { fetch: async () => null },
    users: { fetch: async () => null }, // Admin nicht auflösbar
  };
  const cfg = { ...config, channelAdmin: "" };

  const res = await remindAdminToAnnounce(fakeClient, cfg);
  assert.strictEqual(res.reminded, false, "no false positive 'sent'");
  assert.strictEqual(res.reason, "no-target");
});

test("remindAdminToAnnounce stays silent when new season already announced", async () => {
  const running = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "c",
    note: null,
  });
  const res = await remindAdminToAnnounce(makeFakeClient(makeFakeChannel([])), config);
  assert.strictEqual(res.reminded, false, "no reminder when announced exists");
  assert.strictEqual(res.reason, "already-announced");
});

// ---- createNextSeasonChannel (unverändert) ----

test("createNextSeasonChannel creates deathpool-{year} and invites players", async () => {
  db.upsertPlayer({ displayName: "Alpha", discordUserId: "1001" });
  db.upsertPlayer({ displayName: "Beta", discordUserId: "2002" });
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      // F15: fetch() liefert die aktuellen Guild-Kanäle (kein Treffer → anlegen)
      fetch: async () => [],
      create: async (opts) => {
        created.push(opts);
        return { id: "chan-123", name: opts.name, permissionOverwrites: { cache: new Map() } };
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
    id: "guild-derive-1",
    channels: {
      fetch: async () => [],
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
      fetch: async () => ({ isTextBased: () => true, guild: fakeGuild }),
    },
  };
  const ch = await createNextSeasonChannel(client, cfg, 2028);
  assert.ok(ch, "channel created via derived guild");
  assert.strictEqual(created[0].name, "deathpool-2028");
});

// ---- F06: Kanal wirklich benutzen ----

test("F06: runYearRollover writes new channel id to deathpool_channel_id, NOT announce_channel_id", async () => {
  resetToRunningCurrentYear();
  const runningBefore = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: runningBefore.year + 1,
    startDate: `${runningBefore.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  // Kanal-Anlage: fake guild erstellt deathpool-{year}
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [],
      create: async (opts) => {
        created.push(opts);
        return { id: "newchan-9", name: opts.name, permissionOverwrites: { cache: new Map() } };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: {
      fetch: async (id) => makeFakeChannel([]), // für review + ack
    },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };
  const res = await runYearRollover(client, cfg, { force: true });
  assert.strictEqual(res.switched, true);

  const activated = db.getActiveSeason();
  assert.strictEqual(activated.year, runningBefore.year + 1);
  assert.strictEqual(activated.deathpool_channel_id, "newchan-9", "new id in deathpool_channel_id");
  assert.strictEqual(activated.announce_channel_id, "777", "announce_channel_id unchanged (Anmeldungskanal)");
});

test("F06: resolveDeathpoolChannel prefers stored id over env fallback", () => {
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "stored-chan-42");
  assert.strictEqual(db.resolveDeathpoolChannel(config), "stored-chan-42");
  // Env-Fallback greift erst ohne gespeicherte ID
  db.setSeasonDeathpoolChannel(running.id, null);
  assert.strictEqual(db.resolveDeathpoolChannel(config), config.channelDeathpool);
});

// ---- F15: Kanal-Anlage härten ----

test("F15: existing same-name GuildText channel is reused, overwrites synced for a NEW player", async () => {
  db.getDb().exec("DELETE FROM players");
  db.upsertPlayer({ displayName: "Old", discordUserId: "1001" });
  const edited = [];
  const existingChannel = {
    id: "exist-1",
    name: "deathpool-2027",
    type: 0, // GuildText
    permissionOverwrites: {
      cache: new Map([
        ["1001", { id: "1001", allow: { has: (p) => ["ViewChannel", "SendMessages"].includes(p) } }],
      ]),
      edit: async (userId, allow, opts) => {
        edited.push({ userId, allow, opts });
      },
    },
  };
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [existingChannel],
      create: async (opts) => {
        created.push(opts);
        return { id: "dup", name: opts.name };
      },
    },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };
  const client = { guilds: { fetch: async () => fakeGuild } };

  // Neuer Spieler erst NACH der Anfangsliste — er fehlt im Kanal-Overwrite.
  db.upsertPlayer({ displayName: "Newbie", discordUserId: "9999" });

  const ch = await createNextSeasonChannel(client, cfg, 2027);
  assert.strictEqual(ch.id, "exist-1", "existing channel reused");
  assert.strictEqual(created.length, 0, "create must NOT be called");
  // Overwrites für den NEUEN Spieler nachgezogen
  assert.strictEqual(edited.length, 1, "exactly one overwrite edit");
  assert.strictEqual(edited[0].userId, "9999");
  assert.ok(edited[0].allow.includes("ViewChannel") && edited[0].allow.includes("SendMessages"));
});

test("F15: voice channel with same name is NOT reused (creates text channel)", async () => {
  db.getDb().exec("DELETE FROM players");
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [{ id: "voice-1", name: "deathpool-2027", type: 2 }], // GUILD_VOICE
      create: async (opts) => {
        created.push(opts);
        return { id: "text-1", name: opts.name };
      },
    },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };
  const client = { guilds: { fetch: async () => fakeGuild } };
  const ch = await createNextSeasonChannel(client, cfg, 2027);
  assert.strictEqual(ch.id, "text-1", "text channel created despite same-named voice channel");
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].type, 0);
});

test("F15: create failure triggers logError and confirmation text („Wechsel ohne neuen Kanal”)", async () => {
  resetToRunningCurrentYear();
  const runningBefore = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: runningBefore.year + 1,
    startDate: `${runningBefore.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  const sent = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [],
      create: async () => {
        throw new Error("Missing Permissions / Kanal konnte nicht erstellt werden");
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: {
      // review + ack gehen an den konventionellen Zielkanal (kein neuer Kanal)
      fetch: async () => makeFakeChannel(sent),
    },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };

  const res = await runYearRollover(client, cfg, { force: true });
  assert.strictEqual(res.switched, true, "switch still commits");
  // Bestätigung nennt den Fehlschlag
  const ack = sent.find((p) => p.content && p.content.includes("Saisonwechsel"));
  assert.ok(ack, "switch-ack posted");
  assert.ok(ack.content.includes("Wechsel ohne neuen Kanal"), "ack mentions failed channel setup");
  // Kein Kanal wurde gespeichert
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
});

// ---- F06: announce.js + Tagesbericht nutzen den gespeicherten Kanal ----

test("F06: announceDailySummary sends to the stored deathpool channel, not the env fallback", async () => {
  const { announceDailySummary } = require("../src/discord/announce");
  const running = db.getActiveSeason();
  db.setSeasonLive(true);
  db.setSeasonDeathpoolChannel(running.id, "stored-summary-1");

  const fetched = [];
  const sent = [];
  const client = {
    channels: {
      fetch: async (id) => {
        fetched.push(id);
        return makeFakeChannel(sent);
      },
    },
  };
  await announceDailySummary(client, config);
  assert.ok(fetched.includes("stored-summary-1"), "daily summary targets stored channel id");
  assert.ok(!fetched.includes(config.channelDeathpool), "env deathpool must NOT be used while stored id exists");
  assert.strictEqual(sent.length, 1, "summary message posted");

  db.setSeasonDeathpoolChannel(running.id, null);
});
