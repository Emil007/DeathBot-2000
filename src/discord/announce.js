const { EmbedBuilder } = require("discord.js");
const db = require("../db");
const { pickPhrase } = require("../phrases");
const { fetchBestImage } = require("../wiki/page-image");
const { normalizeWikiUrl } = require("../wiki/page-lookup");
const log = require("./log");
const {
  fetchDeathBrief,
  resolveDeathImage,
  personNameFromText,
  normalizeName,
  parseDeathDateText,
  stripTrailingDeathDate,
} = require("../wiki/death-brief");

// ANNAHME: M1 (time.js, safe-text.js) ist in diesem Workspace noch nicht gemerged.
// Die echten Module gewinnen, sobald sie da sind. Bis dahin gelten dieselben Verträge.
const timeApi = loadTimeApi();
const { parseCalendarDate, calendarDate } = timeApi;
const { sanitizeDisplayName, mentionOpts } = loadSafeText();

const CHANNEL_LOG_CODES = new Set([10003, 50001, 50013]);

function loadTimeApi() {
  try {
    const t = require("../db/time");
    if (typeof t.parseCalendarDate === "function" && typeof t.calendarDate === "function") return t;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return { parseCalendarDate: parseCalendarDateFallback, calendarDate: calendarDateFallback };
}

function loadSafeText() {
  try {
    const t = require("./safe-text");
    if (typeof t.sanitizeDisplayName === "function" && typeof t.mentionOpts === "function") return t;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return {
    sanitizeDisplayName: sanitizeDisplayNameFallback,
    mentionOpts: () => ({ allowedMentions: { parse: [] } }),
  };
}

function parseCalendarDateFallback(s) {
  if (typeof s !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return s;
}

function calendarDateFallback(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      map[part.type] = part.value;
    }
  }
  return `${map.year}-${String(map.month).padStart(2, "0")}-${String(map.day).padStart(2, "0")}`;
}

function sanitizeDisplayNameFallback(raw) {
  const unnamed = "\u201EUnbenannt\u201C";
  let s = raw == null ? "" : String(raw);
  s = s.replace(/\p{Cc}/gu, "");
  s = s.replace(/[\u2028\u2029]/g, "");
  s = s.replace(/[*_~|`<>@()[\]]/g, "");
  s = s.replace(/\s+/gu, " ").trim();
  const chars = Array.from(s);
  if (chars.length > 80) s = chars.slice(0, 80).join("").trim();
  return s || unnamed;
}

function emojiBanner(config) {
  return Array(config.alertEmojiRepeat).fill(config.alertEmoji).join(" ");
}

/** Format "8. Oktober 2026" from entry.{day,month,year} — month from entry or now. */
function formatDeathDate(entry) {
  if (!entry || entry.day == null) return null;
  const month = entry.month != null ? entry.month : new Date().getMonth();
  const year = entry.year || new Date().getFullYear();
  const MONTHS_DE = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  return `${entry.day}. ${MONTHS_DE[month] || ""} ${year}`;
}

/**
 * "YYYY-MM-DD" from an entry's scraped death date. Month is 0-based.
 * Only a calendar date that parseCalendarDate accepts is returned, so
 * day 31 in a short month is null.
 */
function entryDeathDateIso(entry) {
  if (!entry || entry.day == null || entry.month == null || entry.year == null) return null;
  const y = Number(entry.year);
  const m = Number(entry.month) + 1;
  const d = Number(entry.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return parseCalendarDate(iso);
}

function detectionDay(config) {
  const tz = config?.tz || "Europe/Vienna";
  try {
    return calendarDate(new Date(), tz);
  } catch {
    return calendarDate(new Date(), "UTC");
  }
}

function discordCode(err) {
  const raw = err?.code ?? err?.rawError?.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isUnavailableError(err) {
  if (!err) return false;
  if (err.unavailable === true) return true;
  const status = Number(err.status ?? err.httpStatus ?? err.response?.status);
  if (status === 429 || (Number.isFinite(status) && status >= 500)) return true;
  const code = err.code;
  if (
    code === 429 ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("timeout") || msg.includes("timed out");
}

function guildUnavailable(client) {
  const cache = client?.guilds?.cache;
  if (!cache || typeof cache.values !== "function") return false;
  for (const guild of cache.values()) {
    if (guild && guild.available === false) return true;
  }
  return false;
}

async function noteChannelError(client, config, err, where) {
  const code = discordCode(err);
  if (!CHANNEL_LOG_CODES.has(code)) return;
  try {
    await log.logError(client, config, err, { where });
  } catch (e) {
    console.error("[announce] logError failed", e.message);
  }
}

function attachChannelFailure(err, channelId) {
  const error = err instanceof Error ? err : new Error(String(err?.message || err || "Kanal nicht erreichbar"));
  error.channelId = channelId ?? null;
  const code = discordCode(err);
  if (code != null) error.code = code;
  if (isUnavailableError(err)) error.unavailable = true;
  return error;
}

/**
 * Fetch a text channel or throw. The error carries channelId and the Discord
 * code. 429/5xx/timeout and an unavailable guild are unavailable, not "no channel".
 */
async function requireTextChannel(client, channelId, config, where) {
  if (guildUnavailable(client)) {
    const err = new Error("Discord nicht erreichbar");
    err.channelId = channelId ?? null;
    err.code = null;
    err.unavailable = true;
    throw err;
  }
  if (channelId == null || channelId === "") {
    const err = new Error("Kanal fehlt");
    err.channelId = null;
    err.code = null;
    throw err;
  }
  if (typeof client?.channels?.fetch !== "function") {
    const err = new Error("Discord nicht erreichbar");
    err.channelId = channelId;
    err.code = null;
    err.unavailable = true;
    throw err;
  }
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (e) {
    await noteChannelError(client, config, e, where);
    throw attachChannelFailure(e, channelId);
  }
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
    const err = new Error("Kanal ist kein Textkanal");
    err.channelId = channelId;
    err.code = null;
    throw err;
  }
  return channel;
}

async function sendPayload(channel, channelId, payload, client, config, where) {
  try {
    return await channel.send({ ...payload, ...mentionOpts() });
  } catch (e) {
    await noteChannelError(client, config, e, where);
    throw attachChannelFailure(e, channelId);
  }
}

function wikiMarkdown(url, label) {
  const norm = normalizeWikiUrl(url);
  if (!norm?.url) return null;
  return `[${label}](${norm.url})`;
}

function readCeleb(id) {
  try {
    return db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(id) || null;
  } catch {
    return null;
  }
}

function isBeforeSeason(diedAt, startDate) {
  const died = parseCalendarDate(diedAt == null ? "" : String(diedAt));
  const start = parseCalendarDate(startDate == null ? "" : String(startDate));
  if (!died || !start) return false;
  return died < start;
}

/** Drei Null-Fälle. Die Formel (=100−Alter) steht nur im dritten. */
function pointsLine(age, score, diedAt, startDate) {
  if (age == null || age === "" || (typeof age === "number" && Number.isNaN(age))) {
    // F27: unbekanntes Alter ist NICHT automatisch 0 Punkte — der echte Wert
    // kommt aus der Buchung (age_at_pick). Ein fester „0 Punkte"-Hinweis wäre
    // irreführend, wenn die DB doch einen Wert vergibt.
    return "Alter unbekannt.";
  }
  if (isBeforeSeason(diedAt, startDate)) return "Vor dem Saisonstart → 0 Punkte.";
  return `Alter (Pool-Start): **${age}** → Punkte **${score}** (=100−Alter). Jünger war profitabler.`;
}

function callDbFn(name, ...args) {
  const fn = db[name];
  if (typeof fn !== "function") return false;
  fn(...args);
  return true;
}

async function deliverDeathpoolCard(client, config, { celeb, entry, wikiAge, awards, score, age, diedAt }) {
  const channelId = db.resolveDeathpoolChannel(config);
  const channel = await requireTextChannel(client, channelId, config, "deathpool");
  const season = (() => {
    try {
      return db.getActiveSeason();
    } catch {
      return null;
    }
  })();
  const safeName = sanitizeDisplayName(celeb.name);
  const awardList = Array.isArray(awards) ? awards : [];
  const winnerNames = awardList
    .map((a) => sanitizeDisplayName(a.player?.display_name))
    .filter(Boolean);
  const scoreLines = awardList.map((a) => {
    const who = sanitizeDisplayName(a.player?.display_name);
    return `**${who}** +${a.points} (Gesamt **${a.total}**)`;
  });
  const roast = pickPhrase(config, db, {
    name: safeName,
    age,
    score,
    winners: winnerNames.length ? winnerNames.join(", ") : "niemand",
  });
  const ageLine = pointsLine(age, score, diedAt, season?.start_date);
  const wikiAgeLine =
    wikiAge != null && wikiAge !== age ? `Alter (Wiki-Text): ${wikiAge}` : null;
  const link = wikiMarkdown(entry?.url, "Wikipedia");

  const embed = new EmbedBuilder()
    .setColor(0x1a1a1a)
    .setTitle(`${safeName} ist tot`)
    .setDescription(roast)
    .addFields(
      {
        name: "Details",
        value: [ageLine, wikiAgeLine, link].filter(Boolean).join("\n"),
      },
      {
        name: "Deathpool",
        value: scoreLines.length
          ? scoreLines.join("\n")
          : "_Keiner hatte diesen Namen. Keine Punkte._",
      }
    )
    .setTimestamp(new Date());

  const image =
    (await fetchBestImage(
      celeb.wiki_url || (entry?.lang === "en" ? entry.url : null),
      celeb.wiki_url_de || (entry?.lang === "de" ? entry.url : null) || entry?.url,
      config.userAgent
    )) || null;
  if (image) embed.setThumbnail(image);

  await sendPayload(
    channel,
    channelId,
    {
      content: `${emojiBanner(config)} **Treffer** — Promi beerdigt, Tipp gepunktet`,
      embeds: [embed],
    },
    client,
    config,
    "deathpool"
  );
}

/**
 * Apply death + optional public announce.
 * Uses age_at_pick for scoring (100 - age), not wiki age.
 * applyDeath läuft nur, solange is_alive noch 1 ist. skipped: nichts senden, nicht werfen.
 * Der Stempel folgt erst dem erfolgreichen Send.
 */
async function processDeathpoolHit(
  client,
  config,
  { celeb, entry, wikiAge },
  { announce = true, confirmed = false, source = "wiki" } = {}
) {
  const fresh = readCeleb(celeb?.id) || celeb;
  const diedAt = entryDeathDateIso(entry) || detectionDay(config);
  if (Number(fresh?.is_alive) !== 1) {
    return {
      celeb: fresh,
      awards: [],
      score: 0,
      age: fresh?.age_at_pick ?? null,
      announced: false,
    };
  }

  const result = db.applyDeath(celeb.id, {
    confirmed,
    source,
    diedAt,
    wikiUrl: entry?.url || null,
  });
  if (result?.skipped || !announce) return result;

  await deliverDeathpoolCard(client, config, {
    celeb: result.celeb || fresh,
    entry,
    wikiAge,
    awards: result.awards,
    score: result.score,
    age: result.age,
    diedAt: result.celeb?.died_at || diedAt,
  });
  const announced = callDbFn("markDeathAnnounced", celeb.id);
  return { ...result, announced };
}

function cardModelFromCeleb(celeb) {
  const season = db.getActiveSeason();
  const winners = db.getWinnersForCeleb(celeb.id, season.id);
  const awardRows = db
    .getDb()
    .prepare(
      `SELECT player_id, points FROM death_awards
       WHERE celeb_id = ? AND (season_id = ? OR season_id IS NULL)`
    )
    .all(celeb.id, season.id);
  const pointsByPlayer = new Map(awardRows.map((row) => [row.player_id, row.points]));
  const awards = winners.map((player) => ({
    player,
    points: pointsByPlayer.has(player.id) ? pointsByPlayer.get(player.id) : 0,
    total: db.playerTotal(player.id),
  }));
  let age = celeb.age_at_pick;
  if (awards.length) {
    const pick = db
      .getDb()
      .prepare(
        "SELECT age_at_pick FROM picks WHERE celeb_id = ? AND player_id = ? AND season_id = ?"
      )
      .get(celeb.id, awards[0].player.id, season.id);
    age = pick?.age_at_pick ?? celeb.age_at_pick;
  }
  const score = awards.length ? awards[0].points : age != null ? db.scoreForAge(age) : 0;
  return {
    awards,
    score: awards.length ? score : 0,
    age,
    diedAt: celeb.died_at,
    wikiAge: null,
    entry: {
      url: celeb.death_list_url || celeb.wiki_url || null,
      lang: "en",
    },
  };
}

/**
 * Bereits gebuchte Tode nachreichen. Kein applyDeath.
 * Ein Kartenfehler überspringt nur diese Karte. Stempel erst nach Send.
 */
async function replayUnannounced(client, config) {
  if (typeof db.listUnannouncedDeaths !== "function") return { sent: 0, failed: 0 };
  const rows = db.listUnannouncedDeaths() || [];
  if (!rows.length) return { sent: 0, failed: 0 };
  const channelId = db.resolveDeathpoolChannel(config);
  await requireTextChannel(client, channelId, config, "replayUnannounced");
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const celeb = row?.celeb || row;
    if (!celeb?.id) continue;
    try {
      const model = cardModelFromCeleb(celeb);
      await deliverDeathpoolCard(client, config, { celeb, ...model });
      callDbFn("markDeathAnnounced", celeb.id);
      sent++;
    } catch (e) {
      failed++;
      console.error("[announce] replay", celeb.id, e.message);
    }
  }
  return { sent, failed };
}

async function announceRetraction(client, config, { celeb, awards } = {}) {
  const channelId = db.resolveDeathpoolChannel(config);
  const channel = await requireTextChannel(client, channelId, config, "announceRetraction");
  const name = sanitizeDisplayName(celeb?.name);
  const list = Array.isArray(awards) ? awards : [];
  const lines = list.map((a) => {
    if (a.player?.display_name) {
      const total = a.total != null ? a.total : db.playerTotal(a.player.id);
      return `**${sanitizeDisplayName(a.player.display_name)}** −${a.points} (Gesamt **${total}**)`;
    }
    const player = db.getDb().prepare("SELECT * FROM players WHERE id = ?").get(a.player_id);
    if (!player) return `Spieler ${a.player_id} −${a.points}`;
    return `**${sanitizeDisplayName(player.display_name)}** −${a.points} (Gesamt **${db.playerTotal(player.id)}**)`;
  });

  await sendPayload(
    channel,
    channelId,
    {
      content: [
        `↩️ **Fehlalarm** — ${name} steht nicht mehr zuverlässig auf den Wiki-Todeslisten.`,
        `Widerruf innerhalb von ${config.deathConfirmDays} Tagen. Punkte zurückgebucht:`,
        lines.length ? lines.join("\n") : "_keine Punkte_",
      ].join("\n"),
    },
    client,
    config,
    "announceRetraction"
  );
  // Wirft der Stempel, bleibt retract_pending 1 (M3 setzt das Flag in retractDeath).
  callDbFn("markRetractionAnnounced", celeb.id);
}

async function announceAllDeath(client, config, entry, { isDeOnly = false, brief: preBrief = null } = {}) {
  const channelId = config.channelAllDeaths;
  const channel = await requireTextChannel(client, channelId, config, "announceAllDeath");

  // redName: the person has no own article — pageUrl only produced the image.
  // The card is built from the death-list entry; description shows the beruf
  // (the most useful line we have) and Kurzinfo must not repeat it.
  const redName = !!(entry && entry.redName);

  // M2: ein bereits im Poll aufgelöster brief (qid, isHuman, pageMissing) wird
  // wiederverwendet statt doppelt gefetcht zu werden. Sonst wie bisher.
  const brief =
    preBrief ||
    (await fetchDeathBrief(entry.url, config.userAgent, {
      listText: entry.text,
      beruf: entry.beruf || null,
      redName: !!entry.redName,
    }));

  // If the linked article is NOT a person (band/org, e.g. "Died Pretty" for
  // Chris Welsh), keep the human name from the death-list line as card title.
  const listName = personNameFromText(entry.text);
  const cardNameRaw =
    brief.isHuman === false && listName
      ? listName
      : brief.name || listName;
  const name = sanitizeDisplayName(cardNameRaw);

  const detailLines = [];
  // Death date always goes into the Kurzinfo: use the scraped day/month/year
  // flags first, else parse the death-line text itself ("…, 8. Oktober") with
  // the page-URL year as default.
  const textDate = parseDeathDateText(entry.text);
  const deathDateStr =
    formatDeathDate(entry) ||
    (textDate ? formatDeathDate({ year: entry.year, ...textDate }) : null);
  if (deathDateStr) detailLines.push(`Gestorben: **${deathDateStr}**`);
  if (brief.lifespan || brief.age != null) {
    detailLines.push(
      [
        brief.lifespan,
        brief.age != null ? `gestorben mit **${brief.age}**` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    );
  } else if (brief.age != null) {
    detailLines.push(`Alter: **${brief.age}**`);
  }
  if (brief.knownFor && !(redName && !brief.summary)) {
    detailLines.push(`Bekannt für: ${brief.knownFor}`);
  }

  // Death-list blurb minus leading "Name, age," — extra context (country, role).
  // Strip the death-line name first: the article title (card name) can differ.
  let listNote = null;
  if (entry.text) {
    let rest = String(entry.text)
      .replace(/\[\d+\]/g, "")
      .replace(/[\u200b-\u200f\u00ad\ufeff]/g, "")
      .trim();
    for (const n of [listName, cardNameRaw]) {
      if (!n) continue;
      // listName has trailing artifacts (†, ", orphan diacritics) removed
      const nameRe = new RegExp(
        `^\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\u0300-\\u036f*†‡"'+]*\\s*`,
        "i"
      );
      if (nameRe.test(rest)) {
        rest = rest.replace(nameRe, "");
        break;
      }
    }
    rest = rest.replace(/^[,:\-–]\s*/, "");
    rest = rest.replace(/^\(?\s*\d{2,3}\s*\)?\s*[,;]?\s*/, "").trim();
    // The Gestorben line already shows the date: no trailing "…, 8. Oktober".
    if (deathDateStr) rest = stripTrailingDeathDate(rest);
    const sameAs = (s) => rest.toLowerCase() === String(s || "").toLowerCase();
    if (rest.length >= 12 && !sameAs(brief.summary) && !sameAs(brief.knownFor)) {
      listNote = rest.length > 220 ? rest.slice(0, 219).trim() + "…" : rest;
    }
  }

  const description =
    brief.summary ||
    (redName ? brief.knownFor : null) ||
    listNote ||
    "_Neuer Eintrag auf der Wikipedia-Todesliste._";

  // F05: Das Link-Feld zeigt NUR auf eine Personen-Seite (isHuman + Seite
  // vorhanden). Band-/Org-/Sammelseiten und fehlende Artikel erscheinen dort
  // nie — stattdessen die Listen-URL oder ein Hinweis.
  let linkValue;
  // F19: Personen-URL auch dann, wenn isHuman unklar (== null), solange die
  // Seite existiert und kein Rotlink vorliegt. Nur bei eindeutig Nicht-Mensch
  // oder fehlender Seite auf Liste/kein-Artikel zurückfallen.
  const personLink =
    (brief.isHuman === true || (brief.isHuman == null && !brief.pageMissing && !entry.redName)) &&
    !brief.pageMissing;
  const personUrl = wikiMarkdown(brief.url || entry.url, "Wikipedia");
  const listLink = wikiMarkdown(entry.listUrl, "Wikipedia-Liste");
  if (personLink && personUrl) {
    linkValue = personUrl;
  } else if (listLink) {
    linkValue = listLink;
  } else {
    linkValue = "Kein eigener Wikipedia-Artikel";
  }
  const embed = new EmbedBuilder()
    .setColor(isDeOnly ? 0x3d4f5c : 0x2b3a42)
    .setTitle(isDeOnly ? `🇩🇪 ${name}` : `🌍 ${name}`)
    .setDescription(description)
    .addFields(
      ...(detailLines.length
        ? [{ name: "Kurzinfo", value: detailLines.join("\n").slice(0, 1000) }]
        : []),
      ...(listNote && listNote !== description
        ? [{ name: "Wikipedia-Liste", value: listNote.slice(0, 1000) }]
        : []),
      {
        name: "Link",
        value: linkValue,
      }
    )
    .setTimestamp(new Date());

  const image = await resolveDeathImage(brief, entry, config.userAgent);
  if (image) embed.setThumbnail(image);

  await sendPayload(channel, channelId, { embeds: [embed] }, client, config, "announceAllDeath");

  try {
    const { recordAllDeathAnnounce } = require("./presence");
    await recordAllDeathAnnounce(client, config, db);
  } catch (e) {
    console.warn("[presence] update failed", e.message);
  }
}

