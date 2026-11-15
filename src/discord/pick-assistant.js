/**
 * Tipp-Assistent (Self-Service per DM) für die announced-Saison (2027).
 *
 * Zustand in `pick_drafts` (SQLite) — Neustart setzt dieselbe Liste fort.
 * Reagiert auf messageCreate (DMs) und auf `pka:`-Interaktionen.
 * Kein Dauer-Poll über offene DMs.
 */
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");
const db = require("../db");
const { parsePickList, isSmallTalkLine } = require("./pick-parse");
const membership = require("./membership");
// pageLookup als MODUL referenzieren statt die Funktionen beim Load zu
// destrukturieren — Aufrufe gehen durch das Modul-Objekt, sodass Tests die
// Netz-Funktionen überschreiben können (kein Verhaltensunterschied in Prod).
const pageLookup = require("../wiki/page-lookup");
const { queueCelebsForReview } = require("./celeb-review");
const { resolveAdminTarget } = require("./admin-notify");
const { logEvent, logError } = require("./log");

const DONE_RE = /^(fertig|done|end|liste fertig)$/i;
const REMOVE_RE = /^entfern\w*\s+(\d+)$/i;
const CHANGE_RE = /^(?:änder\w*|aender\w*|change)\s+(\d+)\s+(.+)$/i;
const UNKNOWN_CMD_RE = /^\s*(?:änder\w*|aender\w*|aendr\w*|entfern\w*|link\w*|falsch\w*|nein\w*|wrong\w*|chang\w*|remove\w*|unlock\w*|fertig\w*|done\w*|end\w*)(?:\s+\d+\s+.+|\s+\d+)$/i;
// „öffnen“ ist kein Befehl mehr (M12). unlock und entsperren bleiben.
const UNLOCK_RE = /^(unlock|entsperren)$/i;
const LINK_URL_RE = /^link\s+(\d+)\s+(\S+\.wikipedia\.org\/wiki\/\S+)$/i;
const WRONG_RE = /^(?:falsch|nein|wrong|nicht richtig|falsche)\s*(?:\s*(\d+))?$/i;
const WIKI_URL_RE = /^(?:https?:\/\/)?(?:en|de)\.wikipedia\.org\/wiki\/[^\s]+$/i;

// Hinweise für No-Name-DM-Noûts. Das Präfix ist dem Bot bekannt, also schreibt
// er es konkret hin statt „mit dem Präfix“ zu sagen.
function noNameSentence(prefix) {
  const p = prefix || "!";
  return `Das habe ich nicht als Namen gelesen. Ein Name pro Zeile — für Hilfe: \`${p}hilfe\`.`;
}
function commaNameSentence(prefix) {
  const p = prefix || "!";
  return `${noNameSentence(p)} Bei \`Merkel, Angela\`: das Komma klebt zu einem Namen — schick \`Angela Merkel\`, oder zwei Zeilen.`;
}
function helpSentence(prefix) {
  const p = prefix || "!";
  return `Für die Befehlsübersicht: \`${p}hilfe\`. Namen schreibst du einfach so — ein pro Zeile.`;
}
/** Reine Hilfewörter in der DM: aktiv die Übersicht zeigen statt sie als Name/Smalltalk zu verbuchen. */
function isHelpWord(line) {
  return /^(hilfe|help|help me|commands|befehle)(\s|$)/i.test(String(line || "").trim());
}
const BUSY_SENTENCE =
  "Ich ordne noch die letzte Liste zu. Wart, bis die Nachricht `Zuordnung fertig` da ist.";
const QUOTA_SENTENCE =
  "Für heute sind genug Suchen gelaufen. Schick den Wikipedia-Link oder warte bis morgen.";
const NOT_A_URL_SENTENCE = "Das ist keine Wikipedia-URL.";
const PENDING_FERTIG_SENTENCE = "Ich suche noch. Wart auf die Zuordnung, dann `fertig`.";
const AMBIGUOUS_SENTENCE = "Mehrere Leute heißen so — wähl die richtige Person:";

/** In-Memory-Queue: ein Wiki-Auflösungs-Lauf pro User, nicht parallel. */
const busyUsers = new Set();
/** User, die während ihres Laufs weitere Namen geschickt haben (Nachlauf). */
const rerunUsers = new Set();
/** R2-4: User-Interventionen (URL/link/falsch/Menü) stoppen den laufenden
 * Auto-Resolver, damit er die manuelle Auswahl nicht überschreibt. */
const interruptUsers = new Set();
/** In-Memory-Ack für „wenige Namen trotzdem locken“ (erste Warnung, zweites fertig löst aus). */
const fewUsers = new Set();

/** Ack für „erster fertig bei unlinked“, solange die Spalte noch nicht da ist. */
const memoryUnlinkedAck = new Set();
let ackColumnKnown = null;

function loadSafeText() {
  try {
    return require("./safe-text");
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") {
      return {
        sanitizeDisplayName: fallbackSanitize,
        mentionOpts: () => ({ allowedMentions: { parse: [] } }),
      };
    }
    throw e;
  }
}

function loadWikiGate() {
  try {
    return require("../wiki/gate");
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") {
      return { withWikiSlot: (fn) => fn(), allowUserWiki: () => true };
    }
    throw e;
  }
}

const safeText = loadSafeText();
const wikiGate = loadWikiGate();
const sanitizeDisplayName =
  typeof safeText.sanitizeDisplayName === "function" ? safeText.sanitizeDisplayName : fallbackSanitize;
const mentionOpts =
  typeof safeText.mentionOpts === "function"
    ? safeText.mentionOpts
    : () => ({ allowedMentions: { parse: [] } });
const withWikiSlot =
  typeof wikiGate.withWikiSlot === "function" ? wikiGate.withWikiSlot : (fn) => fn();
const allowUserWiki =
  typeof wikiGate.allowUserWiki === "function" ? wikiGate.allowUserWiki : () => true;

