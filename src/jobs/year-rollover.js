const { AsyncLocalStorage } = require("async_hooks");
const cron = require("node-cron");
const { ChannelType } = require("discord.js");
const db = require("../db");
const { logEvent, logError } = require("../discord/log");
const { sendAdmin } = require("../discord/admin-notify");
const { createPackage } = require("../backup");
const { isAnyOpen, retarget } = require("./setup-state");

const REVIEW_KEY = "year_rollover_annual_review";
const PENDING_KEY = "pending_season_review";

let timeMod;
let timeChecked = false;
function timeApi() {
  if (!timeChecked) {
    timeChecked = true;
    try {
      timeMod = require("../db/time");
    } catch {
      timeMod = null;
    }
  }
  return timeMod;
}

function mentionOpts() {
  try {
    return require("../discord/safe-text").mentionOpts();
  } catch {
    return { allowedMentions: { parse: [] } };
  }
}

function safeName(raw) {
  try {
    return require("../discord/safe-text").sanitizeDisplayName(raw);
  } catch {
    return String(raw ?? "");
  }
}

/**
 * Kalendertag YYYY-MM-DD in der Bot-Zeitzone.
 * ANNAHME: src/db/time.js (M1) fehlt in diesem Workspace noch; dieselbe
 * Intl-Regel wird benutzt, sobald das Modul da ist.
 */
function calendarDate(instant, timeZone) {
  const api = timeApi();
  if (typeof api?.calendarDate === "function") return api.calendarDate(instant, timeZone);
  const date = instant == null ? new Date() : instant;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addCalendarDays(yyyyMmDd, n) {
  const api = timeApi();
  if (typeof api?.addCalendarDays === "function") return api.addCalendarDays(yyyyMmDd, n);
  const [y, m, d] = String(yyyyMmDd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(n)));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function calendarYearString(instant, timeZone) {
  return calendarDate(instant, timeZone).slice(0, 4);
}

/** Nächstes Jahr relativ zur laufenden Saison/aktuellen Datum. */
function nextYear(running) {
  const base = running?.year || new Date().getFullYear();
  return base + 1;
}

/**
 * Baut die Jahresauswertung („nette Auswertung des Vorjahres") als Discord-Nachricht.
 * Zeigt die Platzierungen der archivierten Saison (via season_point_snapshots)
 * + Anzahl Todesfälle des Jahres.
 */
function formatSeasonReviewText(review, runningYear) {
  if (!review) return null;
  const { season, rows, deaths } = review;
  const lines = [];
  lines.push(`📊 **Saison ${season.year} — Abschlussbilanz**`);
  lines.push("");
  if (!rows.length) {
    lines.push("Keine Punkte verbucht. Ein Jahr Leichen, kein Treffer. Peinlich, aber ehrlich.");
  } else {
    const medal = ["🥇", "🥈", "🥉"];
    rows.slice(0, 10).forEach((r, i) => {
      const badge = medal[i] ?? `${i + 1}.`;
      const name = safeName(r.name);
      lines.push(`${badge} **${name}** — ${r.total} Punkte${r.hits ? `, ${r.hits} Treffer` : ""}`);
    });
    if (rows.length > 10) lines.push(`… +${rows.length - 10} weitere`);
  }
  lines.push("");
  lines.push(
    `💀 **${deaths}** Todesfälle dieses Jahres in den Listen. Promi beerdigt, Tipp gepunktet — oder eben nicht.`
  );
  if (runningYear) {
    lines.push("");
    lines.push(
      `Die neue Runde **${runningYear}** ist live. Dieselben Feiglinge, frische Namen. Ich kenne das Ende schon.`
    );
  }
  return lines.join("\n");
}

/**
 * Datum in der Bot-Zeitzone (YYYY-MM-DD). `date` ist injizierbar für Tests.
 * `timeZone` kommt aus config.tz. Default Europe/Vienna.
 */
function todayInVienna(date = new Date(), timeZone = "Europe/Vienna") {
  if (date == null) date = new Date();
  return calendarDate(date, timeZone || "Europe/Vienna");
}

/** Ist heute (in der Bot-TZ) der 01.01.? */
function isNewYearDayVienna(date = new Date(), timeZone = "Europe/Vienna") {
  return todayInVienna(date, timeZone).endsWith("-01-01");
}

function isAnnualReviewWindow(yyyyMmDd) {
  return typeof yyyyMmDd === "string" && (yyyyMmDd.endsWith("-01-01") || yyyyMmDd.endsWith("-01-02"));
}

function pendingSeasonId() {
  const v = db.getMeta(PENDING_KEY);
  if (v == null || String(v).trim() === "") return null;
  return String(v);
}

function clearPendingReview() {
  db.getDb().prepare("DELETE FROM meta WHERE key = ?").run(PENDING_KEY);
}

function rememberPending(archivedId) {
  const id = String(archivedId);
  if (pendingSeasonId() !== id) db.setMeta(PENDING_KEY, id);
}

function markReviewPosted(calYear) {
  db.setMeta(REVIEW_KEY, String(calYear));
  clearPendingReview();
}

/**
 * Zielreihenfolge: neuer Kanal, sonst die gemerkte alte ID, sonst der
 * gespeicherte Deathpool der aktiven Saison, sonst channelAllDeaths.
 * config.channelDeathpool wird nicht gelesen.
 */
function reviewTargetIds(config, preferredChannelId, fallbackChannelId) {
  const ids = [];
  const push = (id) => {
    if (id == null || id === "") return;
    const s = String(id);
    if (!ids.includes(s)) ids.push(s);
  };
  push(preferredChannelId);
  push(fallbackChannelId);
  try {
    push(db.resolveDeathpoolChannel(config));
  } catch {
    /* active season missing */
  }
  push(config?.channelAllDeaths);
  return ids;
}

async function firstSendableChannel(client, ids) {
  for (const id of ids) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.isTextBased?.()) return { id, channel: ch };
    } catch (e) {
      console.warn("[year-rollover] channel fetch failed:", id, e.message);
    }
  }
  return { id: null, channel: null };
}

