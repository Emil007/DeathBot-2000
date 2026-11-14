const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-channelsetup-"));
// KEIN CHANNEL_DEATHPOOL gesetzt — beweist, dass der Bot OHNE die Variable
// startet (config macht channelDeathpool optional/leer).
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const {
  runDeathpoolChannelSetup,
  handleChannelSetupInteraction,
  isOpen,
  _resetForTest,
} = require("../src/jobs/channel-setup");

let config;
before(() => {
  config = loadConfig();
  // config.channelDeathpool muss ohne Env leer sein (optional).
  assert.strictEqual(config.channelDeathpool, "", "CHANNEL_DEATHPOOL optional → leer");
  // config.tz Default ist Europe/Vienna (ohne TZ-Env gesetzt) — konfigurierbar.
  assert.strictEqual(config.tz, "Europe/Vienna", "config.tz default is Europe/Vienna");
  assert.strictEqual(config.discordGuildId, "guild-1");
  db.openDb(config);
});

beforeEach(() => {
  _resetForTest();
});

after(() => {
  try {
    _resetForTest();
  } catch {
    /* db schon zu */
  }
  try {
    db.closeDb();
  } catch {
    /* */
  }
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
function makeGuild(channels, { id = "guild-1", available = true } = {}) {
  const cache = new Map(
    channels.map((c) => [String(c.id), { ...c, guild: { id }, guildId: c.guildId || id }])
  );
  return {
    id,
    available,
    channels: {
      cache,
      fetch: async (channelId) => {
        if (channelId != null) {
          const hit = cache.get(String(channelId));
          if (!hit) {
            const err = new Error("Unknown Channel");
            err.code = 10003;
            throw err;
          }
          return hit;
        }
        return [...cache.values()];
      },
    },
  };
}

function makeTextChannel(id, name) {
  return { id, name, type: 0, guildId: "guild-1" };
}

function componentIds(rows) {
  return rows
    .flatMap((r) => r.components.map((c) => c.data?.custom_id || c.custom_id))
    .filter((x) => x);
}

function componentLabels(rows) {
  return rows
    .flatMap((r) => r.components.map((c) => c.data?.label || c.label))
    .filter((x) => x);
}

function adminUser(dmBucket, id = "dm-1") {
  return {
    id: "1",
    createDM: async () => ({
      id,
      send: async (payload) => {
        dmBucket.push(payload);
        return { id: `msg-${id}` };
      },
    }),
  };
}

// ---- Fall 1: verknüpfter Kanal → sofort onDecided, kein Dialog ----

test("Setup with linked channel → onDecided immediately, no question", async () => {
  resetSeason(2026);
  const running = db.getActiveSeason();
  db.setSeasonDeathpoolChannel(running.id, "stored-1");

  let decided = 0;
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
  assert.strictEqual(isOpen(running.id), false, "no open waiting setup");
  assert.strictEqual(db.getMeta("channel_setup_open"), null);
});

// ---- Fall 2: kein Kanal verknüpft + passend benannter GuildText-Kanal → Dialog ----

test("Setup without linked channel + named GuildText channel → admin question (DM), onDecided only after dp:setup:use", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();
  assert.strictEqual(season.deathpool_channel_id, null);

  const dmBucket = [];
  const guild = makeGuild([
    makeTextChannel("c-found", "deathpool-2026"),
    makeTextChannel("c-other", "allgemein"),
    { id: "c-voice", name: "deathpool-2026", type: 2, guildId: "guild-1" },
  ]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null }, // kein CHANNEL_ADMIN
    users: { fetch: async () => adminUser(dmBucket) },
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
  assert.strictEqual(db.getMeta("channel_setup_open"), String(season.id));

  assert.strictEqual(dmBucket.length, 1, "question sent exactly once");
  const question = dmBucket[0].content;
  assert.match(question, /Season \(2026\)/);
  assert.match(question, /#deathpool-2026/);
  assert.match(question, /Drei Wege/);
  assert.match(question, /Ohne einen Klick bleibt der Deathpool-Nachhol liegen/);
  assert.deepStrictEqual(dmBucket[0].allowedMentions, { parse: [] });

  const rows = dmBucket[0].components;
  assert.ok(rows.length >= 2, "buttons row + select row present");
  const buttonCustomIds = componentIds(rows);
  assert.ok(buttonCustomIds.includes("dp:setup:use:c-found"), "use-button present with found channel id");
  assert.ok(buttonCustomIds.includes("dp:setup:new"), "new-button present");
  assert.ok(buttonCustomIds.includes("dp:setup:pick"), "select menu present");
  assert.ok(componentLabels(rows).includes("#deathpool-2026 nehmen"));

  const useButtons = buttonCustomIds.filter((x) => x.startsWith("dp:setup:use:"));
  assert.ok(!useButtons.includes("dp:setup:use:c-voice"), "voice channel NOT offered via use-button");

  const interact = {
    customId: "dp:setup:use:c-found",
    user: { id: "1" },
    isRepliable: () => true,
    update: async (payload) => {
      assert.match(payload.content, /Deathpool-Kanal ist \*\*#deathpool-2026\*\*/);
      assert.match(payload.content, /Verknüpft: #deathpool-2026\. Damit ist die Frage zu\./);
      assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
    },
    reply: async () => {
      throw new Error("use must edit the original message");
    },
  };
  const handled = await handleChannelSetupInteraction(interact, client, config);
  assert.strictEqual(handled, true, "interaction consumed");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-found", "channel linked");
  assert.strictEqual(decided, 1, "onDecided fired exactly once after decision");
  assert.strictEqual(isOpen(season.id), false, "setup no longer open");
  assert.strictEqual(db.getMeta("channel_setup_open"), null);
});

// ---- dp:setup:new legt nur an, wenn der Name noch frei ist ----

test("dp:setup:new creates deathpool-{year} when the name is free, links, fires onDecided", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  let phase = "dialog";
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
    channels: {
      cache: new Map(),
      fetch: async () => {
        if (phase === "dialog") {
          return [{ id: "c-found", name: "deathpool-2026", type: 0, guildId: "guild-1" }];
        }
        return created.map((c) => ({ id: c.id, name: c.name, type: 0, guildId: "guild-1" }));
      },
      create: async (opts) => {
        const ch = { id: "brand-new-1", name: opts.name, permissionOverwrites: { cache: new Map() } };
        created.push(ch);
        return ch;
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-2") },
  };

  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "waiting");
  assert.strictEqual(decided, 0);
  phase = "create";

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
  const handled = await handleChannelSetupInteraction(interact, client, config);
  assert.strictEqual(handled, true);
  assert.strictEqual(created.length, 1, "one channel created");
  assert.strictEqual(created[0].name, "deathpool-2026");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "brand-new-1");
  assert.strictEqual(decided, 1, "onDecided once after decision");
  assert.strictEqual(isOpen(season.id), false);
  assert.ok(
    edits.some((t) => t && t.includes("Lege #deathpool-2026 an. Spieler bekommen Sicht und Schreiben…")),
    "create announcement"
  );
  assert.ok(edits.some((t) => t && t.includes("Verknüpft: #deathpool-2026")));
});

// ---- Kein Kanal gefunden → sofort anlegen + verknüpfen + onDecided (kein Dialog) ----

test("No matching channel found → create directly, link, onDecided (no question)", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
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
    guilds: { fetch: async () => fakeGuild },
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

// ---- Dropdown bestätigt erst beim zweiten Klick ----

test("dp:setup:pick confirms on the second choice, then links and fires onDecided", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const guild = makeGuild([
    makeTextChannel("c-found", "deathpool-2026"),
    makeTextChannel("c-other", "mein-kanal"),
  ]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-3") },
  };

  let decided = 0;
  await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(decided, 0);

  const firstReplies = [];
  const first = {
    customId: "dp:setup:pick",
    values: ["c-other"],
    user: { id: "1" },
    isRepliable: () => true,
    update: async () => {
      throw new Error("first pick must not edit the original message");
    },
    reply: async (payload) => {
      firstReplies.push(payload);
    },
  };
  assert.strictEqual(await handleChannelSetupInteraction(first, client, config), true);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null, "not linked on first click");
  assert.strictEqual(decided, 0);
  assert.strictEqual(isOpen(season.id), true);
  assert.strictEqual(firstReplies.length, 1);
  assert.strictEqual(firstReplies[0].ephemeral, true);
  assert.match(firstReplies[0].content, /Wirklich #mein-kanal als Deathpool\? Dann noch einmal wählen\./);

  const second = {
    customId: "dp:setup:pick",
    values: ["c-other"],
    user: { id: "1" },
    isRepliable: () => true,
    update: async (payload) => {
      assert.match(payload.content, /#mein-kanal/);
      assert.match(payload.content, /Verknüpft: #mein-kanal/);
    },
    reply: async () => {
      throw new Error("confirming pick updates the original message");
    },
  };
  assert.strictEqual(await handleChannelSetupInteraction(second, client, config), true);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-other", "selected channel linked");
  assert.strictEqual(decided, 1, "onDecided once after selection");
  assert.strictEqual(isOpen(season.id), false);
});

test("a different dropdown id restarts the confirmation", async () => {
  resetSeason(2026);
  const dmBucket = [];
  const guild = makeGuild([
    makeTextChannel("c-found", "deathpool-2026"),
    makeTextChannel("c-a", "alpha"),
    makeTextChannel("c-b", "beta"),
  ]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-re") },
  };
  await runDeathpoolChannelSetup(client, config, {});

  const replies = [];
  const click = (id) => ({
    customId: "dp:setup:pick",
    values: [id],
    user: { id: "1" },
    reply: async (payload) => {
      replies.push(payload.content);
    },
    update: async () => {
      throw new Error("no link yet");
    },
  });
  await handleChannelSetupInteraction(click("c-a"), client, config);
  await handleChannelSetupInteraction(click("c-b"), client, config);
  assert.match(replies[0], /#alpha/);
  assert.match(replies[1], /#beta/);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
});

// ---- Nicht-Admin darf nicht entscheiden ----

test("Non-admin cannot decide the setup (reply held back)", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-4") },
  };
  await runDeathpoolChannelSetup(client, config, {});
  assert.strictEqual(isOpen(season.id), true);

  let repliedEphemeral = "";
  let updated = false;
  const hack = {
    customId: "dp:setup:use:c-found",
    user: { id: "999" },
    isRepliable: () => true,
    reply: async (payload) => {
      repliedEphemeral = payload?.content || "";
    },
    update: async () => {
      updated = true;
    },
  };
  const handled = await handleChannelSetupInteraction(hack, client, config);
  assert.strictEqual(handled, true, "still consumed");
  assert.match(repliedEphemeral, /Nur der Admin darf das\./);
  assert.strictEqual(updated, false, "original message stays");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null, "NOT linked by non-admin");
  assert.strictEqual(isOpen(season.id), true, "setup stays open");
});

test("admin role may decide when the user id is not ADMIN_ID", async () => {
  resetSeason(2026);
  const dmBucket = [];
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-role") },
  };
  const cfg = { ...config, adminRoleId: "role-9" };
  await runDeathpoolChannelSetup(client, cfg, {});
  const interact = {
    customId: "dp:setup:use:c-found",
    user: { id: "999" },
    member: { roles: { cache: new Map([["role-9", { id: "role-9" }]]) } },
    update: async () => {},
    reply: async () => {
      throw new Error("role admin should decide, not get the denial");
    },
  };
  await handleChannelSetupInteraction(interact, client, cfg);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "c-found");
});

test("missing user.id does not call setSeasonDeathpoolChannel", async () => {
  resetSeason(2026);
  const dmBucket = [];
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-noid") },
  };
  await runDeathpoolChannelSetup(client, config, {});

  const orig = db.setSeasonDeathpoolChannel;
  let calls = 0;
  db.setSeasonDeathpoolChannel = (...args) => {
    calls += 1;
    return orig(...args);
  };
  try {
    let updated = false;
    await handleChannelSetupInteraction(
      {
        customId: "dp:setup:use:c-found",
        user: {},
        reply: async () => {},
        update: async () => {
          updated = true;
        },
      },
      client,
      config
    );
    assert.strictEqual(calls, 0);
    assert.strictEqual(updated, false);
    assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
    assert.strictEqual(isOpen(db.getActiveSeason().id), true);
  } finally {
    db.setSeasonDeathpoolChannel = orig;
  }
});