function fallbackSanitize(raw) {
  let s = String(raw ?? "").replace(/[\u0000-\u001F\u007F]/g, " ");
  s = s.replace(/[*_~|`<>@\[\]()]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || "\u201EUnbenannt\u201C";
}

function entryDisplayName(e) {
  // Präferiert den kanonischen Wikipedia-Titel (resolved_name), z.B. “R-Truth”
  // aus raw_name “Ron killings”; sonst den Rohstring.
  if (e && e.resolved_name && String(e.resolved_name).trim()) return e.resolved_name;
  return e && e.raw_name ? e.raw_name : "";
}

function showName(raw) {
  return sanitizeDisplayName(raw);
}

async function reply(msg, content) {
  const payload = { content: String(content), ...mentionOpts() };
  if (typeof msg.reply === "function") return msg.reply(payload);
  if (msg.channel && typeof msg.channel.send === "function") return msg.channel.send(payload);
  if (msg.author && typeof msg.author.send === "function") return msg.author.send(payload);
  throw new Error("keine Antwortmöglichkeit");
}

async function ephemeral(interaction, content) {
  const payload = { content: String(content), ephemeral: true, ...mentionOpts() };
  if (typeof interaction.followUp === "function") {
    await interaction.followUp(payload).catch(() => {});
  }
}

function hasAckColumn() {
  if (ackColumnKnown !== null) return ackColumnKnown;
  try {
    const cols = db.getDb().prepare("PRAGMA table_info(pick_drafts)").all();
    ackColumnKnown = cols.some((c) => c.name === "unlinked_ack");
  } catch {
    return false;
  }
  return ackColumnKnown;
}

function draftAcked(draft) {
  if (!draft) return false;
  if (hasAckColumn()) return Number(draft.unlinked_ack) === 1;
  return memoryUnlinkedAck.has(draft.id);
}

function setDraftAck(draftId, on) {
  if (on) memoryUnlinkedAck.add(draftId);
  else memoryUnlinkedAck.delete(draftId);
  if (!hasAckColumn()) return;
  db.getDb().prepare("UPDATE pick_drafts SET unlinked_ack = ? WHERE id = ?").run(on ? 1 : 0, draftId);
}

function clearAckForEntry(entryId) {
  const row = db
    .getDb()
    .prepare("SELECT draft_id FROM pick_draft_entries WHERE id = ?")
    .get(entryId);
  if (row) setDraftAck(row.draft_id, false);
}

function setLinked(entryId, fields) {
  db.setDraftEntryLinked(entryId, fields);
  if (fields && fields.clearIdentity) {
    const clearUrl = fields.wikiUrl == null || fields.wikiUrl === "";
    db.getDb()
      .prepare(
        `UPDATE pick_draft_entries
            SET qid = NULL,
                wiki_norm = NULL,
                wiki_url = CASE WHEN ? = 1 THEN NULL ELSE wiki_url END
          WHERE id = ?`
      )
      .run(clearUrl ? 1 : 0, entryId);
  }
  clearAckForEntry(entryId);
}

function savePendingPaste(userId, body) {
  const uid = String(userId);
  const text = String(body ?? "");
  if (typeof db.savePendingPaste === "function") {
    db.savePendingPaste(uid, text);
    return;
  }
  db.getDb().exec(
    `CREATE TABLE IF NOT EXISTS pending_pastes (
      discord_user_id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );
  db.getDb()
    .prepare(
      `INSERT INTO pending_pastes (discord_user_id, body, created_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(discord_user_id) DO UPDATE SET
         body = excluded.body,
         created_at = excluded.created_at`
    )
    .run(uid, text);
}

function takePendingPaste(userId) {
  const uid = String(userId);
  if (typeof db.takePendingPaste === "function") {
    const row = db.takePendingPaste(uid);
    if (row == null || row === "") return null;
    if (typeof row === "string") return row;
    if (typeof row.body === "string") return row.body;
    return null;
  }
  let row;
  try {
    row = db.getDb().prepare("SELECT body FROM pending_pastes WHERE discord_user_id = ?").get(uid);
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
  if (!row) return null;
  db.getDb().prepare("DELETE FROM pending_pastes WHERE discord_user_id = ?").run(uid);
  return row.body;
}

function withContent(msg, content) {
  return {
    guildId: msg.guildId || null,
    channelId: msg.channelId,
    channel: msg.channel,
    author: msg.author,
    content: String(content),
    reply: (...args) => msg.reply(...args),
  };
}

/** link_status je nach Proposal. Exportiert für Tests. */
function classifyProposal(proposal) {
  const cands = proposal?.candidates || [];
  if (!proposal?.wikiUrl) return { linkStatus: "unlinked" };
  if (cands.length >= 2) return { linkStatus: "ambiguous" };
  return { linkStatus: "linked" };
}

function recheckEntry(entryId, claimedUrl) {
  const row = db
    .getDb()
    .prepare("SELECT link_status, wiki_url FROM pick_draft_entries WHERE id = ?")
    .get(entryId);
  if (!row || row.link_status !== "pending") return false;
  if (claimedUrl != null) return row.wiki_url === String(claimedUrl);
  return row.wiki_url == null || row.wiki_url === "";
}

/** URL nur nach normalizeWikiUrl. Schlägt das fehl: wiki_url leer, Identität weg. */
function claimEntryUrl(entryId, url) {
  const norm = pageLookup.normalizeWikiUrl(url);
  if (!norm?.url) {
    setLinked(entryId, {
      wikiUrl: "",
      wikiNorm: "",
      qid: null,
      linkStatus: "unlinked",
      candidatesJson: null,
      clearIdentity: true,
    });
    return null;
  }
  setLinked(entryId, {
    wikiUrl: norm.url,
    linkStatus: "pending",
    candidatesJson: null,
  });
  return norm.url;
}

function clearLookupFailure(entryId) {
  setLinked(entryId, {
    wikiUrl: "",
    wikiNorm: "",
    qid: null,
    linkStatus: "unlinked",
    candidatesJson: null,
    clearIdentity: true,
  });
}

function safeWikiHref(url) {
  const norm = pageLookup.normalizeWikiUrl(url);
  return norm?.url || null;
}

function entryLinkLabel(e) {
  if (e.link_status === "pending") return "suche noch…";
  if (e.link_status === "unlinked") return "kein Artikel";
  const href = safeWikiHref(e.wiki_url);
  if (href) return `[Wiki](${href})`;
  return "kein Artikel";
}

function draftEmbed(entries, season, draftStatus = "draft") {
  const lines = entries.length
    ? entries.map((e, i) => {
        const link = entryLinkLabel(e);
        const age = e.proposed_age != null ? ` · Alter ${e.proposed_age}` : "";
        const dead = e.is_alive === 0 ? " · ☠️ vor Start gestorben" : "";
        const amb = e.link_status === "ambiguous" ? " ⚠️" : "";
        return `${i + 1}. **${showName(entryDisplayName(e))}** — ${link}${age}${amb}${dead}`;
      })
    : ["_(noch keine Namen)_"];
  const stateWord = draftStatus === "finalized" ? "eingefroren" : "noch offen";
  const intro = [
    `Stichtag **${season?.start_date || "?"}** — ${stateWord}.`,
    draftStatus === "finalized"
      ? "🔒 **Liste eingefroren.** Stirbt jemand vor dem Start, melde ich mich. Bis dahin kneifst du mit `unlock`."
      : "Schick Namen: eine Zeile, ein `;` oder ` - `. Ein Komma trennt nicht (`Meier, Müller` ist eine Person).",
    draftStatus === "finalized"
      ? "`unlock` öffnet die Liste wieder · danach erneut `fertig`"
      : "`entfernen 3` · `ändern 3 Neuer Name` · `fertig` oder `done`, wenn die Liste stimmt.",
  ];
  if (draftStatus !== "finalized") {
    intro.push("`falsch 3` · `link 3 <URL>`");
  }
  intro.push("");
  const embed = new EmbedBuilder()
    .setColor(draftStatus === "finalized" ? 0x1f8b4c : 0x222a33)
    .setTitle(`Deine Tipps für Saison ${season?.year || "?"} (Start ${season?.start_date || "?"})`);
  if (lines.length <= 12) {
    embed.setDescription([...intro, ...lines].join("\n"));
  } else {
    embed.setDescription(intro.join("\n"));
    const per = 12;
    for (let start = 0; start < lines.length; start += per) {
      const chunkLines = lines.slice(start, start + per);
      const n0 = start + 1;
      const n1 = Math.min(start + per, lines.length);
      const value = chunkLines.join("\n");
      embed.addFields({
        name: `Einträge ${n0}–${n1}`,
        value: value.length > 1024 ? value.slice(0, 1023) + "…" : value,
        inline: false,
      });
    }
  }
  return embed;
}

function buildPickSelect(entries) {
  const ambiguous = entries.filter((e) => e.link_status === "ambiguous");
  if (!ambiguous.length) return null;
  const entry = ambiguous[0];
  let candidates = [];
  try {
    candidates = JSON.parse(entry.candidates_json || "[]");
  } catch {
    candidates = [];
  }
  if (!candidates.length) return null;
  const labelName = showName(entry.raw_name);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`pka:pick:${entry.id}`)
    .setPlaceholder(`Person wählen: ${labelName.slice(0, 80)}`)
    .addOptions(
      candidates.slice(0, 3).map((c, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(showName(c.title || `Kandidat ${i + 1}`).slice(0, 100))
          .setDescription(`${c.lang || "?"} · Alter ${c.proposedAge ?? "?"}`.slice(0, 50))
          .setValue(String(i))
      )
    );
  return new ActionRowBuilder().addComponents(menu);
}

function isCommandLine(line) {
  const t = String(line || "").trim();
  if (!t) return false;
  return (
    DONE_RE.test(t) ||
    UNLOCK_RE.test(t) ||
    REMOVE_RE.test(t) ||
    CHANGE_RE.test(t) ||
    LINK_URL_RE.test(t) ||
    WRONG_RE.test(t) ||
    UNKNOWN_CMD_RE.test(t) ||
    WIKI_URL_RE.test(t)
  );
}

function unlinkedLines(entries, names) {
  const source = names && names.length
    ? names.map((name) => ({ raw_name: name, id: null }))
    : entries.filter((e) => e.link_status === "unlinked");
  const bits = source.map((e) => {
    const idx = e.id != null ? entries.findIndex((x) => x.id === e.id) : entries.findIndex((x) => x.raw_name === e.raw_name);
    const n = idx >= 0 ? idx + 1 : "?";
    return `Für **${showName(e.raw_name)}** keinen Personenartikel. Wikipedia-Link schicken, \`entfernen ${n}\`, oder so lassen (dann 0 Punkte).`;
  });
  bits.push("Noch einmal `fertig`, wenn die Zeilen so bleiben sollen.");
  return bits.join("\n");
}

function frozenSentence(year) {
  return `Deine Liste für ${year} ist eingefroren. Schreib \`unlock\`, dann den Namen, dann wieder \`fertig\`.`;
}

async function respondPick(ctx, channel, userId, season, extra = [], displayName = null) {
  let player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(userId));
  if (!player) {
    player = db.upsertPlayer({
      displayName: displayName || String(userId),
      discordUserId: String(userId),
    });
  }
  const draft = db.getOrCreateDraft(player.id, season.id);
  const entries =
    draft.status === "finalized"
      ? enrichDeadFlags(listDraftEntriesForFinalized(player.id, season.id))
      : db.listDraftEntries(draft.id);
  const payload = { embeds: [draftEmbed(entries, season, draft.status)], ...mentionOpts() };
  const select = buildPickSelect(entries);
  if (select) {
    payload.components = [select];
    payload.content = AMBIGUOUS_SENTENCE;
  }
  if (extra && extra.length) {
    payload.content = [payload.content, ...extra].filter(Boolean).join("\n");
  }
  if (channel.send) {
    await channel.send(payload);
  } else if (channel.reply) {
    await channel.reply(payload);
  }
}

function listDraftEntriesForFinalized(playerId, seasonId) {
  return db.getAnnouncedSeasonPicksForPlayer(playerId, seasonId).map((p) => ({
    id: p.celeb_id,
    raw_name: p.celeb_name,
    wiki_url: p.wiki_url,
    is_alive: p.is_alive,
    link_status: "linked",
    position: p.id,
    // Nach dem Finalize steht der kanonische Name auf dem Celeb selbst;
    // resolved_name ist dort bereits angewandt.
    resolved_name: null,
  }));
}

function enrichDeadFlags(entries) {
  return entries.map((e) => ({
    ...e,
    isAlive: e.is_alive,
  }));
}

function loadOwnedEntry(entryId) {
  return (
    db
      .getDb()
      .prepare(
        `SELECT e.*, d.status AS draft_status, d.id AS draft_id,
                p.discord_user_id AS owner_discord_id
           FROM pick_draft_entries e
           JOIN pick_drafts d ON d.id = e.draft_id
           JOIN players p ON p.id = d.player_id
          WHERE e.id = ?`
      )
      .get(entryId) || null
  );
}

function chosenTitle(row) {
  if (row && row.resolved_name && String(row.resolved_name).trim()) {
    return showName(row.resolved_name);
  }
  let candidates = [];
  try {
    candidates = JSON.parse(row.candidates_json || "[]");
  } catch {
    candidates = [];
  }
  const hit = candidates.find(
    (c) => (row.qid && c.qid === row.qid) || (row.wiki_url && (c.url === row.wiki_url || c.norm === row.wiki_norm))
  );
  if (hit?.title) return showName(hit.title);
  const norm = pageLookup.normalizeWikiUrl(row.wiki_url);
  if (norm?.title) return showName(norm.title);
  return showName(row.raw_name);
}

function parseCandidates(row) {
  try {
    const parsed = JSON.parse(row?.candidates_json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Kandidaten-Auswahl aus einem pka:pick-Select verarbeiten. */
async function handlePickInteraction(ctx, interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!String(interaction.customId || "").startsWith("pka:pick:")) return false;
  const entryId = Number(interaction.customId.split(":")[2]);
  if (!entryId) return false;

  if (interaction.isDeferred?.() || interaction.deferred) {
    await interaction.editReply({ content: "…", components: [] }).catch(() => {});
  } else {
    await interaction.deferUpdate().catch(() => {});
  }

  const chan = interaction.channel;
  const userId = interaction.user?.id;
  const part = await membership.canParticipate(ctx.client, ctx.config, userId);
  if (!part.ok) {
    await ephemeral(interaction, membership.participationSentence(part));
    return true;
  }
  const season = part.season;

  const entry = loadOwnedEntry(entryId);
  const owns =
    entry &&
    String(entry.owner_discord_id) === String(userId) &&
    entry.draft_status === "draft";
  if (!owns) {
    await ephemeral(interaction, "Das ist nicht deine offene Auswahl.");
    return true;
  }
  if (entry.link_status !== "ambiguous") {
    await ephemeral(interaction, `Schon gewählt: ${chosenTitle(entry)}.`);
    return true;
  }
  const candidates = parseCandidates(entry);
  const idx = Number(interaction.values?.[0]);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    await ephemeral(interaction, "Das ist nicht deine offene Auswahl.");
    return true;
  }
  const chosen = candidates[idx];
  if (busyUsers.has(userId)) {
    interruptUsers.add(userId);
    rerunUsers.add(userId);
  }
  setLinked(entryId, {
    wikiUrl: chosen.url,
    wikiNorm: chosen.norm,
    qid: chosen.qid,
    proposedAge: chosen.proposedAge,
    linkStatus: "linked",
    resolvedName: chosen.title || null,
  });
  await logEvent(ctx.client, ctx.config, {
    kind: "pick-link",
    summary: `Kandidat gewählt: ${showName(entry.raw_name)} → ${showName(chosen.title)} (Saison ${season.year})`,
    userId,
  });
  await respondPick(ctx, chan, userId, season);
  return true;
}

async function denyParticipation(ctx, msg, part) {
  const text = membership.participationSentence(part);
  if (part.reason === "unavailable") {
    let replied = false;
    try {
      await reply(msg, text);
      replied = true;
    } catch {
      replied = false;
    }
    try {
      savePendingPaste(msg.author.id, msg.content || "");
    } catch (e) {
      console.warn("[pick] pending paste", e.message);
    }
    return replied;
  }
  try {
    await reply(msg, text);
  } catch {
    return false;
  }
  if (part.reason === "not-member") {
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-denied",
      summary: "Tipp von Nicht-Mitglied des Announce-Kanals abgelehnt.",
      userId: msg.author.id,
    }).catch(() => {});
  }
  return true;
}

/**
 * Eine DM des Spielers verarbeiten. Liefert true, wenn sie konsumiert wurde.
 * Guild-Nachrichten: nur der Anmeldekanal bekommt einen Hinweis, sonst false.
 */
async function tryConsumePickMessage(ctx, msg) {
  if (msg.guildId) {
    const announced = db.getAnnouncedSeason();
    const channelId = msg.channelId || msg.channel?.id;
    const prefix = (ctx.config && ctx.config.prefix) || "!";
    const text = String(msg.content || "").trim();
    if (
      announced &&
      announced.announce_channel_id &&
      String(channelId) === String(announced.announce_channel_id) &&
      !text.startsWith(prefix)
    ) {
      try {
        await reply(msg, "Namen nur per DM an mich. Hier zählen sie nicht — schreib mir direkt.");
      } catch {
        return false;
      }
      return true;
    }
    return false;
  }

  const part = await membership.canParticipate(ctx.client, ctx.config, msg.author.id);
  if (!part.ok) return denyParticipation(ctx, msg, part);
  const season = part.season;

  if (!busyUsers.has(msg.author.id)) {
    let pending = null;
    try {
      pending = takePendingPaste(msg.author.id);
    } catch (e) {
      console.warn("[pick] take pending", e.message);
    }
    if (pending && String(pending) !== String(msg.content || "")) {
      await handlePickBody(ctx, withContent(msg, pending), season);
    }
  }
  return handlePickBody(ctx, msg, season);
}

async function handlePickBody(ctx, msg, season) {
  const body = String(msg.content || "").trim();
  const prefix = (ctx.config && ctx.config.prefix) || "!";

  // Prefix-Nachrichten (z.B. `!hilfe`) in der DM sind BEFEHLE, keine Namen:
  // nicht hier schlucken, damit sie bis zum Prefix-Dispatcher durchlaufen.
  // (Der passt den Namen selbst an und zeigt eine vernünftige Antwort.)
  if (body.startsWith(prefix)) return false;

  // Slash-Befehle, die als Text getippt werden (z.B. `/celebs`): Discord sendet
  // die nur als echte Interaktion, wenn der User sie aus der Vorschlagliste
  // wählt (und das nur in der Guild). Als reiner Text in der DM sind sie KEINE
  // Personen — nicht adden, auf den Prefix-Äquivalent verweisen. Kein Slash-
  // Rauschen in der DM: nur der Prefix-Weg wird genannt.
  const slash = /^\/([a-z][a-z0-9_-]*)(?:\s|$)/i.exec(body);
  if (slash) {
    const slashName = slash[1].toLowerCase();
    const known = Boolean(ctx.commands?.get(slashName));
    await reply(
      msg,
      known
        ? "\u201E`/`“ geht nur in der Guild aus der Vorschlagsliste — hier im DM geht der Befehl mit dem Präfix: `" +
          `${prefix}${slashName}\`.`
        : `\`${body}\` ist weder ein Name noch ein bekannter Befehl. Für Hilfe: \`${prefix}hilfe\`.`
    );
    return true;
  }

  if (isHelpWord(body)) {
    // Reine Hilfewörter aktiv beantworten, statt sie als Namen/Smalltalk zu verbuchen.
    await reply(msg, helpSentence(prefix));
    return true;
  }

  if (isSmallTalkLine(body)) {
    await reply(msg, noNameSentence(prefix));
    return true;
  }

  if (WIKI_URL_RE.test(body) && !LINK_URL_RE.test(body)) {
    return consumeBareUrl(ctx, msg, season, body);
  }

  if (WRONG_RE.test(body)) {
    return consumeWrong(ctx, msg, season, body);
  }

  if (LINK_URL_RE.test(body)) {
    return consumeLinkCommand(ctx, msg, season, body);
  }

  if (UNLOCK_RE.test(body)) {
    return consumeUnlock(ctx, msg, season);
  }

  if (DONE_RE.test(body)) {
    return consumeDone(ctx, msg, season);
  }

  if (REMOVE_RE.test(body)) {
    return consumeRemove(ctx, msg, season, body);
  }

  if (CHANGE_RE.test(body)) {
    return consumeChange(ctx, msg, season, body);
  }

  const rawLines = body.split(/\n/);
  if (rawLines.some((line) => line.includes(",") && !isCommandLine(line))) {
    await reply(msg, commaNameSentence(prefix));
    return true;
  }

  const filtered = rawLines
    .map((line) => line.trim())
    .filter((line) => line && !isSmallTalkLine(line))
    .join("\n");
  const parsed = parsePickList(filtered, { maxNames: ctx.config.maxPicksPerPlayer });
  const cleanNames = (parsed.names || []).filter((n) => !UNKNOWN_CMD_RE.test(n.trim()));
  const cmdLines = (parsed.names || []).filter((n) => UNKNOWN_CMD_RE.test(n.trim()));

  if (!parsed.names || !parsed.names.length) {
    await reply(msg, noNameSentence(prefix));
    return true;
  }
  if (!cleanNames.length) {
    await reply(
      msg,
      "Das sieht nach einem unbekannten Befehl aus (nur `ändern <Nr> <Name>`, `entfernen <Nr>`, `link <Nr> <URL>`, `fertig`, `unlock` und `falsch [<Nr>]` sind Befehle). Namen speichere ich unverändert."
    );
    return true;
  }

  if (busyUsers.has(msg.author.id)) {
    await reply(msg, BUSY_SENTENCE);
    return true;
  }

  const playerRow =
    db.getDb().prepare("SELECT * FROM players WHERE discord_user_id = ?").get(String(msg.author.id)) ||
    db.upsertPlayer({ displayName: msg.author.username, discordUserId: msg.author.id });
  const draft = db.getOrCreateDraft(playerRow.id, season.id);
  const cap = ctx.config.maxPicksPerPlayer;
  let added;
  try {
    added = db.addDraftNames(draft.id, cleanNames, { maxNames: cap });
  } catch (e) {
    const fresh = db.getDraftForPlayer(playerRow.id, season.id);
    if (fresh?.status === "finalized" || /finalisiert/i.test(String(e && e.message))) {
      await reply(msg, frozenSentence(season.year));
      return true;
    }
    throw e;
  }
  setDraftAck(draft.id, false);

  if (cmdLines.length) {
    await reply(
      msg,
      `Diese Zeilen sehen nach Befehlen aus und wurden NICHT als Namen gespeichert: ${cmdLines
        .map((c) => `\`${showName(c)}\``)
        .join(", ")} — für Ändern/Entfernen/Linken kennst du die Form \`ändern <Nr> <Name>\` & Co.`
    );
  }

  await logEvent(ctx.client, ctx.config, {
    kind: "pick-add",
    summary: `+${added.added} Namen (Saison ${season.year})`,
    userId: msg.author.id,
    detail: cleanNames.map(showName).join(" | ").slice(0, 1200),
  });
  const dups = [...(parsed.duplicates || []), ...(added.duplicates || [])];
  if (dups.length) {
    const shown = [...new Set(dups.map((d) => showName(d)))].join(", ");
    await reply(msg, `Doppelt, einmal reicht: ${shown}`);
  }
  const recognized = parsed.recognized ?? cleanNames.length;
  if (parsed.truncated || added.truncated) {
    const recount = added.truncated ? db.listDraftEntries(draft.id).length : Math.min(recognized, cap);
    await reply(
      msg,
      `⚠️ Maximal **${cap}** Namen in der ganzen Liste — ${recognized} erkannt, ${recount} aufgenommen. Platz nur mit \`entfernen <Nummer>\` (gilt über alle Nachrichten, nicht pro Paste).`
    );
  }
  await respondPick(ctx, msg.channel, msg.author.id, season);
  void resolvePendingSynchronous(ctx, msg.channel, msg.author.id, season, draft.id, "add");
  return true;
}