async function announceDailySummary(client, config) {
  if (!db.isLive()) return;

  // Der Tagesbericht ist ein sachlicher Überblick über ALLE neuen Todesfälle
  // („Nicht jeder davon stand auf einer Tippliste.“) → gehört in den
  // All-Deaths-Kanal, NICHT in den Deathpool-Kanal.
  const channelId = config.channelAllDeaths;
  const channel = await requireTextChannel(client, channelId, config, "announceDailySummary");

  const rows = db.deathsSinceHours(26);
  if (!rows.length) {
    await sendPayload(
      channel,
      channelId,
      {
        content: "📋 **Tagesbericht** — Seit gestern: keine neuen Tode. Die Sense gähnt.",
      },
      client,
      config,
      "announceDailySummary"
    );
    return;
  }

  // Jede Person genau 1×: EN zuerst, DE nur wenn keine EN-Variante vorliegt.
  const listName = (e) => personNameFromText(e.name) || e.entry_id;
  const normName = (e) => normalizeName(listName(e));
  const en = [];
  const enSeen = new Set();
  for (const r of rows) {
    if (r.lang !== "en") continue;
    const k = normName(r);
    if (enSeen.has(k)) continue;
    enSeen.add(k);
    en.push(r);
  }
  const deOnly = [];
  const deSeen = new Set();
  for (const r of rows) {
    if (r.lang === "en") continue;
    const k = normName(r);
    if (enSeen.has(k)) continue;
    if (deSeen.has(k)) continue;
    deSeen.add(k);
    deOnly.push(r);
  }
  const uniqueTotal = en.length + deOnly.length;
  const link = (e) => {
    const label = sanitizeDisplayName(listName(e));
    const norm = normalizeWikiUrl(e.url);
    if (!norm?.url) return label;
    return `[${label}](<${norm.url}>)`;
  };

  const lines = [];
  lines.push(
    `📋 **Tagesbericht** — ${uniqueTotal} neue Einträge seit gestern. Nicht jeder davon stand auf einer Tippliste.`
  );
  if (en.length) {
    lines.push("");
    lines.push("🌍 **International:**");
    en.slice(0, 20).forEach((e) => lines.push(`• ${link(e)}`));
    if (en.length > 20) lines.push(`… +${en.length - 20}`);
  }
  if (deOnly.length) {
    lines.push("");
    lines.push("🇩🇪 **Nur DE / Regional:**");
    deOnly.slice(0, 15).forEach((e) => lines.push(`• ${link(e)}`));
    if (deOnly.length > 15) lines.push(`… +${deOnly.length - 15}`);
  }

  const MAX = 1900;
  let body = "";
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = body === "" ? lines[i] : `${body}\n${lines[i]}`;
    if (next.length > MAX) {
      for (let j = i; j < lines.length; j++) {
        if (lines[j].startsWith("• ")) omitted++;
      }
      break;
    }
    body = next;
  }
  if (omitted > 0) {
    body += `\n\n… +${omitted} Einträge ausgeblendet (Zeichenlimit)`;
  }

  await sendPayload(channel, channelId, { content: body }, client, config, "announceDailySummary");
}

