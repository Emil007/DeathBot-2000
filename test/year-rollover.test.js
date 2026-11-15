const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { PermissionsBitField } = require("discord.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-rollover-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "guild-test";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const {
  runYearRollover,
  startYearRollover,
  formatSeasonReviewText,
  remindAdminToAnnounce,
  createNextSeasonChannel,
  finalizeYearSwitch,
  todayInVienna,
  isNewYearDayVienna,
  withChannelNameLock,
  remindUnfinalizedDrafts,
} = require("../src/jobs/year-rollover");
const { sendAdmin, resolveAdminTarget } = require("../src/discord/admin-notify");
const setupState = require("../src/jobs/setup-state");

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
  try {
    const ids = db.getDb().prepare("SELECT id FROM seasons").all();
    for (const row of ids) setupState.clearOpen(row.id);
  } catch {
    /* db noch leer */
  }
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true); // F05: setzt automatisch phase='running'
  setupState.clearOpen(db.getActiveSeason().id);
  // F20: Jahresbericht-Flag zurücksetzen, damit Tests den 01.01.-Pfad frisch prüfen.
  db.setMeta("year_rollover_annual_review", "0");
  db.getDb().prepare("DELETE FROM meta WHERE key = ?").run("pending_season_review");
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

// ---- TZ-Konfig: config.tz steuert den Datums-Guard ----

test("todayInVienna honors a configured timezone (config.tz, default Europe/Vienna)", () => {
  const inst = new Date("2026-12-31T23:00:00Z");
  // Default beim Aufruf ohne Argument: Europe/Vienna (rückwärtskompatibel).
  assert.strictEqual(todayInVienna(inst), "2027-01-01");
  // Explizit Europa/Berlin: 23:00 UTC = 00:00 Berlin → 01.01.
  assert.strictEqual(todayInVienna(inst, "Europe/Berlin"), "2027-01-01");
  // UTC: 23:00 UTC bleibt am 31.12. → Guard beeinflusst.
  assert.strictEqual(todayInVienna(inst, "UTC"), "2026-12-31");
  assert.strictEqual(isNewYearDayVienna(inst, "UTC"), false);
  assert.strictEqual(isNewYearDayVienna(inst, "Europe/Vienna"), true);
  // config-Default greift: config.tz ist Europe/Vienna (loadConfig ohne TZ-Env).
  assert.strictEqual(config.tz, "Europe/Vienna", "config.tz default is Europe/Vienna");
});

