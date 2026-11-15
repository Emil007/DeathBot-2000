const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
} = require("discord.js");
const db = require("../db");
const { logError } = require("../discord/log");
const { resolveAdminTarget } = require("../discord/admin-notify");
const yearRollover = require("./year-rollover");

/**
 * Interaktives Deathpool-Kanal-Setup.
 *
 * Aktive Saison hat schon eine deathpool_channel_id → sofort fertig.
 * Sonst einmalig den Env-Kanal (config.channelDeathpool) verknüpfen, wenn er
 * ein GuildText dieser Guild ist. Sonst Admin-Frage. onDecided feuert erst,
 * wenn ein Zielkanal sicher ist — nicht bei Guild-Ausfall, Fetch-Fehler oder
 * misslungener Anlage.
 *
 * Offene Läufe liegen in setup-state.js (M5). Diese Datei hält kein eigenes
 * openSetups mehr.
 */

const META_KEY = "channel_setup_open";
const RETRY_MS = 30_000;

const setupState = loadSetupState();

/** Saison, deren Frage gerade steht (eine zur Zeit). */
let trackedSeasonId = null;
/** seasonId → onDecided, falls setup-state die Funktion nicht zurückgibt. */
const deciders = new Map();
/** seasonId → zuletzt bestätigter Kanalname (für „Schon erledigt“). */
const recentlyDecided = new Map();
/** seasonId → Dropdown-Rückfrage, zusätzlich am Eintrag. */
const pendingPickBySeason = new Map();
/** Saisons, deren onDecided in diesem Prozess schon lief. */
const decidedSeasonIds = new Set();

const localNameChains = new Map();
let setupChain = Promise.resolve();

let waitGen = 0;
let onceArmed = false;
let onceListener = null;
let waitTimer = null;

function loadSetupState() {
  try {
    return require("./setup-state");
  } catch (e) {
    if (e && (e.code === "MODULE_NOT_FOUND" || e.code === "ERR_MODULE_NOT_FOUND")) {
      // ANNAHME: M5 ist in diesem Workspace noch nicht gemerged. Der Fallback
      // spricht dieselbe Signatur; sobald setup-state.js liegt, wird er benutzt.
      console.warn("[channel-setup] setup-state.js fehlt — Vertrags-Fallback, bis M5 gemerged ist.");
      return createFallbackSetupState();
    }
    throw e;
  }
}

function createFallbackSetupState() {
  const open = new Map();
  return {
    markOpen(seasonId, data) {
      const key = String(seasonId);
      const prev = open.get(key);
      if (prev) {
        Object.assign(prev, data);
        return prev;
      }
      const entry = { deciding: false, pendingPickId: null, ...data };
      open.set(key, entry);
      return entry;
    },
    getOpen(seasonId) {
      return open.get(String(seasonId)) || null;
    },
    isAnyOpen() {
      return open.size > 0;
    },
    clearOpen(seasonId) {
      open.delete(String(seasonId));
    },
    retarget(oldSeasonId, newSeasonId) {
      const oldKey = String(oldSeasonId);
      const newKey = String(newSeasonId);
      if (oldKey === newKey) return open.get(oldKey) || null;
      const entry = open.get(oldKey);
      if (!entry) return open.get(newKey) || null;
      open.delete(oldKey);
      const dest = open.get(newKey);
      if (dest) {
        Object.assign(dest, entry, { deciding: dest.deciding || entry.deciding });
        return dest;
      }
      open.set(newKey, entry);
      return entry;
    },
    tryBeginDecide(seasonId) {
      const entry = open.get(String(seasonId));
      if (!entry || entry.deciding) return false;
      entry.deciding = true;
      return true;
    },
    abortDecide(seasonId) {
      const entry = open.get(String(seasonId));
      if (entry) entry.deciding = false;
    },
    _clearAll() {
      open.clear();
    },
  };
}

