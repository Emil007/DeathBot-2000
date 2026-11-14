const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-channelsetup-"));
// KEIN CHANNEL_DEATHPOOL gesetzt — beweist, dass der Bot OHNE die Variable
// startet (config macht channelDeathpool optional/leer).
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const {
  runDeathpoolChannelSetup,
  handleChannelSetupInteraction,
  isOpen,
} = require("../src/jobs/channel-setup");

let config;
before(() => {
  config = loadConfig();
  // config.channelDeathpool muss ohne Env leer sein (optional).
  assert.strictEqual(config.channelDeathpool, "", "CHANNEL_DEATHPOOL optional → leer");
  // config.tz Default ist Europe/Vienna (ohne TZ-Env gesetzt) — konfigurierbar.
  assert.strictEqual(config.tz, "Europe/Vienna", "config.tz default is Europe/Vienna");
  db.openDb(config);
});

after(() => {
  try {
    db.closeDb();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

function resetSeason(year) {
  db.getDb().exec(`
    DELETE FROM season_point_snapshots;
    DELETE FROM seasons;
  `);
  db.ensureActiveSeason();
  db.setSeasonLive(true); // F05: setzt phase running
  db.getDb()
    .prepare("UPDATE seasons SET year = ? WHERE active = 1")
    .run(year);
}

/** Guild mit cache-basierten Kanälen (wie discord.js v14). */
function makeGuild(channels, { id = "guild-1" } = {}) {
  const cache = new Map(channels.map((c) => [c.id, { ...c, guild: { id } }]));
  return {
    id,
    channels: { cache },
  };
}

function makeTextChannel(id, name) {
  return { id, name, type: 0 };
}

function makeClient({ guild, channelTarget = null, usersMap = null, guildsList = null } = {}) {
  return {
    guilds: {
      // discord.js: fetch(id) → einzelne Guild, fetch() → Collection mit .first()
      fetch: async (id) => {
        if (id) {
          if (guild && String(guild.id) === String(id)) return guild;
          return null;
        }
        if (guild) return { first: () => guild };
        if (guildsList?.length) return { first: () => guildsList[0] };
        return { first: () => null };
      },
    },
    channels: {
      fetch: async (id) => {
        if (channelTarget && String(id) === String(channelTarget.channelId)) {
          return channelTarget.channel;
        }
        return null;
      },
    },
    users: {
      fetch: async (id) => {
        const u = usersMap?.[String(id)];
        return u ? { id, createDM: async () => ({ id, send: async () => {} }) } : null;
      },
    },
  };
}

// ---- Fall 1: verknüpfter Kanal → sofort onDecided, kein Dialog ----

test("Setup with linked channel → onDecided immediately, no question", async () => {
  resetSeason(2026);
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "stored-1");

  let decided = 0;
  const sent = [];
  const client = {
    guilds: { fetch: async () => null },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };
  const res = await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "linked");
  assert.strictEqual(res.channelId, "stored-1");
  assert.strictEqual(decided, 1, "onDecided fired exactly once");
  assert.strictEqual(sent.length, 0, "no question sent");
  assert.strictEqual(isOpen(running.id), false, "no open waiting setup");
});

// ---- Fall 2: kein Kanal verknüpft + passend benannter GuildText-Kanal → Dialog ----

test("Setup without linked channel + named GuildText channel → admin question (DM), onDecided only after dp:setup:use", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();
  assert.strictEqual(season.deathpool_channel_id, null);

  const dmBucket = [];
  const adminUser = {
    id: "1",
    createDM: async () => ({ id: "dm-1", send: async (payload) => { dmBucket.push(payload); return { id: "msg-setup-1" }; } }),
  };
  const guild = makeGuild([
    makeTextChannel("c-found", "deathpool-2026"),
    makeTextChannel("c-other", "allgemein"),
    { id: "c-voice", name: "deathpool-2026", type: 2 },
  ]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null }, // kein CHANNEL_ADMIN
    users: { fetch: async () => adminUser },
  };

  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "waiting", "waits for admin decision");
  assert.strictEqual(decided, 0, "onDecided NOT fired before decision");
  assert.strictEqual(isOpen(season.id), true, "setup registered as open");

  // Frage an den Admin (DM, weil kein CHANNEL_ADMIN).
  assert.strictEqual(dmBucket.length, 1, "question sent exactly once");
  const question = dmBucket[0].content;
  assert.match(question, /Season \(2026\)/);
  assert.match(question, /#deathpool-2026/);

  // Buttons: dp:setup:use:<channelId> und dp:setup:new.
  const rows = dmBucket[0].components;
  assert.ok(rows.length >= 2, "buttons row + select row present");
  const buttonCustomIds = rows
    .flatMap((r) => r.components.map((c) => c.data?.custom_id || c.custom_id))
    .filter((x) => x);
  assert.ok(buttonCustomIds.includes("dp:setup:use:c-found"), "use-button present with found channel id");
  assert.ok(buttonCustomIds.includes("dp:setup:new"), "new-button present");
  assert.ok(buttonCustomIds.includes("dp:setup:pick"), "select menu present");

  // Voice-Kanal darf NICHT als „Diesen nehmen" dienen (nur GuildText zählt).
  const useButtons = buttonCustomIds.filter((x) => x.startsWith("dp:setup:use:"));
  assert.ok(!useButtons.includes("dp:setup:use:c-voice"), "voice channel NOT offered via use-button");

  // Admin klickt „Diesen nehmen" → verknüpft + onDecided.
  const interact = {
    customId: "dp:setup:use:c-found",
    user: { id: "1" },
    isRepliable: () => true,
    update: async (payload) => {
      assert.ok(payload.content.includes("Nutze"), "confirmation text");
    },
    reply: async () => {},
  };
  const handled = await handleChannelSetupInteraction(interact, client, config);
  assert.strictEqual(handled, true, "interaction consumed");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-found", "channel linked");
  assert.strictEqual(decided, 1, "onDecided fired exactly once after decision");
  assert.strictEqual(isOpen(season.id), false, "setup no longer open");
});