function formatReconcileSummary(hits, season) {
  const lines = [
    `📋 **Abgleich** (Setup, vor Live — keine Kanal-Ankündigungen)`,
    `Saisonstart: **${season.start_date || "?"}** · Live: **${season.live ? "ja" : "nein"}**`,
    `Neu als tot markiert: **${hits.length}**`,
    "",
  ];
  const mismatches = [];
  for (const h of hits.slice(0, 40)) {
    const awards = h.result?.awards || [];
    const awardStr = awards
      .map((a) => `${sanitizeDisplayName(a.player?.display_name)} +${a.points}`)
      .join(", ");
    const name = sanitizeDisplayName(h.celeb?.name);
    lines.push(
      `💀 **${name}** — Pool-Alter ${h.result?.age ?? "?"} → ${h.result?.score} Punkte` +
        (h.wikiAge != null ? ` (Wiki-Alter ${h.wikiAge})` : "") +
        (awardStr ? ` | ${awardStr}` : " | niemand")
    );
    if (
      h.wikiAge != null &&
      h.result?.age != null &&
      Math.abs(Number(h.wikiAge) - Number(h.result.age)) >= 3
    ) {
      mismatches.push(`${name}: Pool-Alter ${h.result.age} gegen Wiki-Alter ${h.wikiAge}`);
    }
  }
  if (hits.length > 40) lines.push(`… +${hits.length - 40}`);
  if (mismatches.length) {
    lines.push("", "⚠️ Große Lücke Pool-Alter gegen Wiki-Alter:");
    mismatches.slice(0, 15).forEach((m) => lines.push(`• ${m}`));
  }
  lines.push("", "Weiter: `/scores`, danach `/go`, falls noch nicht live.");
  return lines.join("\n").slice(0, 1900);
}