async function consumeBareUrl(ctx, msg, season, body) {
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  if (!player) {
    await reply(msg, "Noch keine Liste angelegt.");
    return true;
  }
  const draft = db.getDraftForPlayer(player.id, season.id);
  if (!draft || draft.status !== "draft") {
    await reply(msg, "Kein offener Draft — schick erst Namen, oder `unlock`.");
    return true;
  }
  const entries = db.listDraftEntries(draft.id);
  const target = targetForUrlPaste(entries);
  if (!target) {
    await reply(msg, "Alle Einträge sind bereits verlinkt — nutze `link <Nummer> <URL>`, um einen gezielt zu ändern.");
    return true;
  }
  const targetId = target.id;
  const stored = claimEntryUrl(targetId, body);
  if (!stored) {
    await reply(msg, NOT_A_URL_SENTENCE);
    return true;
  }
  if (busyUsers.has(msg.author.id)) {
    rerunUsers.add(msg.author.id);
    interruptUsers.add(msg.author.id);
    await reply(msg, "Moment, ich löse noch Namen auf — deinen Link setze ich gleich um.");
    return true;
  }
  try {
    const proposal = await pageLookup.lookupUrl(ctx.config.userAgent, stored, season.start_date, null);
    if (!recheckEntry(targetId, stored)) {
      throw new Error("Eintrag wurde während der Auflösung verändert — nicht überschrieben.");
    }
    setLinked(targetId, {
      wikiUrl: proposal.wikiUrl,
      wikiNorm: proposal.wikiNorm,
      qid: proposal.qid,
      proposedAge: proposal.proposedAge,
      linkStatus: "linked",
      resolvedName: proposal.title || null,
    });
    await reply(msg, `🔗 ${showName(target.raw_name)} → **${showName(proposal.title || stored)}**`);
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-link-url",
      summary: `${showName(target.raw_name)} → ${stored} (Saison ${season.year})`,
      userId: msg.author.id,
    });
  } catch (err) {
    if (recheckEntry(targetId, stored)) clearLookupFailure(targetId);
    await reply(msg, NOT_A_URL_SENTENCE);
    logError(ctx.client, ctx.config, err, { where: "pick lookup url", userId: msg.author.id }).catch(() => {});
  }
  void resolvePendingSynchronous(ctx, msg.channel, msg.author.id, season, draft.id, "add");
  return true;
}