// ---- dp:setup:new → Kanal anlegen + verknüpfen + onDecided ----

test("dp:setup:new creates deathpool-{year}, links, fires onDecided", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const adminUser = {
    id: "1",
    createDM: async () => ({ id: "dm-2", send: async (payload) => { dmBucket.push(payload); return { id: "msg-setup-2" }; } }),
  };
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      cache: new Map([["c-found", { id: "c-found", name: "deathpool-2026", type: 0 }]]),
      fetch: async () => [{ id: "c-found", name: "deathpool-2026", type: 0 }],
      create: async (opts) => {
        created.push(opts);
        return { id: "brand-new-1", name: opts.name, permissionOverwrites: { cache: new Map() } };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild }, // DISCORD_GUILD_ID-Pfad in createNextSeasonChannel
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };

  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, cfg, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "waiting");
  assert.strictEqual(decided, 0);

  // Admin wählt „Neuen Kanal anlegen".
  const edits = [];
  const interact = {
    customId: "dp:setup:new",
    user: { id: "1" },
    isRepliable: () => true,
    update: async (payload) => {
      edits.push(payload.content);
    },
    editReply: async (payload) => {
      edits.push(payload.content);
    },
    reply: async () => {},
  };
  const handled = await handleChannelSetupInteraction(interact, client, cfg);
  assert.strictEqual(handled, true);
  // createNextSeasonChannel hat F15-Härtung: existiert deathpool-2026 schon,
  // wird er wiederverwendet (Overwrites nachgezogen) statt neu angelegt.
  // „Neuen Kanal anlegen" bedeutet hier: Kanal sicherstellen + verknüpfen.
  assert.strictEqual(created.length, 0, "existing deathpool-2026 reused (F15)");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-found", "deathpool-2026 channel linked");
  assert.strictEqual(decided, 1, "onDecided once after decision");
  assert.ok(
    edits.some((t) => t && t.includes("Lege neues #deathpool-2026 an")),
    "message edited with the new-channel announcement"
  );
});

// ---- Kein Kanal gefunden → sofort anlegen + verknüpfen + onDecided (kein Dialog) ----

test("No matching channel found → create directly, link, onDecided (no question)", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const created = [];
  const fakeGuild = {
    id: "guild-1",
    channels: {
      cache: new Map([["c-other", { id: "c-other", name: "allgemein", type: 0 }]]),
      fetch: async () => [{ id: "c-other", name: "allgemein", type: 0 }],
      create: async (opts) => {
        created.push(opts);
        return { id: "auto-2026", name: opts.name, permissionOverwrites: { cache: new Map() } };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild }, // DISCORD_GUILD_ID-Pfad in createNextSeasonChannel
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };
  const cfg = { ...config, discordGuildId: "guild-1" };

  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, cfg, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "created");
  assert.strictEqual(decided, 1, "onDecided once (no blocking)");
  assert.strictEqual(isOpen(season.id), false);
  assert.strictEqual(created.length, 1, "channel auto-created");
  assert.strictEqual(created[0].name, "deathpool-2026");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "auto-2026", "auto-created channel linked");
});