/**
 * Postet die Abschlussbilanz. `liveYear` steuert den Live-Satz (nur wenn der
 * Wechsel committet wurde). `live` wählt Live-Summen statt Snapshots.
 * Flag setzt der Aufrufer, und nur wenn diese Funktion true liefert.
 */
async function postReview(client, config, season, liveYear, preferredChannelId = null, opts = {}) {
  const { live = false, fallbackChannelId = null } = opts;
  const ids = reviewTargetIds(config, preferredChannelId, fallbackChannelId);
  const { id: targetId, channel } = await firstSendableChannel(client, ids);
  if (!channel?.isTextBased?.()) {
    await logError(
      client,
      config,
      new Error(`postReview: kein sendbarer Kanal (targetId=${targetId || ids[0] || "keiner"})`),
      {
        where: "year-rollover postReview no-target",
        detail: `season=${season?.id ?? "?"} liveYear=${liveYear ?? "-"}`,
      }
    );
    return false;
  }
  const review = season ? (live ? db.seasonLiveReview(season.id) : db.seasonReview(season.id)) : null;
  const text = formatSeasonReviewText(review, liveYear ?? null);
  if (!text) return false;
  try {
    await channel.send({ content: text, ...mentionOpts() });
  } catch (e) {
    await logError(client, config, e, {
      where: "year-rollover postReview",
      detail: `channel=${targetId}`,
    });
    return false;
  }
  return true;
}

/**
 * Eine Promise-Kette um jeden runYearRollover (Cron, Start-Nachhol, /new-year
 * sobald er hier durchläuft). Der zweite Aufruf wartet, bis der erste fertig ist.
 */
let rolloverChain = Promise.resolve();

function runYearRollover(client, config, opts = {}) {
  const job = rolloverChain.then(() => runYearRolloverBody(client, config, opts || {}));
  rolloverChain = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}

