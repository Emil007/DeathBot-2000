const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deathbot-m18-"));
process.env.TOKEN = "x";
process.env.ADMIN_ID = "1";
process.env.DISCORD_GUILD_ID = "guild-test";
process.env.DATA_DIR = tmp;

const { statusText } = require("../src/discord/presence");
const { usageReply } = require("../src/discord/usage");
const help = require("../src/discord/commands/help");
const statusCmd = require("../src/discord/commands/status");
const { loadBuiltin } = require("../src/phrases");
const { loadConfig } = require("../src/config");
const db = require("../src/db");
const ops = require("../src/ops/status");

const PHRASES_PATH = path.join(__dirname, "../src/phrases/builtin-phrases.json");

/**
 * Spec-Reparatur: nur Zeilen mit Ã oder â€, und nur per latin1→utf8,
 * und nur wenn die Marker danach weg sind. Alles andere bleibt bytegleich.
 */
function repairPhraseLines(lines) {
  return lines.map((line) => {
    if (typeof line !== "string") return line;
    if (!line.includes("Ã") && !line.includes("â€")) return line;
    const fixed = Buffer.from(line, "latin1").toString("utf8");
    if (fixed.includes("Ã") || fixed.includes("â€")) return line;
    return fixed;
  });
}

function contentOf(payload) {
  return typeof payload === "string" ? payload : payload.content;
}

before(() => {
  db.openDb(loadConfig());
});