// ---- config.channelDeathpool LEER: Bot startet, versendet ohne festes Ziel ----

test("Empty channelDeathpool: resolveDeathpoolChannel null; postReview → no-target false (no env fallback)", async () => {
  resetSeason(2026);
  db.setSeasonDeathpoolChannel(db.getActiveSeason().id, null);
  assert.strictEqual(db.resolveDeathpoolChannel(config), null, "no env fallback");

  let decided = 0;
  const res = await runDeathpoolChannelSetup(
    { guilds: { fetch: async () => null }, channels: { fetch: async () => null }, users: { fetch: async () => null } },
    config,
    {
      onDecided: async () => {
        decided++;
      },
    }
  );
  assert.strictEqual(res.mode, "no-guild");
  assert.strictEqual(decided, 1, "onDecided still fires once without any guild");
});

// ---- onDecided wirkt als Gate: runYearRollover wird erst nach Entscheidung ausgeführt ----

test("onDecided gates the startup catch-up: NOT before decision, exactly once after", async () => {
  resetSeason(2026);
  const season = db.getActiveSeason();

  const dmBucket = [];
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-gate") },
  };

  const decidedCalls = [];
  const res = await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decidedCalls.push("onDecided");
    },
  });
  assert.strictEqual(res.mode, "waiting");
  assert.strictEqual(decidedCalls.length, 0, "startup catch-up must NOT run while waiting");

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
  assert.strictEqual(isOpen(season.id), false);
});

