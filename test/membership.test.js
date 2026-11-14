const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-membership-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const db = require("../src/db");
const { canParticipate } = require("../src/discord/membership");

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