after(() => {
  try {
    db.closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("statusText(0|1|2) sind die drei deutschen Sätze, ohne lurking", () => {
  assert.strictEqual(statusText(0), "Heute noch niemand. Die Sense wartet.");
  assert.strictEqual(statusText(1), "Heute schon 1 Leiche. Der Tag ist jung.");
  assert.strictEqual(statusText(2), "Heute schon 2 Leichen. Die Sense ist pünktlich.");
  assert.strictEqual(statusText(12), "Heute schon 12 Leichen. Die Sense ist pünktlich.");
  const src = fs.readFileSync(path.join(__dirname, "../src/discord/presence.js"), "utf8");
  assert.equal(src.toLowerCase().includes("lurking"), false);
  for (const n of [0, 1, 2]) {
    assert.equal(statusText(n).toLowerCase().includes("lurking"), false);
  }
});

test("Mojibake-Zeile wird repariert, korrekte UTF-8-Zeile im selben Array bleibt bytegleich", () => {
  const kept = "Beileid ist für Idioten. Schon richtig geschrieben.";
  const input = [
    "{winners} wÃ¤lzen sich in {score} Punkten wie Schweine im Blut.",
    kept,
  ];
  const out = repairPhraseLines(input);
  assert.strictEqual(
    out[0],
    "{winners} wälzen sich in {score} Punkten wie Schweine im Blut."
  );
  assert.strictEqual(out[1], kept);
  assert.ok(Buffer.from(out[1], "utf8").equals(Buffer.from(input[1], "utf8")));
  assert.equal(out[1].includes("Ã"), false);
});

test("builtin-phrases: Mojibake weg, Zehnerblöcke auf zwei, JSON gültig", () => {
  const raw = fs.readFileSync(PHRASES_PATH);
  const bank = JSON.parse(raw.toString("utf8"));
  assert.ok(Array.isArray(bank));
  assert.deepStrictEqual(loadBuiltin(), bank);

  assert.ok(
    bank.some((p) =>
      p.includes("{winners} wälzen sich in {score} Punkten wie Schweine im Blut.")
    )
  );
  assert.equal(bank.some((p) => p.includes("wÃ¤lzen")), false);
  assert.equal(bank.some((p) => p.includes("Ã") || p.includes("â€")), false);
  assert.equal(bank.some((p) => p.includes("\uFFFD")), false);

  const closure = "Ich bin nicht hier für Closure. Hier für Corpses. {name}.";
  assert.ok(bank.includes(closure));
  assert.ok(Buffer.from(closure, "utf8").equals(Buffer.from(bank.find((p) => p === closure), "utf8")));

  const losers = "{losers} haben Pech und Charakter. {winners} haben {score}. {name} hat nichts.";
  assert.ok(bank.includes(losers));

  // Zeile ohne Ã/â€ wird nicht angefasst (CP1252-Minus bleibt Mojibake).
  const untouchedMinus =
    "Ich schreibe Geschichte in Negativ. Zeile: {name} \u00e2\u02c6\u20191 Leben.";
  assert.ok(bank.includes(untouchedMinus));

  for (const ph of ["{name}", "{age}", "{score}", "{winners}", "{losers}"]) {
    assert.ok(bank.some((p) => p.includes(ph)), ph);
  }

  const count = (needle) => bank.filter((p) => p.includes(needle)).length;
  assert.strictEqual(count("Die Sense sägt"), 2);
  assert.strictEqual(count("Ich trete {name} von der Bühne"), 2);
  assert.strictEqual(count("Verwesung bucht"), 2);
  assert.strictEqual(count("Ich lösche {name} aus der Atmung"), 2);
  assert.ok(count("von der Bühne") <= 2);
  assert.ok(count("aus der Atmung") <= 2);

  assert.ok(bank.includes("Ich trete auf Grabsteine. Metaphorisch auf eure Gefühle. {name}."));
  assert.ok(bank.some((p) => p.includes("Ich wollte Spaß.")));
  assert.ok(bank.some((p) => p.includes("schlimmer — sie wetten darauf.")));
});

test("usageReply beginnt mit So, und nicht anders", () => {
  const text = usageReply({ name: "go", usage: "{prefix}go" }, { prefix: "!" });
  assert.ok(text.startsWith("So, und nicht anders:"));
  assert.equal(text.includes("So geht"), false);
});

test("Hilfe: Überschrift, Prefix, Aufruf, unbekannter Befehl", async () => {
  assert.strictEqual(help.description, "Hilfe zu einem Befehl, bevor du daneben tippst");
  assert.strictEqual(help.admin, false);

  const commands = new Map();
  commands.set("import", {
    name: "import",
    description: "Rein damit",
    admin: false,
    group: "everyone",
    usage: "/import\n{prefix}import",
  });
  const ctx = { config: { prefix: "?", adminId: "1" }, commands };
  const replies = [];
  const msg = {
    author: { id: "1" },
    guildId: "guild-test", // Guild-Kontext: Slash existiert
    reply: async (payload) => replies.push(payload),
  };

  await help.run(ctx, [], msg);
  const overview = contentOf(replies[0]);
  assert.ok(
    overview.includes("**DeathBot Hilfe** — Befehle als `/` (Slash, aus der Vorschlagsliste) oder mit dem Präfix `?` in der DM.")
  );
  assert.ok(overview.includes("?help import"));
  assert.equal(overview.includes("!help"), false);
  assert.ok(
    overview.includes(
      "Noch nicht live: `/import` → `/review` → `/go`. Nächstes Jahr: `/announce-season`, am Start `/new-year activate:true`."
    )
  );
  assert.deepStrictEqual(replies[0].allowedMentions, { parse: [] });

  await help.run(ctx, ["import"], msg);
  const detail = contentOf(replies[1]);
  assert.ok(detail.includes("**Aufruf**"));
  assert.equal(detail.includes("**Usage**"), false);
  assert.deepStrictEqual(replies[1].allowedMentions, { parse: [] });

  await help.run(ctx, ["zzzqqq"], msg);
  const unknown = contentOf(replies[2]);
  assert.ok(unknown.startsWith("Befehl `zzzqqq` gibt es nicht."));
  assert.deepStrictEqual(replies[2].allowedMentions, { parse: [] });
});

test("Hilfe: Nicht-Admin sieht keine Admin-Sektionen und den einfachen Kopf (Guild)", async () => {
  const commands = new Map();
  const mk = (name, admin, group, desc) =>
    commands.set(name, { name, description: desc || name, admin, group: group || "everyone", usage: `{prefix}${name}` });
  mk("liste", false, "everyone", "Zeigt deine Liste");
  mk("scores", false, "everyone", "Punkte");
  mk("celeb", false, "everyone", "Person");
  mk("kill", true, "match", "Todesfall");
  mk("go", true, "season", "Saison starten");
  mk("import", true, "season", "Import");

  const ctx = { config: { prefix: "!", adminId: "999" }, commands };
  const replies = [];
  const nonAdmin = {
    author: { id: "123" },
    guildId: "guild-test", // Guild: Slash existiert
    reply: async (payload) => replies.push(payload),
  };

  await help.run(ctx, [], nonAdmin);
  const overview = contentOf(replies[0]);
  // kein Admin-Kopf, keine Admin-Überschriften, keine Admin-Befehle
  assert.ok(overview.includes("**DeathBot Hilfe** — Tipp deine Namen"));
  assert.equal(overview.includes("Admin ·"), false, "keine Admin-Sektion");
  assert.equal(overview.includes("`kill`"), false);
  assert.equal(overview.includes("`go`") || overview.includes("/go"), false);
  assert.equal(overview.includes("`import`") || overview.includes("/import"), false);
  assert.ok(overview.includes("`liste`") || overview.includes("/liste"), "normale Befehle sichtbar");
  // Guild: Slash-Weg darf erwähnt werden
  assert.ok(overview.includes("/help"), "in der Guild verweist die Hilfe auf /help");
  assert.ok(overview.includes("/liste"), "in der Guild sieht man den Slash-Befehl /liste");
});

test("Hilfe: In der DM keine Slash-Referenzen, nur Prefix-Befehle", async () => {
  const commands = new Map();
  const mk = (name, admin, group, desc) =>
    commands.set(name, { name, description: desc || name, admin, group: group || "everyone", usage: `{prefix}${name}` });
  mk("liste", false, "everyone", "Zeigt deine Liste");
  mk("scores", false, "everyone", "Punkte");
  mk("celeb", false, "everyone", "Person");
  mk("kill", true, "match", "Todesfall");
  mk("help", false, "everyone", "Hilfe");

  const ctx = { config: { prefix: "!", adminId: "999" }, commands };
  const replies = [];
  const dmUser = {
    author: { id: "123" },
    guildId: null, // DM: kein Slash verfügbar
    reply: async (payload) => replies.push(payload),
  };

  await help.run(ctx, [], dmUser);
  const overview = contentOf(replies[0]);
  // Keine einzige Slash-Referenz
  assert.equal(overview.includes("/liste"), false, "kein /liste im DM");
  assert.equal(overview.includes("/help"), false, "kein /help im DM");
  assert.equal(overview.includes("/scores"), false, "kein /scores im DM");
  assert.equal(overview.includes("/kill"), false, "kein /kill im DM");
  // Nur-Prefix-Angaben
  assert.ok(overview.includes("`!liste`"), "Prefix-Form von liste sichtbar");
  assert.ok(overview.includes("!hilfe"), "verweist im DM auf !hilfe");

  // Detail-Karte im DM: auch da kein Slash
  replies.length = 0;
  await help.run(ctx, ["liste"], dmUser);
  const detail = contentOf(replies[0]);
  assert.equal(detail.includes("/liste"), false, "Detail-Karte DM: kein /liste");
  assert.ok(detail.includes("`!liste`"), "Detail-Karte DM: nur !liste");
});

test("Tagesbericht hängt an config.tz", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/jobs/daily-summary.js"), "utf8");
  assert.ok(
    src.includes(
      "Der Tagesbericht läuft um DAILY_SUMMARY_HOUR in config.tz. main() setzt außerdem process.env.TZ = config.tz, damit der Container nicht auf UTC stehen bleibt."
    )
  );
  const cron = require("node-cron");
  const seen = [];
  const orig = cron.schedule;
  cron.schedule = (expr, fn, opts) => {
    seen.push({ expr, opts });
    return { stop() {} };
  };
  try {
    const { startDailySummary } = require("../src/jobs/daily-summary");
    startDailySummary({}, { dailySummaryHour: 9, tz: "Europe/Vienna" });
  } finally {
    cron.schedule = orig;
  }
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].expr, "0 9 * * *");
  assert.deepStrictEqual(seen[0].opts, { timezone: "Europe/Vienna" });
});