async function consumeWrong(ctx, msg, season, body) {
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  const draft = player && db.getDraftForPlayer(player.id, season.id);
  if (!draft || draft.status !== "draft") {
    await reply(msg, "Kein offener Draft.");
    return true;
  }
  const entries = db.listDraftEntries(draft.id);
  const match = body.match(WRONG_RE);
  const num = match?.[1] ? Number(match[1]) : null;
  const cands = entries.filter((e) => e.link_status === "linked" || e.link_status === "ambiguous");
  let target;
  if (num) {
    target = entries[num - 1];
  } else if (cands.length === 1) {
    target = cands[0];
  } else if (cands.length > 1) {
    await reply(msg, "Mehrere verlinkte Einträge — sag mir, welcher falsch ist: `falsch <Nummer>`");
    await respondPick(ctx, msg.channel, msg.author.id, season);
    return true;
  }
  if (!target) {
    await reply(msg, "Kein verlinkter Eintrag gefunden. Nutze `falsch <Nummer>`.");
    return true;
  }
  db.replaceDraftEntryName(target.id, target.raw_name);
  setDraftAck(draft.id, false);
  await logEvent(ctx.client, ctx.config, {
    kind: "pick-wrong",
    summary: `${showName(target.raw_name)} als falsch markiert (Link entfernt)`,
    userId: msg.author.id,
  });
  await reply(
    msg,
    `⚠️ ${showName(target.raw_name)} zur Korrektur zurückgesetzt. Schick einen Wikipedia-Link, wähle aus der Liste, oder lösche den Eintrag.`
  );
  await respondPick(ctx, msg.channel, msg.author.id, season);
  return true;
}