async function runYearRolloverBody(client, config, { force = false, now = null } = {}) {
  const tz = config.tz || "Europe/Vienna";
  const instant = now == null ? new Date() : now;
  const today = calendarDate(instant, tz);
  const calYear = today.slice(0, 4);

  if (isAnyOpen() && !force) {
    return { switched: false, reason: "setup-open" };
  }

  const announced = db.getAnnouncedSeason();
  const running = db.getActiveSeason();

  if (!announced) {
    const pendingId = pendingSeasonId();
    if (pendingId) {
      const archived = db.getDb().prepare("SELECT * FROM seasons WHERE id = ?").get(pendingId);
      const activeId = running?.deathpool_channel_id || null;
      const oldId = archived?.deathpool_channel_id || null;
      const posted = await postReview(client, config, archived, null, activeId, {
        live: false,
        fallbackChannelId: oldId,
      });
      if (posted) {
        markReviewPosted(calYear);
      } else {
        await logError(
          client,
          config,
          new Error("runYearRollover: ausstehende Archiv-Bilanz konnte nicht gesendet werden"),
          { where: "year-rollover postReview failed", detail: `pending=${pendingId}` }
        );
      }
      return { switched: false, reason: "no-announced", posted: Boolean(posted) };
    }

    const flagBefore = db.getMeta(REVIEW_KEY);
    if (isAnnualReviewWindow(today) && flagBefore !== calYear) {
      const posted = await postReview(client, config, running, null, null, { live: true });
      if (posted) {
        markReviewPosted(calYear);
      } else {
        await logError(
          client,
          config,
          new Error("runYearRollover: Jahresbilanz (no-announced) konnte nicht gesendet werden"),
          { where: "year-rollover postReview failed", detail: `season=${running?.id}` }
        );
      }
    }
    if (flagBefore === calYear) return { switched: false, reason: "already-done" };
    return { switched: false, reason: "no-announced" };
  }

  if (!force && announced.start_date && today < announced.start_date) {
    return { switched: false, reason: "not-yet", start: announced.start_date };
  }

  let pkg;
  try {
    pkg = createPackage(config, { reason: "year-rollover" });
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover backup" });
    throw e;
  }

  let res;
  try {
    res = db.activateAnnouncedSeason();
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover activate" });
    throw e;
  }

  // ANNAHME: M3 schreibt pending_season_review in der Aktivierung. Fehlt der
  // Wert (M3 noch nicht gemerged), merken wir die archivierte Id hier, bevor
  // der Post läuft. Ein Fehlschlag löscht sie nicht.
  rememberPending(res.archived.id);
  const oldChannelId = res.archived.deathpool_channel_id || null;
  retarget(res.archived.id, res.activated.id);

  // Saison-Start-Backup: nach erfolgreichem Aktivieren der NEUEN Saison ein
  // ewig bleibenles Backup (retain=true → data/backups/season-start/), damit im
  // schlimmsten Fall wenigstens die Tipps der neuen Saison sicher sind.
  // Nicht vom nächtlichen Prune gelöscht. Fehler blockiert den Wechsel NICHT.
  try {
    const startPkg = createPackage(config, { reason: "season-start", retain: true });
    console.log("[year-rollover] Saison-Start-Backup:", startPkg.name);
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover season-start backup" });
  }

  const fin = await finalizeYearSwitch(client, config, res.archived.id, res.activated.year, {
    oldChannelId,
  });
  const newChannel = fin.newChannel;
  const newChannelFailed = fin.newChannelFailed;

  if (fin.posted) {
    markReviewPosted(calYear);
  } else {
    await logError(
      client,
      config,
      new Error("runYearRollover: Abschlussbilanz wurde nicht gesendet"),
      { where: "year-rollover postReview failed", detail: `archived=${res.archived.id}` }
    );
  }

  await logEvent(client, config, {
    kind: "season-switch-auto",
    summary: `Automatischer Saisonwechsel ${res.archived.year} → ${res.activated.year}`,
    userId: config.adminId,
    detail: `backup=${pkg?.name} archived=${res.archived.id} activated=${res.activated.id}`,
  });

  const ackIds = reviewTargetIds(config, newChannel?.id || null, oldChannelId);
  const ackHit = await firstSendableChannel(client, ackIds);
  const ackChannelId = ackHit.id;
  const channel = ackHit.channel;
  if (channel?.isTextBased?.()) {
    try {
      const ackText = newChannel
        ? `🆕 **Saison ${res.activated.year} ist live.** Neuer Flur: <#${newChannel.id}>. Wer mitspielt, ist eingeladen.`
        : newChannelFailed
          ? `🔄 **Saisonwechsel:** ${res.archived.year} archiviert — **${res.activated.year} ist live**. Kanal-Anlage fehlgeschlagen — es gibt keinen neuen Kanal.`
          : `🔄 **Saisonwechsel:** ${res.archived.year} archiviert — **${res.activated.year} ist live**.`;
      await channel.send({ content: ackText, ...mentionOpts() });
    } catch (e) {
      await logError(client, config, e, {
        where: "year-rollover switch-ack send",
        detail: `channel=${ackChannelId}`,
      });
    }
  } else {
    const err = new Error(
      `runYearRollover: Switch-Bestätigung nicht gesendet (kein sendbarer Kanal, targetId=${ackChannelId})`
    );
    await logError(client, config, err, { where: "year-rollover switch-ack" });
  }

  return {
    switched: true,
    archived: res.archived,
    activated: res.activated,
    channel: newChannel?.id || null,
  };
}