test("/status bleibt admin und zeigt Offen, Fehlerzeile, Zähler", async () => {
  assert.strictEqual(statusCmd.admin, true);
  assert.strictEqual(statusCmd.description, "Ops-Status: Poller, Zähler, letzte Fehler");

  ops.setNightlyPending(true);
  ops.markPollEnd("nightly", { ok: false, error: "db down", durationMs: 1500 });

  const bare = {
    tz: "Europe/Vienna",
    wikiPollerMinutes: 30,
    nightlyFullScrapeHour: 3,
    channelAdmin: "",
    channelAllDeaths: "",
    discordGuildId: "",
    prefix: "!",
    adminId: "1",
  };

  async function ask(cfg) {
    const replies = [];
    await statusCmd.run({ config: cfg }, [], {
      reply: async (payload) => replies.push(payload),
    });
    assert.deepStrictEqual(replies[0].allowedMentions, { parse: [] });
    return replies[0].content;
  }

  const empty = await ask(bare);
  assert.match(empty, /\*\*Offen\*\*/);
  assert.match(empty, /Announced-Saison: \*\*nein\*\*/);
  assert.match(empty, /Kanal-Setup offen: \*\*nein\*\* · Setup-Nachricht: \*\*nein\*\*/);
  assert.match(empty, /Reviews gesamt: \*\*0\*\*/);
  assert.match(empty, /Drafts nicht finalized: \*\*0\*\*/);
  assert.match(empty, /Nachtlauf ausstehend/);
  assert.match(empty, /Letzter Lauf: \*\*nightly\*\* · Fehler ·/);
  assert.match(empty, /• Letzter Fehler: `db down`/);
  assert.match(empty, /ausgeschlossen \*\*0\*\*/);
  assert.match(empty, /_zuerst per DM_/);
  assert.match(empty, /_fehlt \(Slash-Befehle hinken hinterher\)_/);
  assert.equal(empty.toLowerCase().includes("lurking"), false);
  assert.doesNotMatch(empty, /Letzter Fehler:.*witz/i);

  const announced = db
    .getDb()
    .prepare(
      `INSERT INTO seasons (year, active, start_date, live, phase) VALUES (2027, 0, '2027-01-01', 0, 'announced')`
    )
    .run();
  const player = db
    .getDb()
    .prepare(`INSERT INTO players (display_name, discord_user_id) VALUES ('Ada', 'ada-m18')`)
    .run();
  const player2 = db
    .getDb()
    .prepare(`INSERT INTO players (display_name, discord_user_id) VALUES ('Bea', 'bea-m18')`)
    .run();
  db.getDb()
    .prepare(`INSERT INTO pick_drafts (player_id, season_id, status) VALUES (?, ?, 'draft')`)
    .run(player.lastInsertRowid, announced.lastInsertRowid);
  db.getDb()
    .prepare(`INSERT INTO pick_drafts (player_id, season_id, status) VALUES (?, ?, 'finalized')`)
    .run(player2.lastInsertRowid, announced.lastInsertRowid);
  const celeb = db
    .getDb()
    .prepare(`INSERT INTO celebs (name, name_key) VALUES ('Offen Test', 'offen test')`)
    .run();
  db.getDb()
    .prepare(
      `INSERT INTO celeb_review_queue (celeb_id, status, season_id) VALUES (?, 'pending', ?)`
    )
    .run(celeb.lastInsertRowid, db.getActiveSeason().id);
  db.setMeta("channel_setup_open", "1");

  const open = await ask({ ...bare, channelAdmin: "42", discordGuildId: "guild-test" });
  assert.match(open, /Announced-Saison: \*\*ja\*\* · Start \*\*2027-01-01\*\*/);
  assert.match(open, /Kanal-Setup offen: \*\*ja\*\* · Setup-Nachricht: \*\*ja\*\*/);
  assert.match(open, /Reviews gesamt: \*\*1\*\*/);
  assert.match(open, /Drafts nicht finalized: \*\*1\*\*/);
  assert.match(open, /`42`/);
  assert.match(open, /`guild-test`/);
  assert.equal(open.includes("_zuerst per DM_"), false);
  assert.equal(open.includes("_fehlt (Slash-Befehle hinken hinterher)_"), false);

  db.setMeta("channel_setup_open", "0");
  const closed = await ask(bare);
  assert.match(closed, /Kanal-Setup offen: \*\*nein\*\* · Setup-Nachricht: \*\*nein\*\*/);

  ops.setNightlyPending(false);
  ops.markPollEnd("live", { ok: true, durationMs: 20 });
  const okRun = await ask(bare);
  assert.match(okRun, /Letzter Lauf: \*\*live\*\* · ok ·/);
  assert.equal(okRun.includes("Nachtlauf ausstehend"), false);
});
