const db = require("../../db");
const { normalizeWikiUrl } = require("../../wiki/page-lookup");

const RETRY_DELAY_MS = 2000;
const SNOWFLAKE = /^\d{16,20}$/;
const UNNAMED = "„Unbenannt“";

const DM_FOREIGN_LIST = "Fremde Listen nur in der Guild — schreib `!liste @User` dort.";

const NOT_REGISTERED =
  "Du bist noch nicht angemeldet. Schreib mir die Namen per DM, oder in der Guild `/picks`. Ein Admin-Import ist dafür nicht nötig.";
const NEED_MENTION = "Nenn die Person als Mention.";

/**
 * M1 liefert sanitizeDisplayName / mentionOpts. Fehlt das Modul in diesem
 * Workspace, gilt derselbe Vertrag lokal, bis die Datei beim Merge da ist.
 */
function loadSafeText() {
  try {
    require.resolve("../safe-text");
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    return null;
  }
  return require("../safe-text");
}

const safeText = loadSafeText();

function fallbackSanitize(raw) {
  let s = String(raw ?? "");
  s = s.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ");
  s = s.replace(/[*_~|`<>@\[\]()]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || UNNAMED;
}

function sanitizeDisplayName(raw) {
  if (typeof safeText?.sanitizeDisplayName === "function") return safeText.sanitizeDisplayName(raw);
  return fallbackSanitize(raw);
}

function mentionOpts() {
  if (typeof safeText?.mentionOpts === "function") return safeText.mentionOpts();
  return { allowedMentions: { parse: [] } };
}

function oneLine(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function acceptedWikiUrl(url) {
  if (!url) return null;
  try {
    const norm = normalizeWikiUrl(url);
    return norm && norm.url ? norm.url : null;
  } catch {
    return null;
  }
}

/**
 * Wiki-URL preview-frei als Text: `<https://…>` (Dispatch mit spitzen Klammern)
 * bleibt klickbar, baut aber KEINEN Discord-Link-Preview auf. Reine URLs
 * würden in Text-Nachrichten (Chunks) automatisch zu Rich-Preview-Einbetungen.
 */
function hideLinkPreview(url) {
  if (!url) return "";
  return `<${acceptedWikiUrl(url)}>`;
}

function is429(err) {
  if (err == null) return false;
  if (typeof err !== "object") return /\b429\b/.test(String(err));
  const status = err.status ?? err.statusCode ?? err.httpStatus ?? err.response?.status ?? err.rawError?.status;
  if (Number(status) === 429) return true;
  if (Number(err.code) === 429) return true;
  if (/RateLimit/i.test(String(err.name || ""))) return true;
  return /\b429\b/.test(String(err.message || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trySend(msg, content, useReply) {
  const payload = { content, ...mentionOpts() };
  if (useReply) await msg.reply(payload);
  else await msg.channel.send(payload);
}

/**
 * Jeder Chunk hat einen eigenen try. Bei 429: 2s warten, genau ein neuer
 * Versuch, dann der nächste Chunk. Gesendete Seiten bleiben stehen.
 */
async function sendChunks(msg, chunks) {
  const failed = [];
  let replied = false;
  for (let i = 0; i < chunks.length; i++) {
    const page = i + 1;
    const content = chunks[i];
    if (!content) continue;
    const send = async () => {
      await trySend(msg, content, !replied);
      replied = true;
    };
    try {
      await send();
      continue;
    } catch (err) {
      if (!is429(err)) throw err;
    }
    await sleep(RETRY_DELAY_MS);
    try {
      await send();
    } catch (err) {
      if (!is429(err)) throw err;
      failed.push(page);
    }
  }
  if (!failed.length) return;
  const notice = failed.map((n) => `Seite ${n} ist nicht raus (Discord-Limit).`).join("\n");
  try {
    await trySend(msg, notice, !replied);
  } catch (err) {
    if (!is429(err)) throw err;
    await sleep(RETRY_DELAY_MS);
    try {
      await trySend(msg, notice, !replied);
    } catch (err2) {
      if (!is429(err2)) throw err2;
    }
  }
}

function chunkLines(header, lines) {
  const chunks = [];
  let body = header || "";
  const flat = [];
  for (const line of lines) {
    for (const part of String(line).split("\n")) flat.push(part);
  }
  for (const line of flat) {
    const piece = line.length > 1800 ? line.slice(0, 1800) : line;
    if (body && (body + piece + "\n").length > 1800) {
      chunks.push(body);
      body = "";
    }
    body += piece + "\n";
  }
  if (body) chunks.push(body);
  return chunks;
}

async function replyText(msg, content) {
  await sendChunks(msg, [content]);
}

/**
 * ANNAHME: findPlayerByQuery liegt bei M3 und kann in diesem Stand noch LIKE.
 * Nach dem Laden der Befehle zählt nur eine Snowflake — "%" trifft niemanden.
 */
function installSnowflakePlayerQuery() {
  if (db.findPlayerByQuery && db.findPlayerByQuery.snowflakeOnly) return;
  const original = db.findPlayerByQuery.bind(db);
  const wrapped = (query) => {
    if (query == null) return null;
    const q = String(query).trim();
    if (!SNOWFLAKE.test(q)) return null;
    return original(q);
  };
  wrapped.snowflakeOnly = true;
  db.findPlayerByQuery = wrapped;
}

installSnowflakePlayerQuery();

/**
 * Letztes Argument ist die Punktzahl. Spieler nur per Mention oder Snowflake.
 * @returns {{ error: "mention" | "usage" } | { snowflake: string, points: number }}
 */
function resolveSnowflakePoints(msg, args) {
  const list = Array.isArray(args) ? args : [];
  const mention = msg.mentions?.users?.first?.() || null;
  let snowflake = null;
  let pointsRaw;
  if (mention?.id && SNOWFLAKE.test(String(mention.id))) {
    snowflake = String(mention.id);
    pointsRaw = list[list.length - 1];
  } else if (list.length >= 2 && SNOWFLAKE.test(String(list[0]).trim())) {
    snowflake = String(list[0]).trim();
    pointsRaw = list[list.length - 1];
  } else {
    return { error: "mention" };
  }
  const points = typeof pointsRaw === "number" ? pointsRaw : parseInt(pointsRaw, 10);
  if (!Number.isInteger(points)) return { error: "usage" };
  return { snowflake, points };
}

function yearSentence(season, safeName) {
  const year = Number(season?.year) || new Date().getFullYear();
  const until = `1.1.${year + 1}`;
  if (!safeName) return `Deine Liste ${year} (läuft bis ${until}).`;
  return `Liste ${safeName} ${year} (läuft bis ${until}).`;
}

function draftSentence(playerId) {
  if (playerId == null || typeof db.getAnnouncedSeason !== "function") return null;
  const announced = db.getAnnouncedSeason();
  if (!announced || typeof db.getDraftForPlayer !== "function") return null;
  const draft = db.getDraftForPlayer(playerId, announced.id);
  if (!draft) return null;
  if (draft.status !== "finalized") {
    return `Für ${announced.year} liegt ein Entwurf, noch nicht mit \`fertig\` eingefroren.`;
  }
  return `Für ${announced.year} liegt ein Entwurf, mit \`fertig\` eingefroren.`;
}

/**
 * Block für den announced-Saison-Entwurf (z.B. 2027): Wenn ein Draft existiert,
 * wird er als eigener Abschnitt über der laufenden Liste angezeigt, damit man
 * „meine 2027-Liste“ vs. „meine 2026-Liste“ direkt sieht. Preview-frei wie die
 * laufende Liste.
 */
function draftBlock(playerId) {
  const announced = db.getAnnouncedSeason();
  if (!announced) return null;
  const draft = db.getDraftForPlayer(playerId, announced.id);
  if (!draft) return null;
  const entries = db.listDraftEntries(draft.id);
  const statusWord =
    draft.status === "finalized" ? "🔒 eingefroren" : draft.status === "draft" ? "noch offen" : draft.status;
  const lines = entries.length
    ? entries.map((e, i) => {
        const name = sanitizeDisplayName(e.resolved_name || e.raw_name);
        let link = "";
        if (e.link_status === "pending") link = " · _suche noch…_";
        else if (e.link_status === "unlinked") link = " · _kein Artikel_";
        else {
          const href = hideLinkPreview(e.wiki_url);
          if (href) link = ` · ${href}`;
          else link = " · _kein Artikel_";
        }
        const age = e.proposed_age != null ? ` (${e.proposed_age})` : "";
        return `${i + 1}. **${name}**${age}${link}`;
      })
    : ["_(noch keine Namen)_"];
  return {
    title: `**📋 Dein ${announced.year}-Entwurf** (Start ${announced.start_date || "?"} — ${statusWord})`,
    body: lines.join("\n"),
  };
}

function pickLine(c) {
  const flag = c.is_alive ? "🟢" : "💀";
  const name = sanitizeDisplayName(c.name);
  const age = c.age_at_pick != null ? ` (${c.age_at_pick})` : "";
  const desc = c.description && oneLine(c.description) ? ` — ${oneLine(c.description)}` : "";
  const url = hideLinkPreview(c.wiki_url);
  return `${flag} **${name}**${age}${desc}${url ? ` ${url}` : ""}`;
}

const cmd = {
  name: "liste",
  aliases: ["mylist", "mypicks", "list"],
  admin: false,
  group: "everyone",
  description: "Namenliste, deine oder die eines anderen",
  usage: "/liste [user:@Spieler]\n{prefix}liste [@User|Snowflake]",
  examples: ["/liste", "/liste user:@Spieler", "{prefix}liste 123456789012345678"],
  options: [
    {
      name: "user",
      description: "Spieler dessen Liste du sehen willst",
      type: "USER",
      required: false,
    },
    {
      name: "user_id",
      description: "Discord-Snowflake (Fallback in DMs)",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const user = interaction.options.getUser("user");
    const id = interaction.options.getString("user_id");
    if (user) return [];
    if (id) return [id];
    return [];
  },
  async run(ctx, args, msg) {
    const authorId = String(msg.author.id);
    const mention = msg.mentions?.users?.first?.() || null;
    let discordId = authorId;
    const inDm = msg.guildId == null && !(msg.guild);

    if (mention) {
      discordId = String(mention.id);
      if (inDm && discordId !== authorId) {
        // Fremde Liste per Mention in der DM: bleibt Guild-Domain.
        await replyText(msg, DM_FOREIGN_LIST);
        return;
      }
      if (discordId !== authorId && !db.findPlayerByQuery(discordId)) {
        await replyText(msg, NEED_MENTION);
        return;
      }
    } else if (args.length) {
      const q = args.join(" ").trim();
      if (!SNOWFLAKE.test(q)) {
        await replyText(msg, NEED_MENTION);
        return;
      }
      const player = db.findPlayerByQuery(q);
      if (!player) {
        await replyText(msg, NEED_MENTION);
        return;
      }
      if (inDm && String(player.discord_user_id) !== authorId) {
        // Fremde Liste per Snowflake in der DM: bleibt Guild-Domain.
        await replyText(msg, DM_FOREIGN_LIST);
        return;
      }
      discordId = String(player.discord_user_id);
    }

    const data = db.getPlayerPicks(discordId);
    if (!data) {
      await replyText(msg, discordId === authorId ? NOT_REGISTERED : NEED_MENTION);
      return;
    }

    const self = discordId === authorId;
    const safeName = sanitizeDisplayName(data.player.display_name);
    const season = db.getActiveSeason();
    const whose = self ? "Deine Liste" : `Liste **${safeName}**`;
    const bits = [yearSentence(season, self ? null : safeName)];
    const draft = draftSentence(data.player.id);
    if (draft) bits.push(draft);
    bits.push(`${whose} — ${data.picks.length} Namen | Punkte **${data.total}**`);
    const header = `${bits.join("\n")}\n`;
    const lines = data.picks.map(pickLine);
    const body = chunkLines(header, lines);

    // Eigene DM-Liste: 2027-Entwurf über der laufenden 2026-Liste zeigen.
    const upcoming = self && !msg.guildId && !msg.guild ? draftBlock(data.player.id) : null;
    const payload = [];
    if (upcoming) payload.push(`${upcoming.title}\n${upcoming.body}`);
    payload.push(...(Array.isArray(body) ? body : [body]));
    await sendChunks(msg, payload);
  },
};

module.exports = cmd;
module.exports.sendChunks = sendChunks;
module.exports.chunkLines = chunkLines;
module.exports.replyText = replyText;
module.exports.sanitizeDisplayName = sanitizeDisplayName;
module.exports.mentionOpts = mentionOpts;
module.exports.acceptedWikiUrl = acceptedWikiUrl;
module.exports.hideLinkPreview = hideLinkPreview;
module.exports.resolveSnowflakePoints = resolveSnowflakePoints;
module.exports.installSnowflakePlayerQuery = installSnowflakePlayerQuery;
module.exports.draftBlock = draftBlock;
module.exports.RETRY_DELAY_MS = RETRY_DELAY_MS;
module.exports.NOT_REGISTERED = NOT_REGISTERED;
module.exports.DM_FOREIGN_LIST = DM_FOREIGN_LIST;
module.exports.NEED_MENTION = NEED_MENTION;