test("env text channel backfill writes the id, runs onDecided, does not create", async () => {
  resetSeason(2026);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
  const created = [];
  const guild = {
    id: "guild-1",
    available: true,
    channels: {
      fetch: async () => [{ id: "other", name: "allgemein", type: 0, guildId: "guild-1" }],
      create: async (opts) => {
        created.push(opts);
        return { id: "should-not", name: opts.name };
      },
    },
  };
  const envChannel = {
    id: "env-dp",
    name: "deathpool-alt",
    type: 0,
    guildId: "guild-1",
    guild: { id: "guild-1" },
  };
  const client = {
    guilds: { fetch: async () => guild },
    channels: {
      fetch: async (id) => (String(id) === "env-dp" ? envChannel : null),
    },
    users: { fetch: async () => null },
  };
  const cfg = { ...config, channelDeathpool: "env-dp", discordGuildId: "guild-1" };
  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, cfg, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "linked");
  assert.strictEqual(res.channelId, "env-dp");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "env-dp");
  assert.strictEqual(decided, 1);
  assert.strictEqual(created.length, 0);
});

test("channels.fetch throw while creating restores components and does not decide", async () => {
  resetSeason(2026);
  const dmBucket = [];
  let fetches = 0;
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
    channels: {
      fetch: async () => {
        fetches += 1;
        if (fetches === 1) {
          return [{ id: "c-found", name: "deathpool-2026", type: 0, guildId: "guild-1" }];
        }
        const err = new Error("Service Unavailable");
        err.status = 503;
        throw err;
      },
      create: async (opts) => {
        created.push(opts);
        return { id: "nope", name: opts.name };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-throw") },
  };
  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "waiting");

  let restored = null;
  let failure = "";
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:new",
      user: { id: "1" },
      update: async () => {},
      editReply: async (payload) => {
        restored = payload.components;
        failure = payload.content;
      },
      reply: async () => {},
    },
    client,
    config
  );
  assert.strictEqual(created.length, 0);
  assert.strictEqual(decided, 0);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
  assert.ok(Array.isArray(restored) && restored.length >= 1, "components restored");
  assert.match(failure, /Kanal-Anlage für deathpool-2026 fehlgeschlagen \(Details in den Logs\)\./);
  assert.strictEqual(isOpen(db.getActiveSeason().id), true);
});