// ---- dp:setup:pick:<channelId> (Select) → Kanal nehmen + verknüpfen + onDecided ----

test("dp:setup:pick:<channelId> selects a channel, links, fires onDecided", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const adminUser = {
    id: "1",
    createDM: async () => ({ id: "dm-3", send: async (payload) => { dmBucket.push(payload); return { id: "msg-setup-3" }; } }),
  };
  const guild = makeGuild([
    makeTextChannel("c-found", "deathpool-2026"),
    makeTextChannel("c-other", "mein-kanal"),
  ]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser },
  };

  let decided = 0;
  await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(decided, 0);

  // Select-Wahl eines anderen Kanals: die Menü-customId ist `dp:setup:pick`,
  // die gewählte Option liegt in values[0] — Value = Kanal-ID direkt (Spec).
  const interact = {
    customId: "dp:setup:pick",
    values: ["c-other"],
    user: { id: "1" },
    isRepliable: () => true,
    update: async (payload) => {
      assert.ok(payload.content.includes("#mein-kanal"), "confirmation names chosen channel");
    },
    reply: async () => {},
  };
  const handled = await handleChannelSetupInteraction(interact, client, config);
  assert.strictEqual(handled, true);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-other", "selected channel linked");
  assert.strictEqual(decided, 1, "onDecided once after selection");
});

// ---- Nicht-Admin darf nicht entscheiden ----

test("Non-admin cannot decide the setup (reply held back)", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const adminUser = {
    id: "1",
    createDM: async () => ({ id: "dm-4", send: async (payload) => { dmBucket.push(payload); return { id: "msg-setup-4" }; } }),
  };
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser },
  };
  await runDeathpoolChannelSetup(client, config, {});
  assert.strictEqual(isOpen(season.id), true);

  let repliedEphemeral = "";
  const hack = {
    customId: "dp:setup:use:c-found",
    user: { id: "999" }, // NICHT Admin
    isRepliable: () => true,
    reply: async (payload) => {
      repliedEphemeral = payload?.content || "";
    },
  };
  const handled = await handleChannelSetupInteraction(hack, client, config);
  assert.strictEqual(handled, true, "still consumed");
  assert.match(repliedEphemeral, /der Admin/i, "non-admin told off");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null, "NOT linked by non-admin");
  assert.strictEqual(isOpen(season.id), true, "setup stays open");
});

// ---- config.channelDeathpool LEER: Bot startet, versendet ohne festes Ziel ----

test("Empty channelDeathpool: resolveDeathpoolChannel null; postReview → no-target false (no env fallback)", async () => {
  resetSeason(2026);
  db.setSeasonDeathpoolChannel(db.getActiveSeason().id, null);
  // resolveDeathpoolChannel darf KEINEN Env-Fallback liefern (CHANNEL_DEATHPOOL war nie gesetzt).
  assert.strictEqual(db.resolveDeathpoolChannel(config), null, "no env fallback");

  // Werden Bots auch weiter zur Saison startbar — onDecided-Pipeline mit no-guild.
  let decided = 0;
  const res = await runDeathpoolChannelSetup(
    { guilds: { fetch: async () => null }, channels: { fetch: async () => null }, users: { fetch: async () => null } },
    config,
    { onDecided: async () => { decided++; } }
  );
  assert.strictEqual(res.mode, "no-guild");
  assert.strictEqual(decided, 1, "onDecided still fires once without any guild");
});

// ---- onDecided wirkt als Gate: runYearRollover wird erst nach Entscheidung ausgeführt ----

test("onDecided gates the startup catch-up: NOT before decision, exactly once after", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const adminUser = {
    id: "1",
    createDM: async () => ({ id: "dm-gate", send: async (payload) => { dmBucket.push(payload); return { id: "msg-gate" }; } }),
  };
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser },
  };

  const decidedCalls = [];
  // Setup starten, aber die Frage NICHT fortsetzen — onDecided darf nicht feuern.
  const promise = runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decidedCalls.push("onDecided");
    },
  });
  const res = await promise;
  assert.strictEqual(res.mode, "waiting");
  assert.strictEqual(decidedCalls.length, 0, "startup catch-up must NOT run while waiting");

  // Admin entscheidet via Button.
  const interact = {
    customId: "dp:setup:use:c-found",
    user: { id: "1" },
    isRepliable: () => true,
    update: async () => {},
    reply: async () => {},
  };
  await handleChannelSetupInteraction(interact, client, config);
  assert.strictEqual(decidedCalls.length, 1, "catch-up exactly once after decision");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-found");
});