/**
 * Nacharbeit nach activateAnnouncedSeason: Kanal anlegen, ID nur bei einem
 * wirklich neuen Kanal in die neue Saison schreiben (die alte ID wird nicht
 * kopiert), Bilanz der archivierten Saison posten.
 */
async function finalizeYearSwitch(client, config, archivedId, newYear, opts = {}) {
  const archived = db.getDb().prepare("SELECT * FROM seasons WHERE id = ?").get(archivedId);
  const oldChannelId =
    opts.oldChannelId !== undefined ? opts.oldChannelId : archived?.deathpool_channel_id || null;
  let newChannel = null;
  let newChannelFailed = false;
  try {
    const created = await createNextSeasonChannel(client, config, newYear, { reuse: true });
    if (created?.id) {
      newChannel = created;
      db.setSeasonDeathpoolChannel(db.getActiveSeason().id, newChannel.id);
    } else if (created?.alreadyExists) {
      newChannel = null;
      newChannelFailed = false;
    } else {
      newChannelFailed = true;
    }
  } catch (e) {
    newChannelFailed = true;
    await logError(client, config, e, {
      where: "year-rollover finalize createChannel",
      detail: `year=${newYear}`,
    });
  }

  const posted = await postReview(client, config, archived, newYear, newChannel?.id || null, {
    live: false,
    fallbackChannelId: oldChannelId,
  });
  return { newChannel, newChannelFailed, posted, oldChannelId };
}

const channelNameHeld = new AsyncLocalStorage();
const channelNameChains = new Map();

/**
 * Eine Promise-Kette pro Kanalname. Reentrant im selben async-Kontext, damit
 * ein äußerer withChannelNameLock (M6) createNextSeasonChannel nicht blockiert.
 */
