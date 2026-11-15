const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-membership-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "guild-test";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const { canParticipate, participationSentence } = require("../src/discord/membership");

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

function fakeChannel({ guild, canSee = true, perms = null } = {}) {
  const ch = { guild: guild ? { members: { fetch: async (id) => ({ id }) } } : null };
  ch.guildFetch = guild;
  ch.permissionsFor = () => (perms ? { has: () => canSee } : null);
  return ch;
}

const clientStub = (channel) => ({
  channels: {
    async fetch(id) {
      if (!channel) throw new Error("no channel");
      return channel;
    },
  },
});

test("no announced season -> closed", async () => {
  const res = await canParticipate(clientStub(fakeChannel({ guild: true })), config, "123");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "closed");
});

test("announced without channel -> closed", async () => {
  db.openAnnouncedSeason({ year: 2027, startDate: "2027-01-01", channelId: null, note: null });
  // Kanal fehlt → openAnnouncedSeason erfordert eigentlich channelId; direkt leeren
  db.getDb().prepare("UPDATE seasons SET announce_channel_id = NULL WHERE phase='announced'").run();
  const res = await canParticipate(clientStub(fakeChannel({ guild: true })), config, "123");
  assert.strictEqual(res.reason, "closed");
});

test("member with ViewChannel -> ok (running 2026 live beside it)", async () => {
  // setze Kanal
  db.getDb().prepare("UPDATE seasons SET announce_channel_id = '777' WHERE phase='announced'").run();
  const ch = {
    guild: { members: { fetch: async () => ({ id: "123" }) } },
    permissionsFor: () => ({ has: () => true }),
  };
  const res = await canParticipate(clientStub(ch), config, "123");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.season.year, 2027);
});

test("member without ViewChannel -> not-member", async () => {
  const ch = {
    guild: { members: { fetch: async () => ({ id: "123" }) } },
    permissionsFor: () => ({ has: () => false }),
  };
  const res = await canParticipate(clientStub(ch), config, "123");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not-member");
});

test("admin allowed without ViewChannel when announced", async () => {
  const ch = {
    guild: { members: { fetch: async () => { const e = new Error("Unknown Member"); e.code = 10007; throw e; } } },
    permissionsFor: () => null,
  };
  config.adminId = "999";
  const res = await canParticipate(clientStub(ch), config, "999");
  assert.strictEqual(res.ok, true);
});

test("no announced season and not live -> not-open", async () => {
  const announced = db.getDb().prepare("SELECT id FROM seasons WHERE phase = 'announced'").all();
  db.getDb().prepare("UPDATE seasons SET phase = 'archived' WHERE phase = 'announced'").run();
  db.getDb().prepare("UPDATE seasons SET live = 0 WHERE active = 1").run();
  try {
    const res = await canParticipate(clientStub(fakeChannel({ guild: true })), config, "123");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "not-open");
    assert.strictEqual(
      participationSentence(res),
      "Die Anmeldung ist noch nicht offen. Sobald sie aufgeht, schreibst du die Namen hierher."
    );
  } finally {
    db.getDb().prepare("UPDATE seasons SET live = 1 WHERE active = 1").run();
    for (const row of announced) {
      db.getDb().prepare("UPDATE seasons SET phase = 'announced' WHERE id = ?").run(row.id);
    }
  }
});

test("fetch 10003 -> channel-missing", async () => {
  db.getDb().prepare("UPDATE seasons SET announce_channel_id = '777' WHERE phase = 'announced'").run();
  const client = {
    channels: {
      async fetch() {
        const e = new Error("Unknown Channel");
        e.code = 10003;
        throw e;
      },
    },
  };
  const res = await canParticipate(client, config, "123");
  assert.strictEqual(res.reason, "channel-missing");
  assert.match(participationSentence(res), /Anmeldekanal gibt es nicht mehr/);
});

test("429, 503, timeout and unavailable guild are unavailable", async () => {
  async function reasonFor(fetchImpl, channel) {
    const client = {
      channels: {
        async fetch() {
          if (fetchImpl) return fetchImpl();
          return channel;
        },
      },
    };
    const res = await canParticipate(client, config, "123");
    return res.reason;
  }
  assert.strictEqual(
    await reasonFor(() => {
      const e = new Error("rate");
      e.code = 429;
      throw e;
    }),
    "unavailable"
  );
  assert.strictEqual(
    await reasonFor(() => {
      const e = new Error("bad gateway");
      e.status = 503;
      throw e;
    }),
    "unavailable"
  );
  assert.strictEqual(
    await reasonFor(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }),
    "unavailable"
  );
  let fetchedMember = false;
  const ch = {
    guild: {
      available: false,
      members: {
        fetch: async () => {
          fetchedMember = true;
          return { id: "123" };
        },
      },
    },
    permissionsFor: () => ({ has: () => true }),
  };
  assert.strictEqual(await reasonFor(null, ch), "unavailable");
  assert.strictEqual(fetchedMember, false);
});

test("closed sentence names the year", () => {
  assert.strictEqual(
    participationSentence({ reason: "closed", season: { year: 2026 } }),
    "Die Tippzeit für 2026 ist vorbei, deine Liste ist zu."
  );
});
