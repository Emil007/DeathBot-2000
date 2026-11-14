const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-test-log-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.CHANNEL_DEATHPOOL = "1";
process.env.CHANNEL_LOG = "222";
process.env.DATA_DIR = tmp;

const { loadConfig } = require("../src/config");
const config = loadConfig();
const { scrubText, logEvent, logError, _resetForTest } = require("../src/discord/log");

// Fake client/channel to assert sends without Discord.
function fakeSink() {
  const sent = [];
  const ttl = { min: 5, max: 3 };
  const client = {
    channels: {
      async fetch(id) {
        return {
          isTextBased: () => true,
          async send(payload) {
            // emulate queue delay so ordering is observable
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
  _resetForTest();
});

after(() => {
  _resetForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("scrubText removes injected token from message and stack", () => {
  const token = "MFA_abc_1234567890abcdefghijklmnopqrstuvwxyz0000000000";
  const cfg = { token };
  const msg = scrubText(`error near ${token} in payload`, cfg);
  assert.ok(!msg.includes(token), "token must be redacted from message");
  assert.ok(msg.includes("[REDACTED]"));
  const stack = scrubText(`Error: boom\\n    at x (file.js:1:1)\\n    token=${token}`, cfg);
  assert.ok(!stack.includes(token), "token must be redacted from stack");
});

test("logEvent with kind scan is dropped (no send)", async () => {
  const { client, sent } = fakeSink();
  await logEvent(client, config, { kind: "scan", summary: "scraped 50" });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(sent.length, 0, "scan events must never reach the channel");
});

test("missing CHANNEL_LOG never throws", async () => {
  const { client } = fakeSink();
  const cfg = { ...config, channelLog: "" };
  await logEvent(client, cfg, { kind: "import", summary: "x" });
  await logError(client, cfg, new Error("boom"));
  assert.ok(true); // no throw = pass
});

test("two quick events produce two sends (queue drains)", async () => {
  _resetForTest();
  const { client, sent } = fakeSink();
  // First event starts the queue; drain awaits the artificial 1000ms gap.
  logEvent(client, config, { kind: "import", summary: "one" });
  logEvent(client, config, { kind: "finalize", summary: "two" });
  // Wait past the interval + margin
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(sent.length, 2, "both events should be sent");
});

test("logError embeds HTTP status", async () => {
  _resetForTest();
  const { client, sent } = fakeSink();
  const err = new Error("rate limited");
  err.response = { status: 429 };
  await logError(client, config, err, { where: "wiki lookup", userId: "42" });
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(sent.length, 1);
  const embeds = sent[0].embeds || [];
  assert.strictEqual(embeds.length, 1);
  const desc = embeds[0].data?.description || embeds[0].description || JSON.stringify(embeds[0]);
  assert.ok(String(desc).includes("429"), "embed should carry HTTP status");
});