function withChannelNameLock(name, fn) {
  const key = String(name);
  const held = channelNameHeld.getStore();
  if (held && held.has(key)) return Promise.resolve().then(fn);

  const prev = channelNameChains.get(key) || Promise.resolve();
  const run = prev.then(() => {
    const nextHeld = new Set(held || []);
    nextHeld.add(key);
    return channelNameHeld.run(nextHeld, fn);
  });
  channelNameChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function channelList(all) {
  if (!all) return [];
  if (typeof all.find === "function") return all;
  if (typeof all.values === "function") return [...all.values()];
  if (Array.isArray(all)) return all;
  return [];
}

function findExactTextChannel(all, name) {
  const list = channelList(all);
  const pred = (c) => c && c.name === name && c.type === ChannelType.GuildText;
  if (typeof list.find === "function") return list.find(pred) || null;
  for (const c of list) if (pred(c)) return c;
  return null;
}

/**
 * Erstellt den Textkanal `deathpool-{year}` oder verwendet ihn wieder.
 * Guild nur über config.discordGuildId. Fetch-Fehler und unavailable: kein Create.
 */
async function createNextSeasonChannel(client, config, year, { reuse = true } = {}) {
  const name = `deathpool-${year}`;
  return withChannelNameLock(name, () => createNextSeasonChannelLocked(client, config, year, name, reuse));
}

async function createNextSeasonChannelLocked(client, config, year, name, reuse) {
  if (!config?.discordGuildId) {
    const err = new Error("Keine Guild (DISCORD_GUILD_ID fehlt) — Kanal-Erstellung übersprungen");
    await logError(client, config, err, {
      where: "year-rollover createChannel guild",
      detail: "guild=none",
    });
    return { channel: null, failed: true };
  }
  if (typeof client?.guilds?.fetch !== "function") {
    const err = new Error("Guild-Fetch nicht verfügbar — Kanal-Erstellung übersprungen");
    await logError(client, config, err, {
      where: "year-rollover createChannel guild",
      detail: `guild=${config.discordGuildId}`,
    });
    return { channel: null, failed: true };
  }

  let guild;
  try {
    guild = await client.guilds.fetch(config.discordGuildId);
  } catch (e) {
    await logError(client, config, e, {
      where: "year-rollover createChannel guild",
      detail: `guild=${config.discordGuildId}`,
    });
    return { channel: null, failed: true };
  }
  if (!guild || guild.available === false) {
    const err = new Error(
      guild ? "Guild nicht verfügbar — Kanal-Erstellung übersprungen" : "Guild nicht gefunden — Kanal-Erstellung übersprungen"
    );
    await logError(client, config, err, {
      where: "year-rollover createChannel guild",
      detail: `guild=${guild?.id || config.discordGuildId} available=${guild ? guild.available : "missing"}`,
    });
    return { channel: null, failed: true };
  }

  let existing = null;
  try {
    const all = await guild.channels.fetch();
    existing = findExactTextChannel(all, name);
  } catch (e) {
    await logError(client, config, e, {
      where: "year-rollover createChannel fetch",
      detail: `guild=${guild.id} name=${name}`,
    });
    return { channel: null, failed: true };
  }

  if (existing) {
    if (!reuse) {
      return { channel: null, alreadyExists: true, existing };
    }
    console.log(`[year-rollover] Kanal ${name} existiert bereits`);
    await syncChannelOverwrites(client, existing, config);
    return existing;
  }

  const overwrites = currentPlayerOverwrites();
  let channel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      topic: `Deathpool ${year} — Greggs Liste. Wer diesen Kanal sieht, ist dabei. Wer ihn nicht sieht, ist raus.`,
    });
  } catch (e) {
    await logError(client, config, e, {
      where: "year-rollover createChannel create",
      detail: `guild=${guild.id} name=${name}`,
    });
    throw e;
  }

  await logEvent(client, config, {
    kind: "season-channel-created",
    summary: `Kanal ${name} erstellt (${overwrites.length} Spieler eingeladen)`,
    userId: config.adminId,
    detail: `guild=${guild.id} players=${overwrites.length}`,
  });
  return channel;
}

/** Aktuelle Spielerliste als permissionOverwrites. allow ist ein String-Array. */
function currentPlayerOverwrites() {
  const players = db.getDb().prepare("SELECT discord_user_id, display_name FROM players").all() || [];
  return players
    .filter((p) => p.discord_user_id)
    .map((p) => ({
      id: String(p.discord_user_id),
      type: 1,
      allow: ["ViewChannel", "SendMessages"],
    }));
}

function listOverwrites(channel) {
  const cache = channel?.permissionOverwrites?.cache;
  if (!cache) return [];
  if (typeof cache.values === "function") return [...cache.values()];
  if (Array.isArray(cache)) return cache;
  return [];
}

function keepOverwrite(o) {
  const entry = { id: o.id };
  if (o.type != null) entry.type = o.type;
  if (o.allow != null) entry.allow = o.allow;
  if (o.deny != null) entry.deny = o.deny;
  return entry;
}

/**
 * Ein channel.edit mit Spieler-Overwrites im Array-Format plus bestehenden
 * Overwrites, die keine Spieler sind. Wirft das Edit, bleibt der Kanal.
 */
async function syncChannelOverwrites(client, channel, config) {
  const desired = currentPlayerOverwrites();
  const playerIds = new Set(desired.map((d) => String(d.id)));
  const kept = listOverwrites(channel)
    .filter((o) => o && !playerIds.has(String(o.id)))
    .map(keepOverwrite);
  const permissionOverwrites = [...kept, ...desired];
  if (typeof channel?.edit !== "function") {
    const err = new Error("syncChannelOverwrites: channel.edit fehlt");
    console.error("[year-rollover] syncChannelOverwrites failed:", err.message);
    await logError(client, config, err, {
      where: "year-rollover syncChannelOverwrites",
      detail: `channel=${channel?.id}`,
    });
    return false;
  }
  try {
    await channel.edit({ permissionOverwrites });
    return true;
  } catch (e) {
    console.error("[year-rollover] syncChannelOverwrites failed:", e.message);
    await logError(client, config, e, {
      where: "year-rollover syncChannelOverwrites",
      detail: `channel=${channel?.id}`,
    });
    return false;
  }
}