async function consumeLinkCommand(ctx, msg, season, body) {
  const m = body.match(LINK_URL_RE);
  const num = Number(m[1]);
  const url = m[2];
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  const draft = player && db.getDraftForPlayer(player.id, season.id);
  if (!draft || draft.status !== "draft") {
    await reply(msg, "Kein offener Draft.");
    return true;
  }
  const entries = db.listDraftEntries(draft.id);
  const target = entries[num - 1];
  if (!target) {
    await reply(msg, `Kein Eintrag Nr. **${num}**.`);
    return true;
  }
  const entryId = target.id;
  const stored = claimEntryUrl(entryId, url);
  if (!stored) {
    await reply(msg, NOT_A_URL_SENTENCE);
    return true;
  }
  if (busyUsers.has(msg.author.id)) {
    rerunUsers.add(msg.author.id);
    interruptUsers.add(msg.author.id);
    await reply(msg, "Moment, ich löse noch Namen auf — deinen Link setze ich gleich um.");
    return true;
  }
  try {
    const proposal = await pageLookup.lookupUrl(ctx.config.userAgent, stored, season.start_date, null);
    if (!recheckEntry(entryId, stored)) {
      throw new Error("Eintrag wurde während der Auflösung verändert — nicht überschrieben.");
    }
    setLinked(entryId, {
      wikiUrl: proposal.wikiUrl,
      wikiNorm: proposal.wikiNorm,
      qid: proposal.qid,
      proposedAge: proposal.proposedAge,
      linkStatus: "linked",
      resolvedName: proposal.title || null,
    });
    await reply(msg, `🔗 ${showName(target.raw_name)} → **${showName(proposal.title || stored)}**`);
  } catch (err) {
    if (recheckEntry(entryId, stored)) clearLookupFailure(entryId);
    await reply(msg, NOT_A_URL_SENTENCE);
    logError(ctx.client, ctx.config, err, { where: "pick link command", userId: msg.author.id }).catch(() => {});
  }
  await respondPick(ctx, msg.channel, msg.author.id, season);
  return true;
}

