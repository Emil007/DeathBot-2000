const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ApplicationIntegrationType, InteractionContextType } = require("discord.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-guild-gate-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const config = loadConfig();
const db = require("../src/db");
const { loadCommands } = require("../src/discord/commands");
const { buildSlashPayload, registerSlashCommands } = require("../src/discord/slash");
const { scrubText, logEvent, logError, _resetForTest } = require("../src/discord/log");
const {
  isOurGuild,
  guildGateDecision,
  isAdminActor,
  isDmDataCommand,
  isUnknownInteraction,
  allowGuildDm,
} = require("../src/index");

function miniCommands() {
  return new Map([
    [
      "ping",
      {
        name: "ping",
        description: "Ping",
        run() {},
      },
    ],
  ]);
}

function fakeLogClient() {
  const sent = [];
  const client = {
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          async send(payload) {
            sent.push(payload);
            return {};
          },
        };
      },
    },
  };
  return { client, sent };
}

before(() => {
  db.openDb(config);
  _resetForTest();
});

after(() => {
  _resetForTest();
  try {
    db.closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("scrubText with config.token redacts that token", () => {
  const token = "tok-12345678";
  const cfg = { ...config, token };
  const msg = scrubText(`sql failed near ${token}`, cfg);
  assert.ok(!msg.includes(token));
  assert.ok(msg.includes("[REDACTED]"));
});

test("foreign guildId is not our guild", () => {
  const foreign = { guildId: "other-guild", customId: "pka:pick:1" };
  assert.strictEqual(isOurGuild(foreign, config), false);
  const decision = guildGateDecision(foreign, config);
  assert.strictEqual(decision.ours, false);
  assert.strictEqual(decision.foreign, true);
  assert.strictEqual(decision.dmSpecial, false);
  assert.strictEqual(decision.guildDataCommand, false);
});

test("null guildId and custom id pka:pick:1 is the DM special case, not a guild data command", () => {
  const dm = { guildId: null, customId: "pka:pick:1" };
  assert.strictEqual(isOurGuild(dm, config), false);
  const decision = guildGateDecision(dm, config);
  assert.strictEqual(decision.dmSpecial, true);
  assert.strictEqual(decision.guildDataCommand, false);
  assert.strictEqual(decision.ours, false);

  const crev = guildGateDecision({ guildId: null, customId: "crev:ok:4" }, config);
  assert.strictEqual(crev.dmSpecial, true);
  assert.strictEqual(crev.guildDataCommand, false);

  const otherDm = guildGateDecision({ guildId: null, customId: "help:page:1" }, config);
  // Die Hilfeseiten-Buttons sind auch im DM erlaubt (kein Guild-Datenbefehl).
  assert.strictEqual(otherDm.dmSpecial, true);
  assert.strictEqual(otherDm.guildDataCommand, false);

  const helpNoop = guildGateDecision({ guildId: null, customId: "help:noop" }, config);
  assert.strictEqual(helpNoop.dmSpecial, true);
  assert.strictEqual(helpNoop.guildDataCommand, false);
});

test("our guild is accepted", () => {
  const decision = guildGateDecision({ guildId: "guild-test", customId: "liste" }, config);
  assert.strictEqual(isOurGuild({ guildId: "guild-test" }, config), true);
  assert.strictEqual(decision.ours, true);
  assert.strictEqual(decision.guildDataCommand, true);
  assert.strictEqual(decision.dmSpecial, false);
});

test("buildSlashPayload has no UserInstall and no DM contexts", () => {
  const payload = buildSlashPayload(loadCommands());
  const json = JSON.stringify(payload);
  assert.ok(!json.includes("UserInstall"));
  assert.ok(payload.length > 0);
  for (const cmd of payload) {
    assert.ok(!cmd.integration_types.includes(ApplicationIntegrationType.UserInstall));
    assert.ok(!cmd.integration_types.includes(1));
    assert.deepStrictEqual(cmd.integration_types, [ApplicationIntegrationType.GuildInstall]);
    assert.deepStrictEqual(cmd.contexts, [InteractionContextType.Guild]);
    assert.ok(!cmd.contexts.includes(InteractionContextType.BotDM));
    assert.ok(!cmd.contexts.includes(InteractionContextType.PrivateChannel));
  }
});

test("worst case: payload has no UserInstall and a foreign guildId fails isOurGuild", () => {
  const payload = buildSlashPayload(loadCommands());
  const json = JSON.stringify(payload);
  assert.ok(!json.includes("UserInstall"));
  assert.ok(!payload.some((cmd) => (cmd.integration_types || []).includes(ApplicationIntegrationType.UserInstall)));
  assert.strictEqual(isOurGuild({ guildId: "not-this-guild", customId: "scores" }, config), false);
  assert.strictEqual(
    guildGateDecision({ guildId: null, customId: "pka:pick:1" }, config).guildDataCommand,
    false
  );
});

test("admin is adminId everywhere; admin role only inside a guild", () => {
  const cfg = { ...config, adminRoleId: "role-admin" };
  assert.strictEqual(isAdminActor({ author: { id: "1" }, guildId: null }, cfg), true);
  assert.strictEqual(
    isAdminActor(
      {
        author: { id: "2" },
        guildId: null,
        member: { _roles: ["role-admin"] },
      },
      cfg
    ),
    false
  );
  assert.strictEqual(
    isAdminActor(
      {
        author: { id: "2" },
        guildId: "guild-test",
        member: { _roles: ["role-admin"] },
      },
      cfg
    ),
    true
  );
  assert.strictEqual(
    isAdminActor({ user: { id: "9" }, guildId: "guild-test", member: { roles: ["role-admin"] } }, cfg),
    true
  );
  assert.strictEqual(isAdminActor({ author: { id: "9" }, guildId: "guild-test", member: {} }, cfg), false);
  assert.strictEqual(isAdminActor({ author: { id: "9" }, guildId: "guild-test" }, config), false);
});

test("DM data commands are scores, players, celeb, celebs including aliases (liste is DM-open)", () => {
  // liste ist bewusst NICHT blockiert: die EIGENE Liste gehört zum DM-Self-Service.
  assert.strictEqual(isDmDataCommand({ name: "liste" }), false);
  assert.strictEqual(isDmDataCommand({ name: "list", _aliasOf: "liste" }), false);
  assert.strictEqual(isDmDataCommand({ name: "score", _aliasOf: "scores" }), true);
  assert.strictEqual(isDmDataCommand({ name: "celebliste", _aliasOf: "celebs" }), true);
  assert.strictEqual(isDmDataCommand({ name: "players" }), true);
  assert.strictEqual(isDmDataCommand({ name: "celeb" }), true);
  assert.strictEqual(isDmDataCommand({ name: "help" }), false);
  assert.strictEqual(isDmDataCommand({ name: "status", admin: true }), false);
});

test("isUnknownInteraction covers 10062 and 50027", () => {
  assert.strictEqual(isUnknownInteraction({ code: 10062 }), true);
  assert.strictEqual(isUnknownInteraction({ rawError: { code: 50027 } }), true);
  assert.strictEqual(isUnknownInteraction({ code: "50027" }), true);
  assert.strictEqual(isUnknownInteraction({ code: 10007 }), false);
  assert.strictEqual(isUnknownInteraction(new Error("SQLITE_ERROR")), false);
});

test("DM pick interaction allows guild members and adminId, not unavailable", async () => {
  let fetched = 0;
  const client = {
    guilds: {
      async fetch() {
        return {
          available: true,
          members: {
            async fetch(id) {
              fetched += 1;
              if (id === "429") {
                const err = new Error("rate limit");
                err.status = 429;
                throw err;
              }
              if (id === "missing") {
                const err = new Error("Unknown Member");
                err.code = 10007;
                throw err;
              }
              return { id };
            },
          },
        };
      },
    },
  };
  assert.strictEqual(await allowGuildDm(client, config, "1"), true);
  assert.strictEqual(fetched, 0, "adminId does not need a member fetch");
  assert.strictEqual(await allowGuildDm(client, config, "member-2"), true);
  assert.strictEqual(await allowGuildDm(client, config, "missing"), false);
  assert.strictEqual(await allowGuildDm(client, config, "429"), false);

  const down = {
    guilds: {
      async fetch() {
        return { available: false, members: { async fetch() { throw new Error("should not fetch"); } } };
      },
    },
  };
  assert.strictEqual(await allowGuildDm(down, config, "member-2"), false);
});

test("registerSlashCommands clears globals once and always sets guild commands", async () => {
  const calls = [];
  const client = {
    application: {
      commands: {
        async set(body) {
          calls.push({ where: "global", body });
        },
      },
    },
    guilds: {
      async fetch(id) {
        assert.strictEqual(id, "guild-test");
        return {
          id,
          name: "Testguild",
          available: true,
          commands: {
            async set(body) {
              calls.push({ where: "guild", body });
            },
          },
        };
      },
    },
  };
  const commands = miniCommands();
  await registerSlashCommands(client, config, commands);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0], { where: "global", body: [] });
  assert.strictEqual(calls[1].where, "guild");
  assert.ok(calls[1].body.length >= 1);
  assert.ok(!JSON.stringify(calls[1].body).includes("UserInstall"));

  const cleared = db.getDb().prepare(`SELECT value FROM meta WHERE key = 'slash_global_cleared'`).get();
  assert.strictEqual(cleared.value, "1");
  const hash = db.getDb().prepare(`SELECT value FROM meta WHERE key = 'slash_commands_hash_guild'`).get();
  assert.match(hash.value, /^[a-f0-9]{64}$/);

  calls.length = 0;
  await registerSlashCommands(client, config, commands);
  assert.deepStrictEqual(
    calls.map((c) => c.where),
    ["guild"],
    "second boot does not register globally and still sets the guild commands"
  );
});

test("unavailable guild does not set commands and is not treated as a missing channel", async () => {
  db.getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('slash_global_cleared', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run();
  const beforeHash = db.getDb().prepare(`SELECT value FROM meta WHERE key = 'slash_commands_hash_guild'`).get()?.value;
  const calls = [];
  const client = {
    application: {
      commands: {
        async set(body) {
          calls.push({ where: "global", body });
        },
      },
    },
    guilds: {
      async fetch() {
        return {
          available: false,
          name: "Down",
          commands: {
            async set() {
              calls.push({ where: "guild" });
            },
          },
        };
      },
    },
  };
  await registerSlashCommands(client, config, miniCommands());
  assert.deepStrictEqual(calls, []);
  const afterHash = db.getDb().prepare(`SELECT value FROM meta WHERE key = 'slash_commands_hash_guild'`).get()?.value;
  assert.strictEqual(afterHash, beforeHash);
});

test("log summary sanitizes a raw name and the send uses mentionOpts", async () => {
  _resetForTest();
  const { client, sent } = fakeLogClient();
  const cfg = { ...config, channelLog: "222", token: "tok-12345678" };
  await logEvent(client, cfg, {
    kind: "pick-link",
    summary: "Kandidat gewählt: <@99> *Zelda* → Princess (Saison 2027)",
    userId: "7",
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sent.length, 1);
  const summary = sent[0].content || "";
  assert.ok(summary.includes("Zelda"));
  assert.ok(summary.includes("Princess"));
  assert.ok(!summary.includes("<@"));
  assert.ok(!summary.includes("*Zelda*"));
  assert.ok(!summary.includes("@99"));
  assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
});

test("logError embed scrubs config.token from stack and message", async () => {
  _resetForTest();
  const { client, sent } = fakeLogClient();
  const cfg = { ...config, channelLog: "222", token: "tok-12345678" };
  const err = new Error("axios boom tok-12345678");
  err.stack = "Error: axios boom tok-12345678\n    at query (db.js:1:1)";
  await logError(client, cfg, err, { where: "interaction liste", userId: "7" });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
  const blob = JSON.stringify(sent[0]);
  assert.ok(!blob.includes("tok-12345678"));
  assert.ok(blob.includes("[REDACTED]"));
});

test("main applies the process timezone before openDb and the client disables mention parsing", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  const mainStart = src.indexOf("async function main");
  const ready = src.indexOf('client.once("clientReady"');
  const body = src.slice(mainStart, ready);
  const tz = body.indexOf("applyProcessTimezone(config)");
  const open = body.indexOf("db.openDb(config)");
  assert.ok(tz !== -1 && open !== -1 && tz < open);
  assert.ok(body.includes("allowedMentions: { parse: [] }"));
  assert.ok(!src.includes("Fehler: ${"));
});