async function loadPreferDmUser(client, config) {
  if (!config?.adminId || typeof client?.users?.fetch !== "function") return null;
  try {
    const u = await client.users.fetch(config.adminId);
    if (!u?.createDM) return null;
    return u;
  } catch (e) {
    console.warn("[year-rollover] admin user fetch failed:", e.message);
    return null;
  }
}

/**
 * Erinnerung an den Admin (01.11. & 01.12. und Nachhol im Nov/Dez), solange
 * keine announced-Saison existiert. preferDmUser wird immer mitgegeben.
 * Meta reminder_announce_${jahr} erst, wenn sendAdmin eine Nachricht liefert.
 */
async function remindAdminToAnnounce(client, config) {
  const announced = db.getAnnouncedSeason();
  if (announced) return { reminded: false, reason: "already-announced" };

  const running = db.getActiveSeason();
  const target = nextYear(running);
  const prefix = config.prefix ?? "!";
  const text =
    `⚰️ **Erinnerung:** Die Runde **${target}** ist noch nicht eröffnet. Die Zeit des Todes naht, die Namen nicht.\n` +
    `Bis zum 01.01. (Zeitzone des Bots): \`/announce-season announce_channel:#Kanal\` oder \`${prefix}announce-season #Kanal\`.\n` +
    `Ohne diese Eröffnung gibt es am Jahreswechsel keinen neuen Kanal.`;

  const preferDmUser = await loadPreferDmUser(client, config);
  const delivered = await sendAdmin({ client, config }, text, { preferDmUser });
  if (!delivered) {
    const err = new Error(
      "remindAdminToAnnounce: kein Ziel (kein CHANNEL_ADMIN und Admin-DM fehlgeschlagen)"
    );
    await logError(client, config, err, { where: "remindAdminToAnnounce" });
    return { reminded: false, reason: "no-target", target };
  }

  const year = calendarYearString(new Date(), config.tz || "Europe/Vienna");
  db.setMeta(`reminder_announce_${year}`, "sent");

  await logEvent(client, config, {
    kind: "admin-reminder",
    summary: `Erinnerung: Runde ${target} noch nicht eröffnet`,
    userId: config.adminId,
  });
  return { reminded: true, reason: "sent", target, message: delivered };
}

/**
 * Am Tag vor announced.start_date, 18:00 in config.tz: eine DM pro Spieler,
 * dessen Draft nicht finalized ist. Kein Saisonwechsel.
 */
async function remindUnfinalizedDrafts(client, config, now = null) {
  const tz = config.tz || "Europe/Vienna";
  const instant = now == null ? new Date() : now;
  const today = calendarDate(instant, tz);
  const tomorrow = addCalendarDays(today, 1);
  const announced = db.getAnnouncedSeason();
  if (!announced?.start_date) return { reminded: 0, reason: "no-announced" };
  if (String(announced.start_date) !== tomorrow) {
    return { reminded: 0, reason: "not-eve", tomorrow, start: announced.start_date };
  }

  const rows =
    db
      .getDb()
      .prepare(
        `SELECT p.discord_user_id AS user_id, d.season_id AS season_id
         FROM pick_drafts d
         INNER JOIN players p ON p.id = d.player_id
         WHERE d.season_id = ? AND d.status != 'finalized' AND p.discord_user_id IS NOT NULL`
      )
      .all(announced.id) || [];

  let reminded = 0;
  const activeBefore = db.getActiveSeason()?.id;
  for (const row of rows) {
    const metaKey = `draft_remind_${row.season_id}_${row.user_id}`;
    if (db.getMeta(metaKey) === "sent") continue;
    try {
      const user = await client.users.fetch(row.user_id);
      const dm = user?.createDM ? await user.createDM() : null;
      if (!dm?.send) throw new Error("draft reminder: DM nicht sendbar");
      const msg = await dm.send({
        content: `Du hast noch nicht \`fertig\` gesagt. Ohne das zählt die Liste am ${announced.start_date} nicht.`,
        ...mentionOpts(),
      });
      if (!msg) continue;
      db.setMeta(metaKey, "sent");
      reminded++;
    } catch (e) {
      console.error("[year-rollover] draft reminder DM failed:", e.message);
      await logError(client, config, e, {
        where: "year-rollover draft reminder",
        detail: `user=${row.user_id} season=${row.season_id}`,
      });
    }
  }
  if (db.getActiveSeason()?.id !== activeBefore) {
    console.error("[year-rollover] draft reminder hat die aktive Saison verändert");
  }
  return { reminded, reason: "done" };
}