async function consumeUnlock(ctx, msg, season) {
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  if (!player) {
    await reply(msg, "Noch keine Liste angelegt.");
    return true;
  }
  const draft = db.getDraftForPlayer(player.id, season.id);
  if (draft?.status !== "finalized") {
    await reply(msg, "Deine Liste ist nicht eingefroren — du kannst sie jederzeit direkt bearbeiten.");
    return true;
  }
  const res = db.unlockDraftForPlayer(player.id, season.id);
  if (res.unlocked) {
    setDraftAck(draft.id, false);
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-unlock",
      summary: `Draft entsperrt (Saison ${season.year})`,
      userId: msg.author.id,
    });
    const start = season.start_date || "Saisonstart";
    await reply(
      msg,
      [
        `Deine eingefrorene Liste für ${season.year} gilt ab jetzt nicht. Ohne neues \`fertig\` vor dem ${start} bist du ohne Tipps.`,
        "Kneifen ist damit passiert. Namen ändern, dann wieder `fertig`.",
      ].join("\n")
    );
    await respondPick(ctx, msg.channel, msg.author.id, season);
  } else {
    await reply(msg, "Entsperren fehlgeschlagen (" + res.error + ").");
  }
  return true;
}

async function consumeDone(ctx, msg, season) {
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  if (!player) {
    await reply(msg, "Noch keine Liste angelegt.");
    return true;
  }
  const draft = db.getDraftForPlayer(player.id, season.id);
  if (!draft) {
    await reply(msg, "Noch keine Liste angelegt.");
    return true;
  }
  if (draft.status === "finalized") {
    await reply(msg, "Deine Liste ist bereits eingefroren.");
    return true;
  }
  const entries = db.listDraftEntries(draft.id);
  if (!entries.length) {
    await reply(msg, "Du hast noch keine Namen geschickt — tipp erst Personen ein, dann `fertig`.");
    return true;
  }
  if (entries.some((e) => e.link_status === "pending")) {
    if (!busyUsers.has(msg.author.id)) {
      void resolvePendingSynchronous(ctx, msg.channel, msg.author.id, season, draft.id, "add");
    }
    await reply(msg, PENDING_FERTIG_SENTENCE);
    return true;
  }
  if (entries.some((e) => e.link_status === "ambiguous")) {
    await respondPick(ctx, msg.channel, msg.author.id, season);
    return true;
  }
  const unlinked = entries.filter((e) => e.link_status === "unlinked");
  if (unlinked.length && !draftAcked(draft)) {
    setDraftAck(draft.id, true);
    await reply(msg, unlinkedLines(entries));
    return true;
  }

  // F26: Wenige Namen vor dem Lock warnen (einfach bestätigen = zweites `fertig`).
  const cap = ctx.config?.maxPicksPerPlayer || 50;
  const minPicks = ctx.config?.minPicksPerPlayer ?? 3;
  if (entries.length < minPicks && !fewUsers.has(msg.author.id)) {
    fewUsers.add(msg.author.id);
    await reply(
      msg,
      `⚠️ Nur **${entries.length} von ${cap}** Namen auf der Liste. \nNochmal \`fertig\` und ich friere sie trotzdem ein.`
    );
    return true;
  }

  const res = db.finalizeDraft(player.id, season.id);
  if (res.locked) {
    fewUsers.delete(msg.author.id);
    await reply(msg, "Deine Liste ist bereits eingefroren.");
  } else if (res.reason === "empty") {
    fewUsers.delete(msg.author.id);
    await reply(msg, "Du hast noch keine Namen geschickt — tipp erst Personen ein, dann `fertig`.");
  } else if (res.blocked === "unlinked") {
    fewUsers.delete(msg.author.id);
    const fresh = db.listDraftEntries(draft.id);
    await reply(msg, unlinkedLines(fresh, res.names));
  } else if (res.blocked) {
    fewUsers.delete(msg.author.id);
    const fresh = db.listDraftEntries(draft.id);
    if (res.blocked === "pending" || fresh.some((e) => e.link_status === "pending")) {
      await reply(msg, PENDING_FERTIG_SENTENCE);
    } else {
      await respondPick(ctx, msg.channel, msg.author.id, season);
    }
  } else {
    if (hasAckColumn()) setDraftAck(draft.id, false);
    else memoryUnlinkedAck.delete(draft.id);
    fewUsers.delete(msg.author.id);
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-finalize",
      summary: `Draft finalisiert (${res.added} Tipps, Saison ${season.year})`,
      userId: msg.author.id,
    });
    await reply(
      msg,
      [
        `✅ Liste für **${season.year}** liegt fest (${res.added} Tipps).`,
        "Deine Namen sind bereits zugeordnet. Noch nicht freigeschaltete Celebs bestätigt der Admin kurz (danach zählen sie offiziell).",
        "Punkte: Alter am **" + (season.start_date || "Saisonstart") + "** (100 − Alter, unbekanntes Alter = 0).",
      ].join("\n")
    );
    if (res.reviewIds?.length) {
      const adminTarget = await resolveAdminTarget(ctx, {});
      await queueCelebsForReview(ctx, res.reviewIds, adminTarget || msg.channel, { season });
    }
  }
  return true;
}