test("missing permission 50013 keeps the buttons and states the rights error", async () => {
  resetSeason(2026);
  const dmBucket = [];
  let phase = "dialog";
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
    channels: {
      fetch: async () => {
        if (phase === "dialog") {
          return [{ id: "c-found", name: "deathpool-2026", type: 0, guildId: "guild-1" }];
        }
        return [];
      },
      create: async () => {
        created.push("create");
        const err = new Error("Missing Permissions");
        err.code = 50013;
        throw err;
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-50013") },
  };
  let decided = 0;
  await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  phase = "create";
  let failure = "";
  let restored = null;
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:new",
      user: { id: "1" },
      update: async () => {},
      editReply: async (payload) => {
        failure = payload.content;
        restored = payload.components;
      },
      reply: async () => {},
    },
    client,
    config
  );
  assert.match(failure, /Mir fehlt das Recht, Kanäle anzulegen\./);
  assert.ok(restored && restored.length >= 1);
  assert.strictEqual(decided, 0);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
  assert.strictEqual(isOpen(db.getActiveSeason().id), true);
});

test("id outside offeredChannelIds is not linked and the blind pick path does not write", async () => {
  resetSeason(2026);
  const dmBucket = [];
  const guild = makeGuild([
    makeTextChannel("c-found", "deathpool-2026"),
    makeTextChannel("c-other", "allgemein"),
  ]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-offer") },
  };
  await runDeathpoolChannelSetup(client, config, {});
  const orig = db.setSeasonDeathpoolChannel;
  let calls = 0;
  db.setSeasonDeathpoolChannel = (...args) => {
    calls += 1;
    return orig(...args);
  };
  try {
    let updated = false;
    const deny = async (customId, extra = {}) => {
      await handleChannelSetupInteraction(
        {
          customId,
          user: { id: "1" },
          update: async () => {
            updated = true;
          },
          reply: async () => {},
          ...extra,
        },
        client,
        config
      );
    };
    await deny("dp:setup:use:not-offered");
    await deny("dp:setup:pick:c-found");
    await deny("dp:setup:pick", { values: ["not-offered"] });
    assert.strictEqual(calls, 0);
    assert.strictEqual(updated, false);
    assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
    assert.strictEqual(isOpen(db.getActiveSeason().id), true);
  } finally {
    db.setSeasonDeathpoolChannel = orig;
  }
});