test("runYearRollover uses config.tz for the start-date guard (TZ-configurable)", async () => {
  resetToRunningCurrentYear();
  const runningBefore = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: runningBefore.year + 1,
    startDate: `${runningBefore.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });

  const bucket = [];
  const channel = makeFakeChannel(bucket);
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [],
      create: async (opts) => {
        created.push(opts);
        return { id: "newchan-tz", name: opts.name, permissionOverwrites: { cache: new Map() } };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => channel },
  };

  // 23:30 UTC am 31.12. == 31.12. in UTC, aber 00:30 am 01.01. in Berlin.
  // Mit config.tz = Europe/Berlin ist der Start erreicht → Wechsel (kein force).
  const berlinCfg = { ...config, discordGuildId: "guild-1", tz: "Europe/Berlin", channelLog: "" };
  const frozen = new Date("2026-12-31T23:30:00Z");
  const res = await runYearRollover(client, berlinCfg, { force: false, now: frozen });
  assert.strictEqual(res.switched, true, "switch happens in the configured TZ");

  // Derselbe Instant mit config.tz = UTC: 31.12. → noch NICHT erreicht (Guard).
  resetToRunningCurrentYear();
  db.openAnnouncedSeason({
    year: new Date().getFullYear() + 1,
    startDate: `${new Date().getFullYear() + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  const utcCfg = { ...config, discordGuildId: "guild-1", tz: "UTC", channelLog: "" };
  const res2 = await runYearRollover(client, utcCfg, { force: false, now: frozen });
  assert.strictEqual(res2.switched, false);
  assert.strictEqual(res2.reason, "not-yet");
});

test("startYearRollover returns timezone: config.tz and schedules in it", async () => {
  // node-cron's setTimeout hält den Event-Loop am Leben (nächster Fire weit in
  // der Zukunft) — deshalb cron im Test stubben und danach wiederherstellen.
  const cronPath = require.resolve("node-cron");
  const origCron = require.cache[cronPath]?.exports;
  const scheduled = [];
  require.cache[cronPath] = {
    exports: {
      schedule: (expr, fn, opts) => {
        scheduled.push({ expr, opts });
        return { stop: () => {} };
      },
    },
  };
  const yrPath = require.resolve("../src/jobs/year-rollover");
  delete require.cache[yrPath];
  const yr = require(yrPath);
  try {
    const out = yr.startYearRollover({}, { tz: "Europe/Berlin" });
    assert.strictEqual(out.timezone, "Europe/Berlin", "returned timezone is config.tz");
    assert.strictEqual(scheduled.length, 3, "rollover, announce reminder, draft reminder");
    assert.deepStrictEqual(
      scheduled.map((s) => s.expr),
      ["0 0 1 1 *", "0 0 1 11,12 *", "0 18 * * *"]
    );
    assert.ok(scheduled.every((s) => s.opts.timezone === "Europe/Berlin"));
  } finally {
    require.cache[cronPath] = origCron || { exports: {} };
    delete require.cache[yrPath];
    // Nach dem Stub wieder das ECHTE Modul laden, damit spätere Tests sehen.
    require(yrPath);
  }
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
  // Seit dem interaktiven Kanal-Setup gibt es keinen Env-Fallback mehr: der
  // neue Kanal entsteht über die Guild (DISCORD_GUILD_ID-Pfad), daran hängt
  // dann auch die Bilanz + Ack (preferredChannelId = neuer Kanal).
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [],
      create: async (opts) => {
        created.push(opts);
        return { id: "newchan-f01", name: opts.name, permissionOverwrites: { cache: new Map() } };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => channel },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };

  // Eingefrorener Instant: Cron-Zeitpunkt 00:00 Europe/Vienna am 01.01. =
  // 2026-12-31T23:00:00Z. start_date (2027-01-01) ist erreicht => Wechsel OHNE force.
  const frozen = new Date("2026-12-31T23:00:00Z");
  const res = await runYearRollover(client, cfg, { force: false, now: frozen });

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
  // F20(a): vor dem Stichtag KEIN Post — keine Abschlussbilanz der laufenden Saison.
  assert.strictEqual(bucket.length, 0, "no post before start_date (F20)");
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
  // F20: Außer am Wiener 01.01. wird auf dem no-announced-Pfad KEINE Bilanz
  // gepostet (keine Snapshots der laufenden Saison vorhanden).
  const bucket = [];
  const client = makeFakeClient(makeFakeChannel(bucket));
  const res = await runYearRollover(client, config, {
    force: false,
    now: new Date("2026-11-14T10:00:00Z"), // Normalbetrieb, nicht 01.01.
  });

  assert.strictEqual(res.switched, false, "no second switch");
  assert.strictEqual(res.reason, "no-announced");
  assert.strictEqual(db.getActiveSeason().year, new Date().getFullYear() + 1, "no double switch");
  assert.strictEqual(bucket.length, 0, "NO review post outside Jan 1 (F20)");
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
  assert.ok(dmSent[0].content.includes("Die Zeit des Todes naht"), "T04 tone");
  assert.ok(dmSent[0].content.includes(`${cfg.prefix}announce-season #Kanal`), "prefix from config");
  assert.ok(dmSent[0].content.includes("Ohne diese Eröffnung gibt es am Jahreswechsel keinen neuen Kanal."));
  assert.deepStrictEqual(dmSent[0].allowedMentions, { parse: [] });
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

test("remindAdminToAnnounce sends to CHANNEL_ADMIN when set (central sendAdmin path, F07)", async () => {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true);
  assert.strictEqual(db.getAnnouncedSeason(), null);
  const running = db.getActiveSeason();

  const channelSent = [];
  const fakeClient = {
    channels: {
      fetch: async (id) =>
        id === "admin-chan-9"
          ? { id: "admin-chan-9", isTextBased: () => true, send: async (payload) => { channelSent.push(payload); return {}; } }
          : null,
    },
    users: { fetch: async () => null }, // darf NICHT gebraucht werden, wenn CHANNEL_ADMIN gesetzt ist
  };
  const cfg = { ...config, channelAdmin: "admin-chan-9" };

  const res = await remindAdminToAnnounce(fakeClient, cfg);
  assert.strictEqual(res.reminded, true, "reminder delivered to admin channel");
  assert.strictEqual(res.reason, "sent");
  assert.strictEqual(channelSent.length, 1, "exactly one message to CHANNEL_ADMIN");
  assert.ok(channelSent[0].content.includes(String(running.year + 1)), "channel message mentions target year");
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
  for (const ow of created[0].permissionOverwrites) {
    assert.ok(Array.isArray(ow.allow), "boolean map must not be the create payload");
    assert.doesNotThrow(() => PermissionsBitField.resolve(ow.allow));
  }
  assert.throws(() => PermissionsBitField.resolve({ ViewChannel: true, SendMessages: true }));
});

test("createNextSeasonChannel does not derive a guild from another channel", async () => {
  const created = [];
  let guildFetches = 0;
  let channelFetches = 0;
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "stored-derive-9");
  const client = {
    guilds: {
      fetch: async () => {
        guildFetches++;
        return null;
      },
    },
    channels: {
      fetch: async () => {
        channelFetches++;
        return {
          isTextBased: () => true,
          guild: {
            id: "derived",
            channels: { fetch: async () => [], create: async (opts) => { created.push(opts); return { id: "nope", name: opts.name }; } },
          },
        };
      },
    },
  };
  const cfg = { ...config, discordGuildId: "" };
  const ch = await createNextSeasonChannel(client, cfg, 2028);
  assert.strictEqual(ch.failed, true);
  assert.strictEqual(ch.channel, null);
  assert.strictEqual(created.length, 0, "no create without DISCORD_GUILD_ID");
  assert.strictEqual(guildFetches, 0, "guild is not fetched when the id is missing");
  assert.strictEqual(channelFetches, 0, "no derivation from a stored channel");
  db.setSeasonDeathpoolChannel(running.id, null);
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

test("F06: resolveDeathpoolChannel prefers stored id, no env fallback anymore", () => {
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "stored-chan-42");
  assert.strictEqual(db.resolveDeathpoolChannel(config), "stored-chan-42");
  // Seit dem interaktiven Kanal-Setup gibt es KEINEN Env-Fallback mehr:
  // selbst wenn CHANNEL_DEATHPOOL gesetzt wäre, liefert resolve ohne
  // gespeicherte ID null (config.channelDeathpool zählt als leer).
  db.setSeasonDeathpoolChannel(running.id, null);
  assert.strictEqual(db.resolveDeathpoolChannel(config), null, "no env fallback even with env set");
});

// ---- F15: Kanal-Anlage härten ----

test("F15: existing same-name GuildText channel is reused, overwrites synced for a NEW player", async () => {
  db.getDb().exec("DELETE FROM players");
  db.upsertPlayer({ displayName: "Old", discordUserId: "1001" });
  const edited = [];
  const loopEdits = [];
  const existingChannel = {
    id: "exist-1",
    name: "deathpool-2027",
    type: 0, // GuildText
    permissionOverwrites: {
      cache: new Map([
        ["1001", { id: "1001", type: 1, allow: ["ViewChannel", "SendMessages"] }],
        ["role-keep", { id: "role-keep", type: 0, allow: ["ViewChannel"] }],
      ]),
      edit: async (userId, allow, opts) => {
        loopEdits.push({ userId, allow, opts });
      },
    },
    edit: async (payload) => {
      edited.push(payload);
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
  assert.strictEqual(loopEdits.length, 0, "no per-player permissionOverwrites.edit");
  assert.strictEqual(edited.length, 1, "one channel.edit");
  const ows = edited[0].permissionOverwrites;
  const newbie = ows.find((o) => o.id === "9999");
  const kept = ows.find((o) => o.id === "role-keep");
  assert.ok(newbie, "new player is in the edit payload");
  assert.deepStrictEqual(newbie.allow, ["ViewChannel", "SendMessages"]);
  assert.doesNotThrow(() => PermissionsBitField.resolve(newbie.allow));
  assert.ok(kept, "non-player overwrite is kept");
  assert.ok(ows.some((o) => o.id === "1001"));
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
  // Kein Env-Fallback mehr: der Rückfall-Versand läuft über CHANNEL_ALL_DEATHS.
  const cfg = { ...config, discordGuildId: "guild-1", channelAllDeaths: "alldeaths-1" };

  const res = await runYearRollover(client, cfg, { force: true });
  assert.strictEqual(res.switched, true, "switch still commits");
  // Bestätigung nennt den Fehlschlag
  const ack = sent.find((p) => p.content && p.content.includes("Saisonwechsel"));
  assert.ok(ack, "switch-ack posted");
  assert.ok(ack.content.includes("Kanal-Anlage fehlgeschlagen — es gibt keinen neuen Kanal."), "ack names the failed create");
  // Kein Kanal wurde gespeichert
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
});

// ---- F06: announce.js + Tagesbericht nutzen den gespeicherten Kanal ----

test("F06: announceDailySummary sends to the all-deaths channel, not the stored deathpool channel", async () => {
  const { announceDailySummary } = require("../src/discord/announce");
  const running = db.getActiveSeason();
  db.setSeasonLive(true);
  db.setSeasonDeathpoolChannel(running.id, "stored-summary-1");

  const configAll = { ...config, channelAllDeaths: "all-deaths-1", channelDeathpool: "env-deathpool-1" };

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
  await announceDailySummary(client, configAll);
  assert.ok(fetched.includes("all-deaths-1"), "daily summary targets the all-deaths channel");
  assert.ok(!fetched.includes("stored-summary-1"), "stored deathpool channel must NOT be used");
  assert.ok(!fetched.includes("env-deathpool-1"), "env deathpool must NOT be used");
  assert.strictEqual(sent.length, 1, "summary message posted");

  db.setSeasonDeathpoolChannel(running.id, null);
});

// ---- F20(b): Einmaliger Jahresbericht am Wiener 01.01. (no-announced) ----

/** Wartet, bis die (Test-)Log-Queue geleert ist (max ~3s). */
async function flushLogQueue(maxWait = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    // log.js-Interna: consumerRunning ist nach dem Drain wieder false.
    try {
      // kein direkter Zugriff — einfach abwarten und oben im Aufrufer prüfen
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
    break;
  }
}

test("F20: annual review on Vienna Jan 1 (no-announced) posts REAL live totals incl. bonus-only, once only", async () => {
  resetToRunningCurrentYear();
  db.getDb().exec(`
    DELETE FROM death_awards; DELETE FROM picks; DELETE FROM player_bonuses;
    DELETE FROM bonuses; DELETE FROM celebs; DELETE FROM players;
  `);
  const running = db.getActiveSeason();

  // Anna: base_points 120 + Bonus 30 = 150
  const anna = db.upsertPlayer({ displayName: "Anna", discordUserId: "2001" });
  db.setPoints(anna.id, 120);
  db.upsertBonus({ id: "b1", name: "Bonus1", description: "", points: 30 });
  db.awardBonus(anna.id, "b1");

  // Bruno: NUR Bonus (70) — keine base_points → 70 (Bonus-only-Spieler inklusive)
  const bruno = db.upsertPlayer({ displayName: "Bruno", discordUserId: "2002" });
  db.upsertBonus({ id: "b2", name: "Bonus2", description: "", points: 70 });
  db.awardBonus(bruno.id, "b2");

  // Cara: keine Punkte, 2 Treffer auf 2 verschiedenen Toten
  const cara = db.upsertPlayer({ displayName: "Cara", discordUserId: "2003" });

  // Xavier/Yoko: echte Tote im laufenden Jahr (is_alive=0 + died_at im
  // Season-Fenster) — so zählt seasonLiveReview.deaths sie (M3-Spezifikation:
  // deaths = echte gepickte Tote im Fenster, nicht Award-Rows).
  const x = db.findOrCreateCeleb({ name: "Xavier" }).celeb;
  const y = db.findOrCreateCeleb({ name: "Yoko" }).celeb;
  const inYear = `${running.year}-06-01`;
  db.getDb()
    .prepare("UPDATE celebs SET is_alive = 0, died_at = ? WHERE id = ?")
    .run(inYear, x.id);
  db.getDb()
    .prepare("UPDATE celebs SET is_alive = 0, died_at = ? WHERE id = ?")
    .run(inYear, y.id);
  // Xavier gepickt von Anna UND Cara; Yoko nur von Cara → 3 award rows, 2 echte Tode
  db.setPick(anna.id, x.id, running.id);
  db.setPick(cara.id, x.id, running.id);
  db.setPick(cara.id, y.id, running.id);
  const insAward = db
    .getDb()
    .prepare("INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (?, ?, ?, ?)");
  insAward.run(x.id, anna.id, 100, running.id);
  insAward.run(x.id, cara.id, 100, running.id);
  insAward.run(y.id, cara.id, 100, running.id);

  // Live-Auswertung direkt prüfen: echte Summen + distinct deaths (F20 c)
  const live = db.seasonLiveReview(running.id);
  const byName = Object.fromEntries(live.rows.map((r) => [r.name, r]));
  assert.strictEqual(byName["Anna"].total, 150, "base_points + Bonus");
  assert.strictEqual(byName["Bruno"].total, 70, "bonus-only player counted");
  assert.strictEqual(byName["Cara"].total, 0);
  assert.strictEqual(byName["Anna"].hits, 1);
  assert.strictEqual(byName["Cara"].hits, 2);
  assert.strictEqual(live.deaths, 2, "2 echte Tote im Fenster (M3), nicht 3 award rows");

  // runYearRollover am Wiener 01.01. (2025-12-31T23:00:00Z == 2026-01-01 Wien), keine announced-Saison
  const bucket = [];
  // Kein Env-Fallback mehr: der Deathpool-Zielkanal kommt aus der Saison.
  const runningSeason = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(runningSeason.id, "f20-stored-1");
  const client = { channels: { fetch: async () => makeFakeChannel(bucket) } };
  const frozen = new Date("2025-12-31T23:00:00Z");
  const res = await runYearRollover(client, config, { force: false, now: frozen });
  assert.strictEqual(res.switched, false);
  assert.strictEqual(res.reason, "no-announced");
  assert.strictEqual(bucket.length, 1, "exactly one annual review on Jan 1");
  const text = bucket[0].content;
  assert.ok(text.includes("Abschlussbilanz"), "review posted");
  assert.ok(text.includes("150 Punkte"), "Anna real total from base_points+bonus");
  assert.ok(text.includes("70 Punkte"), "Bruno bonus-only total");
  assert.ok(/💀 \*\*2\*\* Todesfälle/.test(text), "distinct deaths (2), not 3 award rows");
  assert.ok(!text.includes("ist live"), "no live sentence without switch (F03)");
  assert.strictEqual(db.getMeta("year_rollover_annual_review"), "2026", "flag set for this year");

  // Zweiter Lauf am selben Tag: KEIN zweiter Post (Meta-Flag, F20).
  const res2 = await runYearRollover(client, config, { force: false, now: frozen });
  assert.strictEqual(res2.reason, "already-done");
  assert.strictEqual(bucket.length, 1, "no duplicate annual review");
});

// ---- F25: fehlender Zielkanal wird geloggt, false, Restart postet nicht erneut ----

test("F25: postReview no-target logs error and returns false; review not repeated next run", async () => {
  resetToRunningCurrentYear();
  const running = db.getActiveSeason();
  db.setPoints(db.upsertPlayer({ displayName: "Sunny", discordUserId: "3001" }).id, 50);

  const logSent = [];
  // Für CHANNEL_LOG steht ein (Fake-)Kanal bereit; der Deathpool-Zielkanal fehlt.
  const client = {
    channels: {
      fetch: async (id) =>
        id === "logchan-1" ? makeFakeChannel(logSent) : null,
    },
  };
  const cfg = { ...config, channelLog: "logchan-1", channelDeathpool: "", channelAllDeaths: "" };
  const frozen = new Date("2025-12-31T23:00:00Z"); // Wiener 01.01.

  const res = await runYearRollover(client, cfg, { force: false, now: frozen });
  assert.strictEqual(res.switched, false);
  assert.strictEqual(res.reason, "no-announced");

  // logError-Queue leeren lassen und prüfen: no-target-Fehler ging in den Logkanal.
  await flushLogQueue();
  const joined = logSent.map((m) => JSON.stringify(m.embeds || m)).join("\n");
  assert.match(joined, /postReview no-target/, "no-target error logged with where (F25)");

  // Flag nur nach echtem Post. Ein Fehlschlag verbrennt das Jahr nicht.
  assert.notStrictEqual(db.getMeta("year_rollover_annual_review"), "2026");
  assert.ok(
    db.getMeta("year_rollover_annual_review") == null ||
      db.getMeta("year_rollover_annual_review") === "0" ||
      db.getMeta("year_rollover_annual_review") === "",
    "failed post must not consume the annual flag"
  );
});

// ---- F21: finalizeYearSwitch (gemeinsame Cron-/Handwechsel-Nacharbeit) ----

test("F21: finalizeYearSwitch creates channel, sets deathpool_channel_id, posts archived review with live sentence", async () => {
  resetToRunningCurrentYear();
  const running = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  const res = db.activateAnnouncedSeason(); // Snapshots der archivierten Saison entstehen hier

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
  const sent = [];
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => makeFakeChannel(sent) },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };

  const fin = await finalizeYearSwitch(client, cfg, res.archived.id, res.activated.year);
  assert.strictEqual(fin.posted, true, "archived review posted");
  assert.strictEqual(fin.newChannel.id, "newchan-9");
  assert.strictEqual(fin.newChannelFailed, false);
  assert.strictEqual(created.length, 1, "channel created");
  assert.strictEqual(created[0].name, `deathpool-${res.activated.year}`);

  const activated = db.getActiveSeason();
  assert.strictEqual(activated.deathpool_channel_id, "newchan-9", "id in deathpool_channel_id (F21)");
  assert.strictEqual(activated.announce_channel_id, "777", "announce_channel_id untouched");

  assert.ok(sent.length >= 1, "review posted");
  assert.ok(sent[0].content.includes("Abschlussbilanz"));
  assert.ok(sent[0].content.includes("ist live"), "live sentence on committed switch (F03)");
});

test("F15: edit throws → per-player failure is logged, existing channel is NOT discarded (F23 no ReferenceError)", async () => {
  db.getDb().exec("DELETE FROM players");
  db.upsertPlayer({ displayName: "Old", discordUserId: "1001" });
  db.upsertPlayer({ displayName: "Gone", discordUserId: "7777" }); // z. B. Server verlassen
  let editCalls = 0;
  const existingChannel = {
    id: "exist-1",
    name: "deathpool-2027",
    type: 0, // GuildText
    permissionOverwrites: {
      cache: new Map([
        ["1001", { id: "1001", type: 1, allow: ["ViewChannel", "SendMessages"] }],
      ]),
    },
    edit: async () => {
      editCalls++;
      throw new Error("Unknown User");
    },
  };
  const fakeGuild = {
    id: "guild-1",
    channels: {
      fetch: async () => [existingChannel],
      create: async (opts) => {
        throw new Error("create must NOT be called on existing channel");
      },
    },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };
  const client = { guilds: { fetch: async () => fakeGuild } };

  // F23: darf NICHT mit ReferenceError crashen (früher referenzierte der catch
  // `client`, der nicht im Scope war) und muss den Bestands-Kanal ZURÜCKgeben.
  const ch = await createNextSeasonChannel(client, cfg, 2027);
  assert.ok(ch, "existing channel still returned despite failing edit");
  assert.strictEqual(ch.id, "exist-1", "existing channel NOT discarded");
  assert.strictEqual(editCalls, 1, "one channel.edit attempted");
});

test("F23: guild-null sets newChannelFailed so ack says „Wechsel ohne neuen Kanal”", async () => {
  resetToRunningCurrentYear();
  const runningBefore = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: runningBefore.year + 1,
    startDate: `${runningBefore.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  const sent = [];
  // Keine Guild: guilds.fetch -> null, und der Kanal-Fetch hat keine guild-Prop
  // (derive fehlschlägt). Derselbe Fetch dient review + ack => sendbarer Kanal.
  const fakeChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return {};
    },
  };
  const client = {
    guilds: { fetch: async () => null },
    channels: { fetch: async () => fakeChannel },
  };
  // Kein Guild-ID, kein Deathpool gespeichert → Guild-Ableitung schlägt fehl.
  // Der switch-ack/Ersatz-Versand läuft über CHANNEL_ALL_DEATHS.
  const cfg = { ...config, discordGuildId: "", channelAllDeaths: "alldeaths-2" };

  const res = await runYearRollover(client, cfg, { force: true });
  assert.strictEqual(res.switched, true, "switch still commits");
  assert.strictEqual(res.channel, null, "no channel created");
  const ack = sent.find((p) => p.content && p.content.includes("Saisonwechsel"));
  assert.ok(ack, "switch-ack posted");
  assert.ok(ack.content.includes("Kanal-Anlage fehlgeschlagen — es gibt keinen neuen Kanal."), "ack names the missing channel");
});

test("channels.fetch throw does not call channels.create", async () => {
  let created = 0;
  let fetched = 0;
  const fakeGuild = {
    id: "guild-fetch-fail",
    available: true,
    channels: {
      fetch: async () => {
        fetched++;
        throw new Error("503 upstream");
      },
      create: async () => {
        created++;
        return { id: "should-not" };
      },
    },
  };
  const client = { guilds: { fetch: async () => fakeGuild } };
  const cfg = { ...config, discordGuildId: "guild-fetch-fail" };
  const ch = await createNextSeasonChannel(client, cfg, 2033);
  assert.strictEqual(fetched, 1);
  assert.strictEqual(created, 0);
  assert.strictEqual(ch.failed, true);
  assert.strictEqual(ch.channel, null);
});

test("guild.available === false does not create a channel", async () => {
  let created = 0;
  let fetched = 0;
  const fakeGuild = {
    id: "guild-down",
    available: false,
    channels: {
      fetch: async () => {
        fetched++;
        return [];
      },
      create: async () => {
        created++;
        return { id: "should-not" };
      },
    },
  };
  const client = { guilds: { fetch: async () => fakeGuild } };
  const cfg = { ...config, discordGuildId: "guild-down" };
  const ch = await createNextSeasonChannel(client, cfg, 2034);
  assert.strictEqual(fetched, 0);
  assert.strictEqual(created, 0);
  assert.strictEqual(ch.failed, true);
  assert.strictEqual(ch.channel, null);
});

test("reuse false does not link an existing deathpool channel", async () => {
  const existing = {
    id: "exist-9",
    name: "deathpool-2031",
    type: 0,
    edit: async () => {
      throw new Error("reuse false must not edit");
    },
  };
  let created = 0;
  const fakeGuild = {
    id: "guild-reuse",
    available: true,
    channels: {
      fetch: async () => [existing],
      create: async () => {
        created++;
        return { id: "dup" };
      },
    },
  };
  const client = { guilds: { fetch: async () => fakeGuild } };
  const cfg = { ...config, discordGuildId: "guild-reuse" };
  const res = await createNextSeasonChannel(client, cfg, 2031, { reuse: false });
  assert.strictEqual(created, 0);
  assert.strictEqual(res.channel, null);
  assert.strictEqual(res.alreadyExists, true);
  assert.strictEqual(res.existing.id, "exist-9");
});

test("withChannelNameLock runs same-name work one after another", async () => {
  const order = [];
  const first = withChannelNameLock("deathpool-lock", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
  });
  const second = withChannelNameLock("deathpool-lock", async () => {
    order.push("b");
  });
  await Promise.all([first, second]);
  assert.deepStrictEqual(order, ["a-start", "a-end", "b"]);
});

test("setup-state tryBeginDecide, abortDecide and retarget", () => {
  setupState.clearOpen("sea");
  setupState.clearOpen("seb");
  assert.strictEqual(setupState.tryBeginDecide("sea"), false);
  const ids = new Set(["c1"]);
  setupState.markOpen("sea", { components: [{ type: 1 }], offeredChannelIds: ids, year: 2027 });
  assert.strictEqual(setupState.isAnyOpen(), true);
  assert.strictEqual(setupState.getOpen("sea").offeredChannelIds, ids);
  assert.strictEqual(setupState.tryBeginDecide("sea"), true);
  assert.strictEqual(setupState.tryBeginDecide("sea"), false);
  setupState.abortDecide("sea");
  assert.strictEqual(setupState.getOpen("sea").deciding, false);
  setupState.retarget("sea", "seb");
  assert.strictEqual(setupState.getOpen("sea"), null);
  assert.strictEqual(setupState.getOpen("seb").year, 2027);
  setupState.clearOpen("seb");
  assert.strictEqual(setupState.isAnyOpen(), false);
});

test("overlapping runYearRollover posts one archived balance, not a zeroed live one", async () => {
  resetToRunningCurrentYear();
  db.getDb().exec(`
    DELETE FROM death_awards; DELETE FROM picks; DELETE FROM player_bonuses; DELETE FROM players;
  `);
  const running = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Overlap", discordUserId: "5555" });
  db.setPoints(player.id, 42);
  db.setSeasonDeathpoolChannel(running.id, "overlap-old");
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });

  const origActivate = db.activateAnnouncedSeason;
  let activates = 0;
  db.activateAnnouncedSeason = function () {
    activates++;
    return origActivate.apply(this, arguments);
  };

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  let sawReview = false;
  const bucket = [];
  const channel = {
    isTextBased: () => true,
    send: async (payload) => {
      bucket.push(payload);
      if (!sawReview && payload.content && payload.content.includes("Abschlussbilanz")) {
        sawReview = true;
        started();
        await gate;
      }
      return { id: "m" + bucket.length };
    },
  };
  const client = { channels: { fetch: async () => channel } };
  const now = new Date("2026-12-31T23:00:00Z");
  try {
    const first = runYearRollover(client, config, { force: false, now });
    await startedP;
    const second = runYearRollover(client, config, { force: false, now });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a.switched, true);
    assert.strictEqual(b.switched, false);
    assert.strictEqual(activates, 1, "exactly one activateAnnouncedSeason");
    const reviews = bucket.filter((m) => m.content && m.content.includes("Abschlussbilanz"));
    assert.strictEqual(reviews.length, 1, "exactly one balance post");
    assert.ok(reviews[0].content.includes("42 Punkte"), "archived snapshot, not the zeroed live season");
    assert.ok(!reviews[0].content.includes("0 Punkte"));
    assert.ok(reviews[0].content.includes("ist live"));
  } finally {
    release();
    db.activateAnnouncedSeason = origActivate;
    setupState.clearOpen(running.id);
  }
});

test("failed postReview keeps pending_season_review and the next run posts that seasonReview", async () => {
  resetToRunningCurrentYear();
  db.getDb().prepare("DELETE FROM meta WHERE key = ?").run("year_rollover_annual_review");
  db.getDb().exec(`
    DELETE FROM death_awards; DELETE FROM picks; DELETE FROM player_bonuses; DELETE FROM players;
  `);
  const running = db.getActiveSeason();
  const player = db.upsertPlayer({ displayName: "Keep", discordUserId: "6666" });
  db.setPoints(player.id, 42);
  db.setSeasonDeathpoolChannel(running.id, "old-1");
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });

  let fail = true;
  const bucket = [];
  const fetched = [];
  const channel = {
    isTextBased: () => true,
    send: async (payload) => {
      if (fail) throw new Error("send down");
      bucket.push(payload);
      return { id: "ok" };
    },
  };
  const client = {
    channels: {
      fetch: async (id) => {
        fetched.push(String(id));
        return channel;
      },
    },
  };
  const cfg = { ...config, discordGuildId: "", channelAllDeaths: "" };
  const res = await runYearRollover(client, cfg, { force: true, now: new Date("2026-11-14T10:00:00Z") });
  assert.strictEqual(res.switched, true);
  assert.ok(db.getMeta("year_rollover_annual_review") == null, "flag stays empty when the post fails");
  assert.strictEqual(db.getMeta("pending_season_review"), String(res.archived.id));
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null, "old id is not copied onto the new season");
  const archivedRow = db.getDb().prepare("SELECT deathpool_channel_id FROM seasons WHERE id = ?").get(res.archived.id);
  assert.strictEqual(archivedRow.deathpool_channel_id, "old-1");
  assert.ok(fetched.includes("old-1"));

  fail = false;
  const res2 = await runYearRollover(client, cfg, { force: false, now: new Date("2027-01-02T23:30:00Z") });
  assert.strictEqual(res2.switched, false);
  assert.strictEqual(res2.reason, "no-announced");
  assert.strictEqual(bucket.length, 1);
  assert.ok(bucket[0].content.includes("Abschlussbilanz"));
  assert.ok(bucket[0].content.includes(`Saison ${running.year}`));
  assert.ok(bucket[0].content.includes("42 Punkte"), "seasonReview of the archived id, not the zeroed live season");
  assert.ok(!bucket[0].content.includes("0 Punkte"));
  assert.ok(!bucket[0].content.includes("ist live"));
  assert.strictEqual(db.getMeta("pending_season_review"), null);
});

test("Jan 2 restart posts one live review; Jan 3 posts none", async () => {
  resetToRunningCurrentYear();
  db.getDb().prepare("DELETE FROM meta WHERE key = ?").run("year_rollover_annual_review");
  db.getDb().exec(`
    DELETE FROM death_awards; DELETE FROM picks; DELETE FROM player_bonuses; DELETE FROM players;
  `);
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "live-chan");
  const player = db.upsertPlayer({ displayName: "Jan", discordUserId: "8181" });
  db.setPoints(player.id, 15);
  const bucket = [];
  const client = { channels: { fetch: async () => makeFakeChannel(bucket) } };
  const jan2 = new Date("2027-01-01T23:30:00Z");
  const res = await runYearRollover(client, config, { now: jan2 });
  assert.strictEqual(res.switched, false);
  assert.strictEqual(res.reason, "no-announced");
  const reviews = bucket.filter((m) => m.content && m.content.includes("Abschlussbilanz"));
  assert.strictEqual(reviews.length, 1);
  assert.ok(reviews[0].content.includes("15 Punkte"));
  assert.ok(!reviews[0].content.includes("ist live"));
  assert.strictEqual(db.getMeta("year_rollover_annual_review"), "2027");

  const jan3 = new Date("2027-01-02T23:30:00Z");
  const res3 = await runYearRollover(client, config, { now: jan3 });
  assert.strictEqual(res3.reason, "already-done");
  assert.strictEqual(bucket.filter((m) => m.content && m.content.includes("Abschlussbilanz")).length, 1);
});

test("isAnyOpen blocks a cron rollover: no flag and no switch", async () => {
  resetToRunningCurrentYear();
  db.getDb().prepare("DELETE FROM meta WHERE key = ?").run("year_rollover_annual_review");
  const running = db.getActiveSeason();
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  setupState.markOpen(String(running.id), {
    components: [],
    offeredChannelIds: new Set(["c-old"]),
    year: running.year,
  });
  const bucket = [];
  const client = { channels: { fetch: async () => makeFakeChannel(bucket) } };
  try {
    const res = await runYearRollover(client, config, {
      force: false,
      now: new Date("2026-12-31T23:00:00Z"),
    });
    assert.strictEqual(res.switched, false);
    assert.strictEqual(res.reason, "setup-open");
    assert.strictEqual(db.getActiveSeason().id, running.id);
    assert.ok(db.getAnnouncedSeason(), "announced season still waiting");
    assert.strictEqual(bucket.length, 0);
    assert.ok(db.getMeta("year_rollover_annual_review") == null);
  } finally {
    setupState.clearOpen(running.id);
  }
});

test("force switches while setup is open and retargets the entry", async () => {
  resetToRunningCurrentYear();
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "force-old");
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: `${running.year + 1}-01-01`,
    channelId: "777",
    note: null,
  });
  const offered = new Set(["c-old"]);
  setupState.markOpen(String(running.id), { components: [{ type: 1 }], offeredChannelIds: offered, year: running.year });
  const client = { channels: { fetch: async () => makeFakeChannel([]) } };
  const cfg = { ...config, discordGuildId: "", channelAllDeaths: "alldeaths-force" };
  try {
    const res = await runYearRollover(client, cfg, { force: true, now: new Date("2026-12-31T23:00:00Z") });
    assert.strictEqual(res.switched, true);
    assert.strictEqual(setupState.getOpen(running.id), null);
    const moved = setupState.getOpen(res.activated.id);
    assert.ok(moved, "setup entry follows the new active season");
    assert.ok(moved.offeredChannelIds.has("c-old"));
    assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
  } finally {
    const active = db.getActiveSeason();
    if (active) setupState.clearOpen(active.id);
    setupState.clearOpen(running.id);
  }
});

test("sendAdmin falls back to exactly one DM when CHANNEL_ADMIN send throws", async () => {
  let fetches = 0;
  let channelSends = 0;
  let dmSends = 0;
  const client = {
    channels: {
      fetch: async (id) => {
        fetches++;
        assert.strictEqual(id, "admin-chan");
        return {
          id,
          isTextBased: () => true,
          send: async () => {
            channelSends++;
            throw new Error("Missing Access");
          },
        };
      },
    },
    users: {
      fetch: async () => ({
        id: "1",
        createDM: async () => ({
          send: async (payload) => {
            dmSends++;
            return { id: "dm1", content: payload.content };
          },
        }),
      }),
    },
  };
  const ctx = { client, config: { ...config, channelAdmin: "admin-chan", adminId: "1" } };
  const msg = await sendAdmin(ctx, "hello admin");
  assert.strictEqual(fetches, 1, "no second channel fetch after the send failure");
  assert.strictEqual(channelSends, 1);
  assert.strictEqual(dmSends, 1);
  assert.ok(msg);
  assert.strictEqual(msg.content, "hello admin");
});

test("resolveAdminTarget returns the DM user when CHANNEL_ADMIN fetch throws", async () => {
  const dm = { id: "dm-fallback", send: async () => ({ id: "m" }) };
  const ctx = {
    client: {
      channels: {
        fetch: async () => {
          throw new Error("500");
        },
      },
    },
    config: { ...config, channelAdmin: "admin-chan", adminId: "1" },
  };
  const target = await resolveAdminTarget(ctx, {
    preferDmUser: { createDM: async () => dm },
  });
  assert.strictEqual(target, dm);
});

test("draft reminder is a DM the day before start and does not switch seasons", async () => {
  resetToRunningCurrentYear();
  db.getDb().exec(`
    DELETE FROM pick_draft_entries; DELETE FROM pick_drafts; DELETE FROM players;
  `);
  const running = db.getActiveSeason();
  const yearBefore = running.year;
  db.openAnnouncedSeason({
    year: running.year + 1,
    startDate: "2027-01-01",
    channelId: "777",
    note: null,
  });
  const announced = db.getAnnouncedSeason();
  const openPlayer = db.upsertPlayer({ displayName: "Offen", discordUserId: "4242" });
  const donePlayer = db.upsertPlayer({ displayName: "Fertig", discordUserId: "4343" });
  db.getDb()
    .prepare("INSERT INTO pick_drafts (player_id, season_id, status) VALUES (?, ?, 'draft')")
    .run(openPlayer.id, announced.id);
  db.getDb()
    .prepare("INSERT INTO pick_drafts (player_id, season_id, status) VALUES (?, ?, 'finalized')")
    .run(donePlayer.id, announced.id);

  const dms = [];
  const client = {
    users: {
      fetch: async (id) => ({
        id,
        createDM: async () => ({
          send: async (payload) => {
            dms.push({ id, payload });
            return { id: "dm-" + id };
          },
        }),
      }),
    },
  };
  const now = new Date("2026-12-31T22:30:00Z");
  const res = await remindUnfinalizedDrafts(client, config, now);
  assert.strictEqual(res.reminded, 1);
  assert.strictEqual(dms.length, 1);
  assert.strictEqual(dms[0].id, "4242");
  assert.ok(dms[0].payload.content.includes("noch nicht `fertig` gesagt"));
  assert.ok(dms[0].payload.content.includes("2027-01-01"));
  assert.deepStrictEqual(dms[0].payload.allowedMentions, { parse: [] });
  assert.strictEqual(db.getMeta(`draft_remind_${announced.id}_4242`), "sent");
  assert.strictEqual(db.getMeta(`draft_remind_${announced.id}_4343`), null);
  assert.strictEqual(db.getActiveSeason().year, yearBefore, "draft reminder does not switch");

  const again = await remindUnfinalizedDrafts(client, config, now);
  assert.strictEqual(again.reminded, 0);
  assert.strictEqual(dms.length, 1);
});

test("formatSeasonReviewText empty season has no null and the new lines", () => {
  const text = formatSeasonReviewText({ season: { year: 2026 }, rows: [], deaths: 0 }, null);
  assert.ok(text.includes("Abschlussbilanz"));
  assert.ok(text.includes("Keine Punkte verbucht. Ein Jahr Leichen, kein Treffer. Peinlich, aber ehrlich."));
  assert.ok(text.includes("Promi beerdigt, Tipp gepunktet — oder eben nicht."));
  assert.ok(!text.includes("ist live"));
  assert.ok(!text.includes("null"));
  const live = formatSeasonReviewText({ season: { year: 2026 }, rows: [{ name: "A", total: 3, hits: 0 }], deaths: 1 }, 2027);
  assert.ok(live.includes("3 Punkte"));
  assert.ok(live.includes("Dieselben Feiglinge, frische Namen."));
});