async function consumeRemove(ctx, msg, season, body) {
  const num = Number(body.match(REMOVE_RE)[1]);
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  const draft = player && db.getDraftForPlayer(player.id, season.id);
  if (!draft) {
    await reply(msg, "Noch keine Liste angelegt.");
    return true;
  }
  if (draft.status !== "draft") {
    await reply(msg, frozenSentence(season.year));
    return true;
  }
  const entries = db.listDraftEntries(draft.id);
  const entry = entries[num - 1];
  if (!entry) {
    await reply(msg, `Kein Eintrag Nr. **${num}**.`);
    return true;
  }
  db.removeDraftEntry(entry.id);
  setDraftAck(draft.id, false);
  await logEvent(ctx.client, ctx.config, {
    kind: "pick-remove",
    summary: `Name entfernt: ${showName(entry.raw_name)} (Saison ${season.year})`,
    userId: msg.author.id,
  });
  await respondPick(ctx, msg.channel, msg.author.id, season);
  return true;
}

async function consumeChange(ctx, msg, season, body) {
  const m = body.match(CHANGE_RE);
  const num = Number(m[1]);
  const newName = m[2].trim();
  const player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id));
  const draft = player && db.getDraftForPlayer(player.id, season.id);
  if (!draft) {
    await reply(msg, "Noch keine Liste angelegt.");
    return true;
  }
  if (draft.status !== "draft") {
    await reply(msg, frozenSentence(season.year));
    return true;
  }
  const entries = db.listDraftEntries(draft.id);
  const entry = entries[num - 1];
  if (!entry) {
    await reply(msg, `Kein Eintrag Nr. **${num}**.`);
    return true;
  }
  db.replaceDraftEntryName(entry.id, newName);
  setDraftAck(draft.id, false);
  await resolvePendingSynchronous(ctx, msg.channel, msg.author.id, season, draft.id, "replace");
  return true;
}