async function announceSimulatedDeath(
  client,
  config,
  {
    name,
    age,
    url,
    urlDe = null,
    inPool = false,
    alreadyDead = false,
    winners = [],
  } = {}
) {
  const channelId = db.resolveDeathpoolChannel(config);
  const channel = await requireTextChannel(client, channelId, config, "announceSimulatedDeath");
  const safeName = sanitizeDisplayName(name);
  const score = age != null ? db.scoreForAge(age) : 0;
  const winnerNames = (winners || [])
    .map((w) => sanitizeDisplayName(w.displayName))
    .filter(Boolean);
  const roast = pickPhrase(config, db, {
    name: safeName,
    age,
    score: score || "—",
    winners: winnerNames.length ? winnerNames.join(", ") : "niemand",
  });
  const ageLine = pointsLine(age, score, null, null);

  let deathpoolValue;
  if (!inPool) {
    deathpoolValue = "_Simulation — nicht im Deathpool (keine Punkte)._";
  } else if (alreadyDead) {
    deathpoolValue = "_Schon tot markiert — Simulation vergibt nichts._";
  } else if (winnerNames.length) {
    deathpoolValue = winnerNames.map((n) => `**${n}** +${score} _(Simulation)_`).join("\n");
  } else {
    deathpoolValue = "_Keiner hatte diesen Namen. Keine Punkte._";
  }

  const embed = new EmbedBuilder()
    .setColor(0x4a0000)
    .setTitle(`${safeName} ist tot`)
    .setDescription(roast)
    .addFields(
      {
        name: "Details",
        value: [ageLine, wikiMarkdown(url, "Wikipedia")].filter(Boolean).join("\n"),
      },
      {
        name: "Deathpool",
        value: deathpoolValue,
      }
    )
    .setTimestamp(new Date());

  const enUrl = url && /en\.wikipedia/i.test(url) ? url : null;
  const deUrl =
    urlDe || (url && /de\.wikipedia/i.test(url) ? url : null) || (!enUrl ? url : null);
  const image = await fetchBestImage(enUrl || url, deUrl, config.userAgent);
  if (image) embed.setThumbnail(image);

  await sendPayload(
    channel,
    channelId,
    {
      content: `${emojiBanner(config)} **Simulation** — Probeleiche, kein DB-Write, keine Pings`,
      embeds: [embed],
    },
    client,
    config,
    "announceSimulatedDeath"
  );
}

module.exports = {
  processDeathpoolHit,
  entryDeathDateIso,
  replayUnannounced,
  announceRetraction,
  announceAllDeath,
  announceDailySummary,
  announceSimulatedDeath,
  formatReconcileSummary,
  announceDeathpool: (client, config, m) =>
    processDeathpoolHit(client, config, { ...m, wikiAge: m.age }, { announce: true, confirmed: false }),
};