test("reuse false with an existing name does not create or silently link", async () => {
  resetSeason(2026);
  const dmBucket = [];
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
    channels: {
      fetch: async () => [
        {
          id: "c-found",
          name: "deathpool-2026",
          type: 0,
          guildId: "guild-1",
          permissionOverwrites: { cache: new Map() },
        },
      ],
      create: async (opts) => {
        created.push(opts);
        return { id: "second", name: opts.name, permissionOverwrites: { cache: new Map() } };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-reuse") },
  };
  let decided = 0;
  await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  let text = "";
  let components = null;
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:new",
      user: { id: "1" },
      update: async () => {},
      editReply: async (payload) => {
        text = payload.content;
        components = payload.components;
      },
      reply: async () => {},
    },
    client,
    config
  );
  assert.strictEqual(created.length, 0, "no second channel");
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null, "existing channel not linked");
  assert.strictEqual(decided, 0);
  assert.ok(components && components.length >= 1, "buttons stay");
  assert.match(
    text,
    /#deathpool-2026 gibt es schon\. Den nehmen, oder einen anderen aus der Liste\. Einen zweiten mit demselben Namen lege ich nicht an\./
  );
  assert.strictEqual(isOpen(db.getActiveSeason().id), true);
});

test("two parallel Neu clicks create one channel", async () => {
  resetSeason(2026);
  const dmBucket = [];
  let phase = "dialog";
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
    channels: {
      fetch: async () => {
        if (phase === "dialog") {
          return [{ id: "c-found", name: "deathpool-2026", type: 0, guildId: "guild-1" }];
        }
        return created.map((c) => ({ id: c.id, name: c.name, type: 0, guildId: "guild-1" }));
      },
      create: async (opts) => {
        await new Promise((r) => setTimeout(r, 30));
        const ch = {
          id: `new-${created.length + 1}`,
          name: opts.name,
          permissionOverwrites: { cache: new Map() },
        };
        created.push(ch);
        return ch;
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-par") },
  };
  let decided = 0;
  await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  phase = "create";
  const mk = () => ({
    customId: "dp:setup:new",
    user: { id: "1" },
    update: async () => {},
    editReply: async () => {},
    reply: async () => {},
  });
  await Promise.all([
    handleChannelSetupInteraction(mk(), client, config),
    handleChannelSetupInteraction(mk(), client, config),
  ]);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(decided, 1);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "new-1");
});

test("worst case: channels.fetch throws and channels.create stays at 0", async () => {
  resetSeason(2026);
  const created = [];
  const fakeGuild = {
    id: "guild-1",
    available: true,
    channels: {
      fetch: async () => {
        const err = new Error("Service Unavailable");
        err.status = 503;
        throw err;
      },
      create: async (opts) => {
        created.push(opts);
        return { id: "should-not-exist", name: opts.name };
      },
    },
  };
  const client = {
    guilds: { fetch: async () => fakeGuild },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };
  let decided = 0;
  const res = await runDeathpoolChannelSetup(client, config, {
    onDecided: async () => {
      decided++;
    },
  });
  assert.strictEqual(res.mode, "unavailable");
  assert.strictEqual(created.length, 0);
  assert.strictEqual(decided, 0);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
});