function startupAnnounceReminder(client, config) {
  let today;
  try {
    const tz = config.tz || "Europe/Vienna";
    today = calendarDate(new Date(), tz);
  } catch (e) {
    console.error("[year-rollover] startup reminder date failed:", e.message);
    return;
  }
  const month = Number(today.slice(5, 7));
  if (month !== 11 && month !== 12) return;
  let announced = null;
  try {
    announced = db.getAnnouncedSeason();
  } catch (e) {
    console.error("[year-rollover] startup reminder season lookup failed:", e.message);
    return;
  }
  if (announced) return;
  const year = today.slice(0, 4);
  if (db.getMeta(`reminder_announce_${year}`) === "sent") return;
  remindAdminToAnnounce(client, config).catch((e) => {
    console.error("[year-rollover] startup reminder failed:", e.message);
    logError(client, config, e, { where: "year-rollover startup reminder" }).catch((err) => {
      console.error("[year-rollover] could not log startup reminder failure:", err.message);
    });
  });
}

/** Startet den Jahreswechsel-Cron: 1. Januar, 00:00 in config.tz. Wirft nicht. */
function startYearRollover(client, config) {
  const tz = config.tz || "Europe/Vienna";
  const expr = "0 0 1 1 *";
  const remindExpr = "0 0 1 11,12 *";
  const draftExpr = "0 18 * * *";
  try {
    console.log(`[year-rollover] scheduled (cron: ${expr}, tz: ${tz})`);
    cron.schedule(
      expr,
      () => {
        runYearRollover(client, config).catch((e) => {
          console.error("[year-rollover] failed", e.message);
          logError(client, config, e, { where: "year-rollover cron" });
        });
      },
      { timezone: tz }
    );

    console.log(`[year-rollover] reminders scheduled (cron: ${remindExpr}, tz: ${tz})`);
    cron.schedule(
      remindExpr,
      () => {
        remindAdminToAnnounce(client, config).catch((e) => {
          console.error("[year-rollover] reminder failed", e.message);
          logError(client, config, e, { where: "year-rollover reminder cron" });
        });
      },
      { timezone: tz }
    );

    console.log(`[year-rollover] draft reminders scheduled (cron: ${draftExpr}, tz: ${tz})`);
    cron.schedule(
      draftExpr,
      () => {
        remindUnfinalizedDrafts(client, config).catch((e) => {
          console.error("[year-rollover] draft reminder failed", e.message);
          logError(client, config, e, { where: "year-rollover draft reminder cron" });
        });
      },
      { timezone: tz }
    );
  } catch (e) {
    console.error("[year-rollover] cron.schedule failed:", e && e.message ? e.message : e);
    logError(client, config, e, { where: "year-rollover cron.schedule" }).catch((err) => {
      console.error("[year-rollover] could not log cron.schedule failure:", err.message);
    });
  }

  try {
    startupAnnounceReminder(client, config);
  } catch (e) {
    console.error("[year-rollover] startup reminder failed:", e.message);
    logError(client, config, e, { where: "year-rollover startup reminder" }).catch((err) => {
      console.error("[year-rollover] could not log startup reminder failure:", err.message);
    });
  }

  return { expr, remindExpr, draftExpr, timezone: tz };
}

module.exports = {
  runYearRollover,
  startYearRollover,
  finalizeYearSwitch,
  formatSeasonReviewText,
  remindAdminToAnnounce,
  remindUnfinalizedDrafts,
  createNextSeasonChannel,
  withChannelNameLock,
  nextYear,
  todayInVienna,
  isNewYearDayVienna,
};