let mentionOptsImpl = null;
let mentionOptsLoaded = false;
function mentionOpts() {
  if (!mentionOptsLoaded) {
    mentionOptsLoaded = true;
    try {
      const mod = require("../discord/safe-text");
      if (typeof mod.mentionOpts === "function") mentionOptsImpl = mod.mentionOpts;
    } catch (e) {
      if (e && e.code !== "MODULE_NOT_FOUND" && e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  return mentionOptsImpl ? mentionOptsImpl() : { allowedMentions: { parse: [] } };
}

function lockChannelName(name, fn) {
  const impl =
    typeof yearRollover.withChannelNameLock === "function"
      ? yearRollover.withChannelNameLock
      : fallbackNameLock;
  return Promise.resolve(impl(String(name), fn));
}

function fallbackNameLock(name, fn) {
  const key = String(name);
  const prev = localNameChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  localNameChains.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

function isChannelSetupCustomId(customId) {
  return (
    typeof customId === "string" &&
    (customId === "dp:setup:new" ||
      customId === "dp:setup:pick" ||
      customId.startsWith("dp:setup:use:") ||
      customId.startsWith("dp:setup:pick:"))
  );
}

function isOpen(seasonId) {
  if (seasonId == null) return false;
  return !!setupState.getOpen(String(seasonId));
}

function errorCode(err) {
  if (err == null || typeof err !== "object") return null;
  const raw = err.code ?? err.rawError?.code ?? err.status ?? err.httpStatus ?? null;
  return raw == null ? null : raw;
}

function is10003(err) {
  return Number(errorCode(err)) === 10003;
}

function isMissingPermissions(code) {
  return Number(code) === 50013;
}

function displayChannelName(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[*_~|`<>@[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "Unbenannt";
}

function channelGuildId(channel) {
  if (!channel) return null;
  return channel.guildId || channel.guild?.id || channel.guild_id || null;
}

function isGuildText(channel, guild) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const gid = channelGuildId(channel);
  // Abweichende Guild-Id ist ein fremder Kanal. Fehlt die Id, stammt der
  // Kanal aus dem guild-scoped Fetch (Tests lassen sie oft weg).
  if (guild?.id && gid && String(gid) !== String(guild.id)) return false;
  return true;
}

function normalizeList(fetched) {
  if (!fetched) return [];
  if (Array.isArray(fetched)) return fetched.filter(Boolean);
  if (typeof fetched.values === "function") return [...fetched.values()].filter(Boolean);
  if (typeof fetched.forEach === "function") {
    const out = [];
    fetched.forEach((c) => {
      if (c) out.push(c);
    });
    return out;
  }
  return [];
}

function sortByName(list) {
  return [...list].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "de"));
}

function findNamed(list, needle) {
  const want = String(needle).toLowerCase();
  return list.find((c) => String(c.name || "").toLowerCase() === want) || null;
}

async function loadGuildTextChannels(guild) {
  if (typeof guild?.channels?.fetch !== "function") {
    const err = new Error("guild.channels.fetch fehlt");
    err.unavailable = true;
    throw err;
  }
  const raw = await guild.channels.fetch();
  return normalizeList(raw).filter((c) => isGuildText(c, guild));
}

function asIdSet(raw) {
  if (!raw) return new Set();
  if (raw instanceof Set) return new Set([...raw].map((id) => String(id)));
  if (Array.isArray(raw)) return new Set(raw.map((id) => String(id)));
  return new Set();
}

function deleteSetupMeta() {
  let handle;
  try {
    handle = db.getDb();
  } catch {
    return;
  }
  try {
    handle.prepare("DELETE FROM meta WHERE key = ?").run(META_KEY);
  } catch (e) {
    console.error("[channel-setup] meta delete failed:", e.message);
  }
}

function closeSetup(seasonId) {
  const id = seasonId == null ? trackedSeasonId : String(seasonId);
  if (id) {
    try {
      setupState.clearOpen(id);
    } catch (e) {
      console.error("[channel-setup] clearOpen failed:", e.message);
    }
    deciders.delete(id);
    pendingPickBySeason.delete(id);
  }
  if (!id || trackedSeasonId === id) trackedSeasonId = null;
  deleteSetupMeta();
}

function publishOpen(seasonId, data) {
  const id = String(seasonId);
  if (trackedSeasonId && trackedSeasonId !== id) {
    try {
      setupState.clearOpen(trackedSeasonId);
    } catch {
      /* alte Frage schließen */
    }
    deciders.delete(trackedSeasonId);
    pendingPickBySeason.delete(trackedSeasonId);
  }
  trackedSeasonId = id;
  if (typeof data.onDecided === "function") deciders.set(id, data.onDecided);
  let stored = null;
  try {
    stored = setupState.markOpen(id, data) || null;
  } catch (e) {
    console.error("[channel-setup] markOpen failed:", e.message);
  }
  try {
    db.setMeta(META_KEY, id);
  } catch (e) {
    console.error("[channel-setup] channel_setup_open meta failed:", e.message);
  }
  return stored || setupState.getOpen(id) || data;
}

function retargetEntry(oldId, newId) {
  const from = String(oldId);
  const to = String(newId);
  if (from === to) return to;
  const cb = deciders.get(from);
  const pending = pendingPickBySeason.get(from);
  try {
    setupState.retarget(from, to);
  } catch (e) {
    console.error("[channel-setup] retarget failed:", e.message);
    try {
      setupState.clearOpen(from);
    } catch {
      /* nicht auf die archivierte Id weiterverwenden */
    }
  }
  if (!setupState.getOpen(to) && setupState.getOpen(from)) {
    try {
      setupState.clearOpen(from);
    } catch {
      /* archivierte Zeile nicht beschrieben */
    }
  }
  if (cb) {
    deciders.delete(from);
    deciders.set(to, cb);
  }
  if (pending) {
    pendingPickBySeason.delete(from);
    pendingPickBySeason.set(to, pending);
  }
  trackedSeasonId = to;
  if (setupState.getOpen(to)) {
    try {
      db.setMeta(META_KEY, to);
    } catch (e) {
      console.error("[channel-setup] meta retarget failed:", e.message);
    }
  }
  return to;
}

function disarmWait() {
  waitGen += 1;
  onceArmed = false;
  if (waitTimer) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
  if (onceListener) {
    const { client, handler } = onceListener;
    onceListener = null;
    if (typeof client?.off === "function") client.off("guildAvailable", handler);
    else if (typeof client?.removeListener === "function") client.removeListener("guildAvailable", handler);
  }
}

function armUnavailableRetry(client, config, onDecided) {
  // Einmalig nach guildAvailable, plus ein weiterer Versuch nach 30s,
  // solange die Guild dann verfügbar ist und noch kein Kanal verknüpft ist.
  const gen = waitGen;
  if (!onceArmed && typeof client?.once === "function") {
    onceArmed = true;
    const handler = () => {
      if (gen !== waitGen) return;
      onceArmed = false;
      onceListener = null;
      runDeathpoolChannelSetup(client, config, { onDecided }).catch((e) => {
        console.error("[channel-setup] guildAvailable retry failed:", e.message);
      });
    };
    try {
      client.once("guildAvailable", handler);
      onceListener = { client, handler };
    } catch (e) {
      onceArmed = false;
      console.error("[channel-setup] guildAvailable hook failed:", e.message);
    }
  }
  if (!waitTimer) {
    waitTimer = setTimeout(() => {
      if (gen !== waitGen) return;
      waitTimer = null;
      runDeathpoolChannelSetup(client, config, { onDecided }).catch((e) => {
        console.error("[channel-setup] 30s retry failed:", e.message);
      });
    }, RETRY_MS);
    if (typeof waitTimer.unref === "function") waitTimer.unref();
  }
}

async function replayUnannounced(client, config, where) {
  try {
    const announce = require("../discord/announce");
    if (typeof announce.replayUnannounced === "function") {
      await announce.replayUnannounced(client, config);
    }
  } catch (e) {
    if (e && (e.code === "MODULE_NOT_FOUND" || e.code === "ERR_MODULE_NOT_FOUND")) return;
    console.error(`[channel-setup] replayUnannounced (${where}) failed:`, e.message);
    await logError(client, config, e, { where: `channel-setup replayUnannounced ${where}` });
  }
}

async function callDecided(client, config, onDecided, where, seasonId) {
  const key = seasonId == null ? null : String(seasonId);
  if (key && decidedSeasonIds.has(key)) return;
  if (key) decidedSeasonIds.add(key);
  await replayUnannounced(client, config, where);
  if (typeof onDecided !== "function") return;
  try {
    await onDecided();
  } catch (e) {
    console.error(`[channel-setup] onDecided (${where}) failed:`, e.message);
    await logError(client, config, e, { where: `channel-setup onDecided ${where}` });
  }
}

/**
 * Nur config.discordGuildId. Kein „erste Guild“.
 * available === false oder Fetch-Wurf → unavailable (nichts anlegen).
 */
async function resolveGuild(client, config) {
  if (!config?.discordGuildId) return { guild: null, reason: "no-id" };
  try {
    const guild = await client.guilds.fetch(config.discordGuildId);
    if (!guild) return { guild: null, reason: "missing" };
    if (guild.available === false) return { guild: null, reason: "unavailable" };
    return { guild, reason: "ok" };
  } catch (e) {
    return { guild: null, reason: "unavailable", error: e };
  }
}

async function resolveSetupTarget(client, config) {
  // preferDmUser immer mitgeben, auch wenn CHANNEL_ADMIN gesetzt aber nicht sendbar ist.
  let preferDmUser = null;
  if (config.adminId) {
    try {
      const user = await client.users.fetch(config.adminId);
      if (user?.createDM) preferDmUser = user;
    } catch (e) {
      console.warn("[channel-setup] Admin-User nicht ladbar:", e.message);
    }
  }
  try {
    const channel = await resolveAdminTarget({ client, config }, { preferDmUser });
    if (channel?.send) return channel;
  } catch (e) {
    console.error("[channel-setup] Admin-Ziel fehlgeschlagen:", e.message);
    await logError(client, config, e, { where: "channel-setup resolveSetupTarget" });
  }
  return null;
}

function buildQuestionText({ year, found, textCount }) {
  const lines = [];
  if (found?.name) {
    const name = displayChannelName(found.name);
    lines.push(
      `Hey, da läuft schon eine Season (${year}) und ich hab den Kanal #${name} gefunden — soll ich den nehmen, einen anderen, oder einen neuen machen?`
    );
    lines.push(
      `Drei Wege: \`#${name}\` nehmen, einen anderen Kanal aus der Liste wählen, oder einen neuen anlegen.`
    );
  } else {
    lines.push(
      `Hey, da läuft schon eine Season (${year}) und ich hab keinen Kanal #deathpool-${year} gefunden — soll ich einen aus der Liste nehmen oder einen neuen machen?`
    );
    lines.push(
      `Drei Wege: einen Kanal aus der Liste wählen, #deathpool-${year} neu anlegen, oder mir die Kanal-ID schreiben.`
    );
  }
  if (textCount > 25) {
    lines.push(
      `Es gibt ${textCount} Textkanäle, hier sind die ersten 25 nach Name. Der gesuchte fehlt: schreib mir die Kanal-ID.`
    );
  }
  lines.push("Ohne einen Klick bleibt der Deathpool-Nachhol liegen.");
  return lines.join("\n");
}

function buildQuestion(year, found, textChannels) {
  const sorted = sortByName(textChannels);
  const shown = sorted.slice(0, 25);
  const buttons = [];
  if (found?.id) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`dp:setup:use:${found.id}`)
        .setLabel(`#${found.name} nehmen`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId("dp:setup:new")
      .setLabel("Neuen Kanal anlegen")
      .setStyle(ButtonStyle.Success)
  );
  const rows = [new ActionRowBuilder().addComponents(...buttons)];
  if (shown.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("dp:setup:pick")
      .setPlaceholder(`Anderen Kanal wählen (${sorted.length})`.slice(0, 150))
      .addOptions(
        shown.map((c) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`#${String(c.name || "kanal").slice(0, 99)}`.slice(0, 100))
            .setValue(String(c.id))
        )
      );
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  const offeredChannelIds = new Set(sorted.map((c) => String(c.id)));
  if (found?.id) offeredChannelIds.add(String(found.id));
  return {
    rows,
    offeredChannelIds,
    content: buildQuestionText({ year, found, textCount: sorted.length }),
  };
}

function successText(name) {
  const safe = displayChannelName(name);
  const label = `#${safe}`;
  return (
    `Deathpool-Kanal ist **${label}**. Treffer und die Jahresbilanz gehen dorthin.\n` +
    `Verknüpft: #${safe}. Damit ist die Frage zu.`
  );
}

function createFailureText(year, code) {
  if (isMissingPermissions(code)) return "Mir fehlt das Recht, Kanäle anzulegen.";
  return `Kanal-Anlage für deathpool-${year} fehlgeschlagen (Details in den Logs).`;
}

function alreadyExistsText(name) {
  const safe = displayChannelName(name);
  return `#${safe} gibt es schon. Den nehmen, oder einen anderen aus der Liste. Einen zweiten mit demselben Namen lege ich nicht an.`;
}

function decideName(entry, year) {
  if (entry?.found?.name) return displayChannelName(entry.found.name);
  return `deathpool-${year || entry?.year || ""}`;
}

function noEntryText(active) {
  const id = active?.id == null ? null : String(active.id);
  if (id && recentlyDecided.has(id)) return `Schon erledigt: #${recentlyDecided.get(id)}.`;
  if (active?.deathpool_channel_id) return "Schon erledigt.";
  return "Kanal-Setup ist nicht mehr offen (vermutlich nach einem Neustart). Solange kein Kanal verknüpft ist, kommt die Frage beim nächsten Start wieder.";
}

function interpretCreate(result) {
  if (result == null) {
    return { channel: null, alreadyExists: false, failed: true, existing: null, code: null, error: null };
  }
  const looksLikeEnvelope =
    result.alreadyExists === true ||
    result.failed === true ||
    (Object.prototype.hasOwnProperty.call(result, "channel") && result.type == null && result.name == null);
  if (looksLikeEnvelope) {
    const ch = result.channel && result.channel.id ? result.channel : null;
    return {
      channel: ch,
      alreadyExists: result.alreadyExists === true,
      failed: result.failed === true || (result.alreadyExists !== true && !ch),
      existing: result.existing || null,
      code: result.code ?? result.error?.code ?? null,
      error: result.error || null,
    };
  }
  if (result.id) {
    return { channel: result, alreadyExists: false, failed: false, existing: null, code: null, error: null };
  }
  return { channel: null, alreadyExists: false, failed: true, existing: null, code: null, error: null };
}

/**
 * Fetch zuerst. Wirft er, wird createNextSeasonChannel nicht aufgerufen —
 * die aktuelle Implementierung würde nach einem Fetch-Fehler sonst trotzdem anlegen.
 */
async function provisionChannel(client, config, guild, year, { reuse }) {
  if (!guild || guild.available === false) {
    return { ok: false, unavailable: true, error: new Error("guild unavailable") };
  }
  const needle = `deathpool-${year}`;
  let list;
  try {
    list = await loadGuildTextChannels(guild);
  } catch (error) {
    return { ok: false, unavailable: true, error };
  }
  const before = findNamed(list, needle);
  if (reuse === false && before) {
    try {
      await yearRollover.createNextSeasonChannel(client, config, year, { reuse: false });
    } catch (error) {
      console.error("[channel-setup] createNextSeasonChannel (vorhandener Name):", error.message);
      await logError(client, config, error, {
        where: "channel-setup createNextSeasonChannel",
        detail: `year=${year} reuse=false`,
      });
    }
    return { ok: false, alreadyExists: true, existing: before };
  }
  let raw;
  try {
    raw = await yearRollover.createNextSeasonChannel(
      client,
      config,
      year,
      reuse === false ? { reuse: false } : { reuse: true }
    );
  } catch (error) {
    return { ok: false, error, code: errorCode(error) };
  }
  const parsed = interpretCreate(raw);
  if (parsed.alreadyExists || (before && parsed.channel && String(parsed.channel.id) === String(before.id) && reuse === false)) {
    return { ok: false, alreadyExists: true, existing: before || parsed.existing || parsed.channel };
  }
  if (parsed.failed || !parsed.channel?.id) {
    return { ok: false, error: parsed.error, code: parsed.code ?? errorCode(parsed.error) };
  }
  return { ok: true, channel: parsed.channel };
}

async function linkChannel(client, config, seasonId, channelId, label) {
  let active;
  try {
    active = db.getActiveSeason();
  } catch (e) {
    console.error("[channel-setup] getActiveSeason failed:", e.message);
    await logError(client, config, e, { where: "channel-setup link active season" });
    return { ok: false, seasonId: String(seasonId) };
  }
  if (!active?.id) return { ok: false, seasonId: String(seasonId) };
  const targetId = retargetEntry(seasonId, active.id);
  try {
    db.setSeasonDeathpoolChannel(targetId, String(channelId));
    console.log(`[channel-setup] Deathpool-Kanal ${label} (${channelId}) mit Saison ${targetId} verknüpft`);
    return { ok: true, seasonId: targetId };
  } catch (e) {
    console.error("[channel-setup] setSeasonDeathpoolChannel failed:", e.message);
    await logError(client, config, e, {
      where: "channel-setup link",
      detail: `season=${targetId} channel=${channelId}`,
    });
    return { ok: false, seasonId: targetId };
  }
}

async function finishSetup(seasonId, client, config, linkedName) {
  const id = String(seasonId);
  const cb = deciders.get(id) || setupState.getOpen(id)?.onDecided || null;
  if (linkedName) recentlyDecided.set(id, displayChannelName(linkedName));
  closeSetup(id);
  disarmWait();
  await callDecided(client, config, cb, "decided", id);
}

function plainChannels(list, guild) {
  return list.map((c) => ({
    id: String(c.id),
    name: String(c.name || ""),
    type: c.type,
    guildId: channelGuildId(c) || guild.id,
  }));
}

async function runDeathpoolChannelSetup(client, config, opts = {}) {
  const job = setupChain.then(() => runDeathpoolChannelSetupInner(client, config, opts));
  setupChain = job.then(
    () => {},
    () => {}
  );
  return job;
}

async function runDeathpoolChannelSetupInner(client, config, { onDecided } = {}) {
  try {
    return await runDeathpoolChannelSetupBody(client, config, onDecided);
  } catch (e) {
    console.error("[channel-setup] setup failed:", e.message);
    await logError(client, config, e, { where: "channel-setup" });
    return { mode: "failed", channelId: null };
  }
}

async function runDeathpoolChannelSetupBody(client, config, onDecided) {
  const running = db.getActiveSeason();
  const seasonId = String(running.id);
  const year = running.year;

  if (running.deathpool_channel_id) {
    const cb = (trackedSeasonId && deciders.get(trackedSeasonId)) || onDecided;
    if (trackedSeasonId && setupState.getOpen(trackedSeasonId)) closeSetup(trackedSeasonId);
    else deleteSetupMeta();
    disarmWait();
    await callDecided(client, config, cb, "linked", running.id);
    return { mode: "linked", channelId: running.deathpool_channel_id };
  }

  const guildRes = await resolveGuild(client, config);
  if (guildRes.reason === "no-id" || guildRes.reason === "missing") {
    // ANNAHME: ohne Guild (keine Id oder Fetch liefert null) hängt der Start-Nachhol
    // nicht ewig — onDecided einmal, kein Anlegen. available === false ist das nicht.
    console.warn("[channel-setup] keine Guild gefunden — Deathpool-Kanal-Setup übersprungen");
    deleteSetupMeta();
    disarmWait();
    await callDecided(client, config, onDecided, "no-guild", seasonId);
    return { mode: "no-guild", channelId: null };
  }
  if (guildRes.reason !== "ok") {
    console.warn("[channel-setup] Guild nicht verfügbar — kein Anlegen, onDecided nicht");
    if (guildRes.error) {
      await logError(client, config, guildRes.error, { where: "channel-setup resolveGuild" });
    }
    armUnavailableRetry(client, config, onDecided);
    return { mode: "unavailable", channelId: null };
  }
  const guild = guildRes.guild;

  let textChannels;
  try {
    textChannels = await loadGuildTextChannels(guild);
  } catch (e) {
    console.error("[channel-setup] channels.fetch failed:", e.message);
    await logError(client, config, e, { where: "channel-setup channels.fetch", detail: `guild=${guild.id}` });
    armUnavailableRetry(client, config, onDecided);
    return { mode: "unavailable", channelId: null };
  }

  let forceDialog = false;
  if (!running.deathpool_channel_id && config.channelDeathpool) {
    const envId = String(config.channelDeathpool);
    try {
      const envChannel = await client.channels.fetch(envId);
      if (isGuildText(envChannel, guild)) {
        const linked = await linkChannel(client, config, seasonId, envChannel.id, `#${envChannel.name || envId}`);
        if (linked.ok) {
          const cb = deciders.get(linked.seasonId) || onDecided;
          closeSetup(linked.seasonId);
          disarmWait();
          await callDecided(client, config, cb, "backfill", linked.seasonId);
          return { mode: "linked", channelId: String(envChannel.id) };
        }
      } else {
        forceDialog = true;
      }
    } catch (e) {
      if (is10003(e)) {
        forceDialog = true;
      } else {
        console.error("[channel-setup] Env-Kanal nicht prüfbar:", e.message);
        await logError(client, config, e, {
          where: "channel-setup backfill",
          detail: `channel=${envId}`,
        });
        armUnavailableRetry(client, config, onDecided);
        return { mode: "unavailable", channelId: null };
      }
    }
  }

  if (setupState.getOpen(seasonId)) {
    return { mode: "waiting", channelId: null };
  }

  const needle = `deathpool-${year}`;
  const found = findNamed(textChannels, needle);

  if (!found && !forceDialog) {
    console.log(`[channel-setup] kein #${needle} gefunden — lege Kanal an`);
    const outcome = await lockChannelName(needle, () =>
      provisionChannel(client, config, guild, year, { reuse: true })
    );
    if (outcome.unavailable) {
      if (outcome.error) {
        await logError(client, config, outcome.error, {
          where: "channel-setup createNextSeasonChannel",
          detail: `year=${year}`,
        });
      }
      armUnavailableRetry(client, config, onDecided);
      return { mode: "unavailable", channelId: null };
    }
    if (!outcome.ok || !outcome.channel?.id) {
      console.error("[channel-setup] Kanal-Anlage fehlgeschlagen — kein sicherer Deathpool-Kanal");
      if (outcome.error) {
        await logError(client, config, outcome.error, {
          where: "channel-setup createNextSeasonChannel",
          detail: `year=${year}`,
        });
      }
      return { mode: "failed", channelId: null };
    }
    const name = outcome.channel.name || needle;
    const linked = await linkChannel(client, config, seasonId, outcome.channel.id, `#${name}`);
    if (!linked.ok) return { mode: "failed", channelId: null };
    disarmWait();
    await callDecided(client, config, onDecided, "created", linked.seasonId);
    return { mode: "created", channelId: String(outcome.channel.id) };
  }

  console.log(
    found
      ? `[channel-setup] #${needle} gefunden — Admin-Frage, bis eine Entscheidung fällt`
      : "[channel-setup] Env-Kanal ungültig — Admin-Frage, bis eine Entscheidung fällt"
  );
  const target = await resolveSetupTarget(client, config);
  if (!target) {
    // ANNAHME: kein stilles Verknüpfen, wenn die Frage nicht rausgeht.
    console.error("[channel-setup] kein sendbares Admin-Ziel — Frage nicht gestellt, Kanal nicht verknüpft");
    armUnavailableRetry(client, config, onDecided);
    return { mode: "no-target", channelId: null };
  }

  const foundPlain = found ? { id: String(found.id), name: String(found.name || "") } : null;
  const question = buildQuestion(year, foundPlain, textChannels);
  let sent = null;
  try {
    sent = await target.send({
      content: question.content,
      components: question.rows,
      ...mentionOpts(),
    });
  } catch (e) {
    await logError(client, config, e, { where: "channel-setup send question" });
  }
  if (!sent) {
    console.error("[channel-setup] Admin-Frage nicht gesendet — Kanal nicht verknüpft");
    armUnavailableRetry(client, config, onDecided);
    return { mode: "no-target", channelId: null };
  }

  publishOpen(seasonId, {
    components: question.rows,
    offeredChannelIds: question.offeredChannelIds,
    year,
    onDecided,
    found: foundPlain,
    guildId: String(guild.id),
    textChannels: plainChannels(textChannels, guild),
    pendingPickId: null,
  });
  disarmWait();
  return { mode: "waiting", channelId: null };
}

function memberHasRole(member, roleId) {
  if (!member || roleId == null || roleId === "") return false;
  const want = String(roleId);
  const roles = member.roles;
  if (!roles) return false;
  if (typeof roles.cache?.has === "function") {
    if (roles.cache.has(want) || roles.cache.has(roleId)) return true;
    if (typeof roles.cache.values === "function") {
      for (const role of roles.cache.values()) {
        if (String(role?.id ?? role) === want) return true;
      }
    }
  }
  if (Array.isArray(roles)) return roles.some((role) => String(role?.id ?? role) === want);
  if (Array.isArray(roles.cache)) return roles.cache.some((role) => String(role?.id ?? role) === want);
  if (typeof roles.has === "function" && (roles.has(want) || roles.has(roleId))) return true;
  return false;
}

function isSetupAdmin(interaction, config) {
  const uid = interaction.user?.id;
  if (uid == null || uid === "") return false;
  if (config.adminId && String(uid) === String(config.adminId)) return true;
  if (config.adminRoleId && memberHasRole(interaction.member, config.adminRoleId)) return true;
  return false;
}

async function replyEphemeral(interaction, content) {
  const payload = { content, ephemeral: true, ...mentionOpts() };
  try {
    // Nach einem evtl. vorherigen deferReply ist reply() nicht mehr gültig —
    // dann editReply mit ephemeral:true nutzen.
    if (typeof interaction?.editReply === "function") {
      try {
        await interaction.editReply(payload);
        return;
      } catch {
        /* fallback auf reply */
      }
    }
    if (typeof interaction?.reply === "function") await interaction.reply(payload);
  } catch (e) {
    console.error("[channel-setup] ephemeral reply failed:", e.message);
  }
}

async function updateMessage(interaction, payload) {
  const body = { ...payload, ...mentionOpts() };
  if (typeof interaction?.update === "function") {
    await interaction.update(body);
    return;
  }
  if (typeof interaction?.editReply === "function") {
    await interaction.editReply(body);
    return;
  }
  if (typeof interaction?.reply === "function") await interaction.reply(body);
}

async function editSetupMessage(interaction, payload) {
  const body = { ...payload, ...mentionOpts() };
  if (typeof interaction?.editReply === "function") {
    await interaction.editReply(body);
    return;
  }
  if (typeof interaction?.update === "function") await interaction.update(body);
}

function currentOpen() {
  const active = db.getActiveSeason();
  const activeId = String(active.id);
  let entry = setupState.getOpen(activeId);
  let seasonId = activeId;
  if (!entry && trackedSeasonId && trackedSeasonId !== activeId) {
    const old = setupState.getOpen(trackedSeasonId);
    if (old) {
      retargetEntry(trackedSeasonId, activeId);
      seasonId = activeId;
      entry = setupState.getOpen(activeId) || old;
    }
  }
  return { active, seasonId, entry };
}

function channelNameFromEntry(entry, channelId) {
  const list = entry?.textChannels || [];
  const hit = list.find((c) => String(c.id) === String(channelId));
  if (hit?.name) return displayChannelName(hit.name);
  if (entry?.found && String(entry.found.id) === String(channelId) && entry.found.name) {
    return displayChannelName(entry.found.name);
  }
  return String(channelId);
}

function parseAction(customId, interaction) {
  if (customId === "dp:setup:new") return { kind: "new" };
  if (customId.startsWith("dp:setup:use:")) {
    return { kind: "use", channelId: customId.slice("dp:setup:use:".length) };
  }
  if (customId === "dp:setup:pick") {
    const chosen = Array.isArray(interaction.values) ? interaction.values[0] : null;
    if (chosen == null || chosen === "") return null;
    if (String(chosen).startsWith("dp:setup:pick:")) return null;
    return { kind: "pick", channelId: String(chosen) };
  }
  return null;
}

async function handleChannelSetupInteraction(interaction, client, config) {
  if (!isChannelSetupCustomId(interaction?.customId)) return false;
  try {
    return await handleChannelSetupInner(interaction, client, config);
  } catch (e) {
    console.error("[channel-setup] interaction failed:", e.message);
    await logError(client, config, e, {
      where: "channel-setup interaction",
      detail: interaction?.customId,
    });
    if (trackedSeasonId) {
      try {
        setupState.abortDecide(trackedSeasonId);
      } catch {
        /* deciding zurück, Frage bleibt */
      }
    }
    return true;
  }
}

async function handleChannelSetupInner(interaction, client, config) {
  const customId = interaction.customId;
  if (!isSetupAdmin(interaction, config)) {
    await replyEphemeral(interaction, "Nur der Admin darf das.");
    return true;
  }

  // Discord-Interactions müssen innerhalb von 3s geackt werden, sonst meldet
  // Discord „hat nicht rechtzeitig reagiert". Der Klick auf „#kanal nehmen"
  // darf nicht erst nach resolveGuild/channels.fetch/linkChannel (mehrere
  // awaits) geackt werden — sofort defernen, danach editReply nutzen.
  try {
    if (typeof interaction?.deferReply === "function") {
      await interaction.deferReply();
    }
  } catch (e) {
    console.error("[channel-setup] deferReply failed:", e.message);
    // Weiter, falls die Interaktion schon anderweitig geackt wurde.
  }

  const { active, seasonId, entry } = currentOpen();
  if (!entry) {
    await replyEphemeral(interaction, noEntryText(active));
    return true;
  }

  // dp:setup:pick:<id> ist kein Schreibweg mehr, auch nicht für angebotene Ids.
  if (customId.startsWith("dp:setup:pick:") && customId !== "dp:setup:pick") {
    await replyEphemeral(interaction, "Kanal-Auswahl nur über die Liste. Nichts verknüpft.");
    return true;
  }

  const action = parseAction(customId, interaction);
  if (!action) {
    await replyEphemeral(interaction, "Kanal-Auswahl nur über die Liste. Nichts verknüpft.");
    return true;
  }

  if (action.kind === "pick") return handlePick(interaction, client, config, entry, seasonId, active, action.channelId);
  if (action.kind === "new") return handleNew(interaction, client, config, entry, seasonId, active);
  return handleLink(interaction, client, config, entry, seasonId, active, action.channelId);
}

async function handlePick(interaction, client, config, entry, seasonId, active, channelId) {
  const id = String(channelId);
  const offered = asIdSet(entry.offeredChannelIds);
  const year = active.year || entry.year;
  if (!offered.has(id)) {
    if (!setupState.tryBeginDecide(String(seasonId))) {
      await replyEphemeral(interaction, `Schon erledigt: #${decideName(entry, year)}.`);
      return true;
    }
    setupState.abortDecide(String(seasonId));
    await replyEphemeral(interaction, "Dieser Kanal war nicht angeboten. Nichts verknüpft.");
    return true;
  }
  const pending = entry.pendingPickId || pendingPickBySeason.get(String(seasonId)) || null;
  if (String(pending || "") !== id) {
    entry.pendingPickId = id;
    pendingPickBySeason.set(String(seasonId), id);
    try {
      setupState.markOpen(String(seasonId), entry);
    } catch (e) {
      console.error("[channel-setup] pending pick merken failed:", e.message);
    }
    const name = channelNameFromEntry(entry, id);
    await replyEphemeral(interaction, `Wirklich #${name} als Deathpool? Dann noch einmal wählen.`);
    return true;
  }
  return handleLink(interaction, client, config, entry, seasonId, active, id);
}

async function handleNew(interaction, client, config, entry, seasonId, active) {
  const year = active.year || entry.year;
  const seasonKey = String(seasonId);
  const components = entry.components || [];
  if (!setupState.tryBeginDecide(seasonKey)) {
    await replyEphemeral(interaction, `Schon erledigt: #${decideName(entry, year)}.`);
    return true;
  }
  const progress = `Lege #deathpool-${year} an. Spieler bekommen Sicht und Schreiben…`;
  try {
    await updateMessage(interaction, { content: progress, components: [] });
  } catch (e) {
    setupState.abortDecide(seasonKey);
    console.error("[channel-setup] update before create failed:", e.message);
    return true;
  }

  const guildRes = await resolveGuild(client, config);
  if (guildRes.reason !== "ok") {
    setupState.abortDecide(seasonKey);
    await editSetupMessage(interaction, {
      content: createFailureText(year, null),
      components,
    });
    if (guildRes.reason === "unavailable") {
      armUnavailableRetry(client, config, deciders.get(seasonKey) || entry.onDecided);
    }
    return true;
  }

  let outcome;
  try {
    outcome = await lockChannelName(`deathpool-${year}`, () =>
      provisionChannel(client, config, guildRes.guild, year, { reuse: false })
    );
  } catch (e) {
    outcome = { ok: false, error: e, code: errorCode(e) };
  }

  if (outcome.alreadyExists) {
    setupState.abortDecide(seasonKey);
    const name = outcome.existing?.name || `deathpool-${year}`;
    console.log(`[channel-setup] #${name} existiert bereits — kein zweiter Kanal, nicht verknüpft`);
    await editSetupMessage(interaction, {
      content: alreadyExistsText(name),
      components,
    });
    return true;
  }
  if (!outcome.ok || !outcome.channel?.id) {
    setupState.abortDecide(seasonKey);
    const code = outcome.code ?? errorCode(outcome.error);
    if (outcome.error) {
      console.error("[channel-setup] Kanal-Anlage fehlgeschlagen:", outcome.error.message || outcome.error);
      await logError(client, config, outcome.error, {
        where: "channel-setup new create",
        detail: `year=${year}`,
      });
    } else {
      console.error(`[channel-setup] Kanal-Anlage für deathpool-${year} fehlgeschlagen`);
    }
    await editSetupMessage(interaction, {
      content: createFailureText(year, code),
      components,
    });
    return true;
  }

  const name = outcome.channel.name || `deathpool-${year}`;
  const linked = await linkChannel(client, config, seasonKey, outcome.channel.id, `#${name}`);
  if (!linked.ok) {
    setupState.abortDecide(seasonKey);
    await editSetupMessage(interaction, {
      content: createFailureText(year, null),
      components,
    });
    return true;
  }
  try {
    await editSetupMessage(interaction, { content: successText(name), components: [] });
  } catch (e) {
    console.error("[channel-setup] success edit failed:", e.message);
  }
  await finishSetup(linked.seasonId, client, config, name);
  return true;
}

async function handleLink(interaction, client, config, entry, seasonId, active, channelId) {
  const year = active.year || entry.year;
  const seasonKey = String(seasonId);
  const id = String(channelId);
  if (!setupState.tryBeginDecide(seasonKey)) {
    await replyEphemeral(interaction, `Schon erledigt: #${decideName(entry, year)}.`);
    return true;
  }
  const offered = asIdSet(entry.offeredChannelIds);
  if (!offered.has(id)) {
    setupState.abortDecide(seasonKey);
    await replyEphemeral(interaction, "Dieser Kanal war nicht angeboten. Nichts verknüpft.");
    return true;
  }

  const guildRes = await resolveGuild(client, config);
  if (guildRes.reason !== "ok") {
    setupState.abortDecide(seasonKey);
    await replyEphemeral(interaction, "Discord-Guild ist gerade nicht erreichbar. Nichts verknüpft. Die Frage bleibt offen.");
    return true;
  }

  let fresh = null;
  try {
    const list = await loadGuildTextChannels(guildRes.guild);
    fresh = list.find((c) => String(c.id) === id) || null;
  } catch (e) {
    setupState.abortDecide(seasonKey);
    if (is10003(e)) {
      await replyEphemeral(interaction, "Diesen Kanal gibt es nicht mehr (10003). Nichts verknüpft.");
      return true;
    }
    console.error("[channel-setup] channels.fetch vor Verknüpfung:", e.message);
    await logError(client, config, e, { where: "channel-setup refetch before link" });
    await replyEphemeral(interaction, "Discord antwortet gerade nicht. Nichts verknüpft. Die Frage bleibt offen.");
    return true;
  }

  if (!fresh) {
    setupState.abortDecide(seasonKey);
    let gone = true;
    try {
      const direct = await client.channels.fetch(id);
      if (direct && isGuildText(direct, guildRes.guild)) gone = false;
    } catch (e) {
      if (is10003(e)) {
        await replyEphemeral(interaction, "Diesen Kanal gibt es nicht mehr (10003). Nichts verknüpft.");
        return true;
      }
      console.error("[channel-setup] channels.fetch vor Verknüpfung:", e.message);
      await logError(client, config, e, { where: "channel-setup refetch before link" });
      await replyEphemeral(interaction, "Discord antwortet gerade nicht. Nichts verknüpft. Die Frage bleibt offen.");
      return true;
    }
    await replyEphemeral(
      interaction,
      gone
        ? "Diesen Kanal gibt es nicht mehr (10003). Nichts verknüpft."
        : "Dieser Kanal ist kein Textkanal dieser Guild. Nichts verknüpft."
    );
    return true;
  }

  const name = displayChannelName(fresh.name || channelNameFromEntry(entry, id));
  const linked = await linkChannel(client, config, seasonKey, fresh.id, `#${name}`);
  if (!linked.ok) {
    setupState.abortDecide(seasonKey);
    await replyEphemeral(interaction, "Die Verknüpfung konnte nicht gespeichert werden (Details in den Logs).");
    return true;
  }
  try {
    await updateMessage(interaction, { content: successText(name), components: [] });
  } catch (e) {
    console.error("[channel-setup] success update failed:", e.message);
  }
  await finishSetup(linked.seasonId, client, config, name);
  return true;
}

function _resetForTest() {
  try {
    if (typeof setupState._clearAll === "function") setupState._clearAll();
    else if (trackedSeasonId) setupState.clearOpen(trackedSeasonId);
  } catch {
    /* Test-Reset */
  }
  trackedSeasonId = null;
  deciders.clear();
  recentlyDecided.clear();
  pendingPickBySeason.clear();
  decidedSeasonIds.clear();
  localNameChains.clear();
  setupChain = Promise.resolve();
  disarmWait();
  deleteSetupMeta();
}

module.exports = {
  runDeathpoolChannelSetup,
  handleChannelSetupInteraction,
  isOpen,
  _resetForTest,
};