async function resolvePendingSynchronous(ctx, channel, userId, season, draftId, mode) {
  if (busyUsers.has(userId)) {
    rerunUsers.add(userId);
    return;
  }
  busyUsers.add(userId);
  let progressMsg = null;
  let quotaTold = false;
  try {
    do {
      rerunUsers.delete(userId);
      const entries = db.listDraftEntries(draftId);
      const pendings = entries.filter((e) => e.link_status === "pending");
      if (!pendings.length) break;
      if (channel.send && !progressMsg) {
        progressMsg = await channel
          .send({ content: `Ordne zu… 0/${entries.length}`, ...mentionOpts() })
          .catch(() => null);
      }
      let i = 0;
      for (const e of pendings) {
        const fresh = db.getDb().prepare("SELECT * FROM pick_draft_entries WHERE id = ?").get(e.id);
        if (!fresh || fresh.link_status !== "pending") continue;
        i++;
        if (progressMsg?.edit) {
          await progressMsg
            .edit({
              content: `Ordne zu ${i}/${entries.length}: ${showName(e.raw_name)}`,
              ...mentionOpts(),
            })
            .catch(() => {});
        }
        try {
          let proposal;
          if (fresh.wiki_url) {
            proposal = await pageLookup.lookupUrl(
              ctx.config.userAgent,
              fresh.wiki_url,
              season.start_date,
              null
            );
          } else {
            const allowed = allowUserWiki(String(userId), ctx.config && ctx.config.tz);
            if (allowed === false) {
              if (!quotaTold && channel.send) {
                quotaTold = true;
                await channel
                  .send({ content: QUOTA_SENTENCE, ...mentionOpts() })
                  .catch(() => {});
              }
              continue;
            }
            proposal = await withWikiSlot(() =>
              pageLookup.proposeWikiForName(ctx.config.userAgent, e.raw_name, season.start_date, null)
            );
          }
          if (proposal && proposal.error && !fresh.wiki_url) {
            continue;
          }
          if (!recheckEntry(e.id, fresh.wiki_url || null)) continue;
          const { linkStatus } = classifyProposal(proposal);
          if (linkStatus === "ambiguous" || linkStatus === "linked") {
            setLinked(e.id, {
              wikiUrl: proposal.wikiUrl,
              wikiNorm: proposal.wikiNorm,
              qid: proposal.qid,
              proposedAge: proposal.proposedAge,
              candidatesJson: JSON.stringify(proposal.candidates || []),
              linkStatus,
              resolvedName: proposal.title || null,
            });
          } else {
            setLinked(e.id, {
              linkStatus,
              wikiUrl: "",
              wikiNorm: "",
              qid: null,
              candidatesJson: JSON.stringify(proposal.candidates || []),
              clearIdentity: true,
            });
            if (!fresh.wiki_url && channel.send) {
              const all = db.listDraftEntries(draftId);
              const n = all.findIndex((x) => x.id === e.id) + 1;
              await channel
                .send({
                  content: `Für **${showName(e.raw_name)}** keinen Personenartikel. Wikipedia-Link schicken, \`entfernen ${n}\`, oder so lassen (dann 0 Punkte).`,
                  ...mentionOpts(),
                })
                .catch(() => {});
            }
          }
        } catch (err) {
          console.warn("[pick] propose failed", e.raw_name, err.message);
          if (fresh.wiki_url) {
            if (recheckEntry(e.id, fresh.wiki_url)) clearLookupFailure(e.id);
          }
          logError(ctx.client, ctx.config, err, {
            where: "pick propose " + e.raw_name,
            userId,
          }).catch(() => {});
        }
      }
    } while (rerunUsers.has(userId));

    const stillPending = db.listDraftEntries(draftId).some((x) => x.link_status === "pending");
    if (progressMsg?.edit && !stillPending) {
      await progressMsg.edit({ content: "Zuordnung fertig.", ...mentionOpts() }).catch(() => {});
    }
    if (mode !== "replace" && channel.send) {
      await respondPick(ctx, channel, userId, season);
    }
  } finally {
    busyUsers.delete(userId);
    interruptUsers.delete(userId);
    if (rerunUsers.has(userId)) {
      rerunUsers.delete(userId);
      void resolvePendingSynchronous(ctx, channel, userId, season, draftId, mode);
    }
  }
}

async function warnAnnouncedPreStartDeaths(ctx) {
  const season = db.getAnnouncedSeason();
  if (!season || season.live !== 0) return 0;
  const rows = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  if (!rows.length) return 0;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      let delivered = !r.user_discord_id;
      if (r.user_discord_id) {
        try {
          const user = await ctx.client.users.fetch(r.user_discord_id);
          const name = showName(r.celeb_name);
          const start = season.start_date || "Saisonstart";
          await user.send({
            content: [
              `⚠️ **${name}** war schneller als Saison **${season.year}**.`,
              `Gestorben vor dem Start (${r.celeb_died_at || "Todesdatum unklar"}). Dafür gibt es keine Punkte.`,
              `Die Zeit des Todes naht — nur nicht für diese Zeile. \`unlock\`, Namen tauschen, wieder \`fertig\`. Geht bis **${start}**.`,
            ].join("\n"),
            ...mentionOpts(),
          });
          delivered = true;
          sent++;
        } catch (e) {
          failed++;
          console.warn("[pick] death-warn DM failed", r.celeb_name, e.message);
          logError(ctx.client, ctx.config, e, {
            where: "death-warn DM " + r.celeb_name,
            userId: String(r.user_discord_id),
          }).catch(() => {});
        }
      }
      if (delivered) db.markAnnouncedDeathWarned(season.id, r.player_id, r.celeb_id);
    } catch (e) {
      failed++;
      console.warn("[pick] death-warn row failed", r.celeb_name, e.message);
      logError(ctx.client, ctx.config, e, {
        where: "death-warn row " + r.celeb_name,
      }).catch(() => {});
    }
  }
  if (rows.length) {
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-death-warn",
      summary: `${sent} Pre-Start-Todes-DM(s) gesendet (${failed} fehlgeschlagen, ${rows.length} Fälle) — Saison ${season.year}`,
    }).catch(() => {});
  }
  return sent;
}

function targetForUrlPaste(entries) {
  return (
    entries.find((e) => e.link_status === "pending") ||
    entries.find((e) => e.link_status === "ambiguous" || e.link_status === "unlinked") ||
    entries.find((e) => e.link_status !== "linked") ||
    null
  );
}

module.exports = {
  tryConsumePickMessage,
  handlePickInteraction,
  respondPick,
  buildPickSelect,
  classifyProposal,
  warnAnnouncedPreStartDeaths,
  targetForUrlPaste,
  resolvePendingSynchronous,
  WIKI_URL_RE,
  LINK_URL_RE,
  WRONG_RE,
  CHANGE_RE,
  busyUsers,
  interruptUsers,
  rerunUsers,
};