test("unavailable guild does not create, does not decide, and hooks guildAvailable once", async () => {
  resetSeason(2026);
  const created = [];
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")], { available: false });
  guild.channels.create = async (opts) => {
    created.push(opts);
    return { id: "x", name: opts.name };
  };
  let hooks = 0;
  const client = {
    once: (name) => {
      if (name === "guildAvailable") hooks += 1;
    },
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };
  let decided = 0;
  const onDecided = async () => {
    decided++;
  };
  const first = await runDeathpoolChannelSetup(client, config, { onDecided });
  const second = await runDeathpoolChannelSetup(client, config, { onDecided });
  assert.strictEqual(first.mode, "unavailable");
  assert.strictEqual(second.mode, "unavailable");
  assert.strictEqual(created.length, 0);
  assert.strictEqual(decided, 0);
  assert.strictEqual(hooks, 1);
});

test("more than 25 text channels: hint in the body, uncapped id can still be linked", async () => {
  resetSeason(2026);
  const channels = [];
  for (let i = 1; i <= 26; i += 1) {
    channels.push(makeTextChannel(`ch-${String(i).padStart(2, "0")}`, `ch-${String(i).padStart(2, "0")}`));
  }
  channels.push(makeTextChannel("c-found", "deathpool-2026"));
  const dmBucket = [];
  const guild = makeGuild(channels);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-25") },
  };
  await runDeathpoolChannelSetup(client, config, {});
  const question = dmBucket[0].content;
  assert.match(
    question,
    /Es gibt 27 Textkanäle, hier sind die ersten 25 nach Name\. Der gesuchte fehlt: schreib mir die Kanal-ID\./
  );
  const menu = dmBucket[0].components
    .flatMap((r) => r.components)
    .find((c) => (c.data?.custom_id || c.custom_id) === "dp:setup:pick");
  const values = (menu.data.options || menu.options || []).map((o) => o.value || o.data?.value);
  assert.strictEqual(values.length, 25);
  assert.ok(!values.includes("ch-26"));

  const replies = [];
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:pick",
      values: ["ch-26"],
      user: { id: "1" },
      reply: async (payload) => {
        replies.push(payload.content);
      },
      update: async () => {
        throw new Error("first click stays ephemeral");
      },
    },
    client,
    config
  );
  assert.match(replies[0], /Wirklich #ch-26 als Deathpool\? Dann noch einmal wählen\./);
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);

  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:pick",
      values: ["ch-26"],
      user: { id: "1" },
      update: async () => {},
      reply: async () => {},
    },
    client,
    config
  );
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, "ch-26");
});

test("click without an open setup does not update the original message", async () => {
  resetSeason(2026);
  let updated = false;
  let text = "";
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:new",
      user: { id: "1" },
      update: async () => {
        updated = true;
      },
      reply: async (payload) => {
        text = payload.content;
      },
    },
    { guilds: { fetch: async () => null }, channels: { fetch: async () => null }, users: { fetch: async () => null } },
    config
  );
  assert.strictEqual(updated, false);
  assert.match(
    text,
    /Kanal-Setup ist nicht mehr offen \(vermutlich nach einem Neustart\)\. Solange kein Kanal verknüpft ist, kommt die Frage beim nächsten Start wieder\./
  );
  assert.strictEqual(db.getActiveSeason().deathpool_channel_id, null);
});

test("second click after a decision says it is already done and does not rewrite", async () => {
  resetSeason(2026);
  const dmBucket = [];
  const guild = makeGuild([makeTextChannel("c-found", "deathpool-2026")]);
  const client = {
    guilds: { fetch: async () => guild },
    channels: { fetch: async () => null },
    users: { fetch: async () => adminUser(dmBucket, "dm-done") },
  };
  await runDeathpoolChannelSetup(client, config, { onDecided: async () => {} });
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:use:c-found",
      user: { id: "1" },
      update: async () => {},
      reply: async () => {},
    },
    client,
    config
  );
  let updated = false;
  let text = "";
  await handleChannelSetupInteraction(
    {
      customId: "dp:setup:use:c-found",
      user: { id: "1" },
      update: async () => {
        updated = true;
      },
      reply: async (payload) => {
        text = payload.content;
      },
    },
    client,
    config
  );
  assert.strictEqual(updated, false);
  assert.strictEqual(text, "Schon erledigt: #deathpool-2026.");
});
