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
const { parsePickList } = require("./pick-parse");
const { canParticipate } = require("./membership");
const { proposeWikiForName } = require("../wiki/page-lookup");
const { queueCelebsForReview, sendNextReview } = require("./celeb-review");
const { resolveAdminTarget } = require("./admin-notify");
const { logEvent } = require("./log");

const DONE_RE = /^(fertig|done|end|liste fertig)$/i;
const REMOVE_RE = /^entfern\w*\s+(\d+)$/i;
const CHANGE_RE = /^(?:änder|aendere|ändere|change)\s+(\d+)\s+(.+)$/i;
const UNLOCK_RE = /^(unlock|entsperren|oeffnen|öffnen)$/i;

/** In-Memory-Queue: ein Wiki-Auflösungs-Lauf pro User, nicht parallel. */
const busyUsers = new Set();

/** link_status je nach Proposal. Exportiert für Tests. */
function classifyProposal(proposal) {
  const cands = proposal?.candidates || [];
  if (!proposal?.wikiUrl) return { linkStatus: "unlinked" };
  const distinctQids = new Set(cands.map((c) => c.qid).filter(Boolean));
  if (cands.length >= 2 && distinctQids.size >= 2) return { linkStatus: "ambiguous" };
  return { linkStatus: "linked" };
}

function draftEmbed(entries, season, draftStatus = "draft") {
  const lines = entries.length
    ? entries.map((e, i) => {
        const link = e.wiki_url ? `[Wiki](${e.wiki_url})` : "ohne Artikel";
        const age = e.proposed_age != null ? ` · Alter ${e.proposed_age}` : "";
        const dead = e.is_alive === 0 ? " · ☠️ vor Start gestorben" : "";
        return `${i + 1}. **${e.raw_name}** — ${link}${age}${e.link_status === "ambiguous" ? " ⚠️" : ""}${dead}`;
      })
    : ["_(noch keine Namen)_"];
  const embed = new EmbedBuilder()
    .setColor(draftStatus === "finalized" ? 0x1f8b4c : 0x222a33)
    .setTitle(`Deine Tipps für Saison ${season?.year || "?"} (Start ${season?.start_date || "?"})`)
    .setDescription(
      [
        draftStatus === "finalized"
          ? "🔒 **Liste eingefroren** — Personen, die vor dem Saisonstart sterben, werden dir hier gemeldet; mit `unlock` kannst du bis zum Start jederzeit ändern."
          : "Schick Namen einzeln oder als Liste (eine Zeile / Semikolon / Strich).",
        draftStatus === "finalized"
          ? "`unlock` (bearbeiten) · `fertig` war schon"
          : "`entfernen 3` · `ändern 3 Neuer Name` · `fertig`/`done`, wenn die Liste passt.",
        "",
        ...lines,
      ].join("\n")
    );
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
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`pka:pick:${entry.id}`)
    .setPlaceholder(`Person wählen: ${entry.raw_name.slice(0, 60)}…`)
    .addOptions(
      candidates.slice(0, 3).map((c, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(String(c.title || `Kandidat ${i + 1}`).slice(0, 100))
          .setDescription(`${c.lang || "?"} · Alter ${c.proposedAge ?? "?"}`.slice(0, 50))
          .setValue(String(i))
      )
    );
  return new ActionRowBuilder().addComponents(menu);
}

async function respondPick(ctx, channel, userId, season, extra = []) {
  let player = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(userId));
  if (!player) {
    const info = db
      .prepare("INSERT INTO players (display_name, discord_user_id, base_points) VALUES (?, ?, 0)")
      .run(String(userId), String(userId));
    player = db.getDb().prepare("SELECT * FROM players WHERE id = ?").get(info.lastInsertRowid);
  }
  const draft = db.getOrCreateDraft(player.id, season.id);
  const entries = draft.status === "finalized" ? enrichDeadFlags(listDraftEntriesForFinalized(player.id, season.id)) : db.listDraftEntries(draft.id);
  const payload = { embeds: [draftEmbed(entries, season, draft.status)] };
  const select = buildPickSelect(entries);
  if (select) payload.components = [select];
  if (channel.send) {
    await channel.send(payload);
  } else if (channel.reply) {
    await channel.reply(payload);
  }
}

/** Finalisierte Liste: die angelegten picks (inkl. Sterbe-Status) anzeigen. */
function listDraftEntriesForFinalized(playerId, seasonId) {
  return db.getAnnouncedSeasonPicksForPlayer(playerId, seasonId).map((p) => ({
    id: p.celeb_id,
    raw_name: p.celeb_name,
    wiki_url: p.wiki_url,
    is_alive: p.is_alive,
    link_status: "linked",
    position: p.id,
  }));
}

function enrichDeadFlags(entries) {
  return entries.map((e) => ({
    ...e,
    isAlive: e.is_alive,
  }));
}

/** Kandidaten-Auswahl aus einem pka:pick-Select verarbeiten. */
async function handlePickInteraction(ctx, interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!String(interaction.customId || "").startsWith("pka:pick:")) return false;
  const entryId = Number(interaction.customId.split(":")[2]);
  if (!entryId) return false;

  // Ack zuerst (Discord-Fenster), DANACH DB/Wiki
  if (interaction.isDeferred?.() || interaction.deferred) {
    await interaction.editReply({ content: "…", components: [] }).catch(() => {});
  } else {
    await interaction.deferUpdate().catch(() => {});
  }

  const chan = interaction.channel;
  const userId = interaction.user.id;
  // Teilenachweis
  const part = await canParticipate(ctx.client, ctx.config, userId);
  if (!part.ok) {
    await interaction.followUp?.({ content: "Teilnahme nicht erlaubt.", ephemeral: true }).catch(() => {});
    return true;
  }
  const season = part.season;

  const entry = db
    .getDb()
    .prepare("SELECT * FROM pick_draft_entries WHERE id = ?")
    .get(entryId);
  if (!entry) {
    await interaction.followUp?.({ content: "Eintrag nicht gefunden.", ephemeral: true }).catch(() => {});
    return true;
  }
  let candidates = [];
  try {
    candidates = JSON.parse(entry.candidates_json || "[]");
  } catch {
    candidates = [];
  }
  const chosen = candidates[Number(interaction.values[0])];
  if (!chosen) {
    await interaction.followUp?.({ content: "Kandidat ungültig.", ephemeral: true }).catch(() => {});
    return true;
  }
  db.setDraftEntryLinked(entryId, {
    wikiUrl: chosen.url,
    wikiNorm: chosen.norm,
    qid: chosen.qid,
    proposedAge: chosen.proposedAge,
    linkStatus: "linked",
  });
  await logEvent(ctx.client, ctx.config, {
    kind: "pick-link",
    summary: `Kandidat gewählt: ${entry.raw_name} → ${chosen.title} (Saison ${season.year})`,
    userId,
  });
  await respondPick(ctx, chan, userId, season);
  return true;
}

/**
 * Eine DM des Spielers verarbeiten. Liefert true, wenn sie konsumiert wurde.
 */
async function tryConsumePickMessage(ctx, msg) {
  if (msg.guildId) return false; // nur DMs
  const part = await canParticipate(ctx.client, ctx.config, msg.author.id);
  if (!part.ok) {
    if (part.reason === "not-member") {
      await msg.author
        .send(
          "Die Anmeldung für die nächste Runde ist an den angekündigten Kanal gebunden. Wer den Kanal nicht sehen kann, kann keine Tipps abgeben."
        )
        .catch(() => {});
      await logEvent(ctx.client, ctx.config, {
        kind: "pick-denied",
        summary: "Tipp von Nicht-Mitglied des Announce-Kanals abgelehnt.",
        userId: msg.author.id,
      });
    }
    return false;
  }
  const season = part.season;

  const body = msg.content.trim();

  // feste Kommandos
  if (UNLOCK_RE.test(body)) {
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    if (!player) {
      await msg.reply("Noch keine Liste angelegt.");
      return true;
    }
    const draft = db.getDraftForPlayer(player.id, season.id);
    if (draft?.status !== "finalized") {
      await msg.reply("Deine Liste ist nicht eingefroren — du kannst sie jederzeit direkt bearbeiten.");
      return true;
    }
    const res = db.unlockDraftForPlayer(player.id, season.id);
    if (res.unlocked) {
      await logEvent(ctx.client, ctx.config, {
        kind: "pick-unlock",
        summary: `Draft entsperrt (Saison ${season.year})`,
        userId: msg.author.id,
      });
      await msg.reply(
        [
          `🔓 Deine Liste für **${season.year}** ist wieder offen.`,
          "Du kannst Namen ändern/entfernen/hinzufügen und mit `fertig` erneut einfrieren.",
        ].join("\n")
      );
      await respondPick(ctx, msg.channel, msg.author.id, season);
    } else {
      await msg.reply("Entsperren fehlgeschlagen (" + res.error + ").");
    }
    return true;
  }

  if (DONE_RE.test(body)) {
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    if (!player) {
      await msg.reply("Noch keine Liste angelegt.");
      return true;
    }
    const draft = db.getDraftForPlayer(player.id, season.id);
    if (!draft) {
      await msg.reply("Noch keine Liste angelegt.");
      return true;
    }
    const res = db.finalizeDraft(player.id, season.id);
    if (res.locked) {
      await msg.reply("Deine Liste ist bereits eingefroren.");
    } else if (res.blocked) {
      await msg.reply(
        "Ein Name ist noch unklar (⚠️). Wähle zuerst die passende Person aus, dann `fertig`."
      );
      await respondPick(ctx, msg.channel, msg.author.id, season);
    } else {
      await logEvent(ctx.client, ctx.config, {
        kind: "pick-finalize",
        summary: `Draft finalisiert (${res.added} Tipps, Saison ${season.year})`,
        userId: msg.author.id,
      });
      await msg.reply(
        [
          `✅ Liste für **${season.year}** eingefroren (${res.added} Tipps).`,
          "Gregg bestätigt die Wikipedia-Zuordnung neuer Namen noch (`/review` durch den Admin).",
          "Punkte gelten mit Alter zum **" + (season.start_date || "Saisonstart") + "**.",
        ].join("\n")
      );
      // Neue, unbestätigte Celebs in die 2027er-Review stellen
      if (res.reviewIds?.length) {
        const adminTarget = await resolveAdminTarget(ctx, {});
        await queueCelebsForReview(ctx, res.reviewIds, adminTarget || msg.channel, { season });
      }
    }
    return true;
  }

  if (REMOVE_RE.test(body)) {
    const num = Number(body.match(REMOVE_RE)[1]);
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    const draft = player && db.getDraftForPlayer(player.id, season.id);
    if (!draft) {
      await msg.reply("Noch keine Liste angelegt.");
      return true;
    }
    const entries = db.listDraftEntries(draft.id);
    const entry = entries[num - 1];
    if (!entry) {
      await msg.reply(`Kein Eintrag Nr. **${num}**.`);
      return true;
    }
    db.removeDraftEntry(entry.id);
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-remove",
      summary: `Name entfernt: ${entry.raw_name} (Saison ${season.year})`,
      userId: msg.author.id,
    });
    await respondPick(ctx, msg.channel, msg.author.id, season);
    return true;
  }

  if (CHANGE_RE.test(body)) {
    const m = body.match(CHANGE_RE);
    const num = Number(m[1]);
    const newName = m[2].trim();
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    const draft = player && db.getDraftForPlayer(player.id, season.id);
    if (!draft) {
      await msg.reply("Noch keine Liste angelegt.");
      return true;
    }
    const entries = db.listDraftEntries(draft.id);
    const entry = entries[num - 1];
    if (!entry) {
      await msg.reply(`Kein Eintrag Nr. **${num}**.`);
      return true;
    }
    db.replaceDraftEntryName(entry.id, newName);
    // neu auflösen
    await resolvePendingSynchronous(ctx, msg.channel, msg.author.id, season, draft.id, "replace");
    return true;
  }

  // Liste / einzelne Namen
  const parsed = parsePickList(body);
  if (!parsed.names.length) {
    return false; // keine Namen - nicht konsumieren
  }
  const playerRow = db
    .getDb()
    .prepare("SELECT * FROM players WHERE discord_user_id = ?")
    .get(String(msg.author.id)) || db.upsertPlayer({ displayName: msg.author.username, discordUserId: msg.author.id });
  const draft = db.getOrCreateDraft(playerRow.id, season.id);
  db.addDraftNames(draft.id, parsed.names);

  await logEvent(ctx.client, ctx.config, {
    kind: "pick-add",
    summary: `+${parsed.names.length} Namen (Saison ${season.year})`,
    userId: msg.author.id,
    detail: parsed.names.join(" | ").slice(0, 1200),
  });
  if (parsed.duplicates.length) {
    await msg.reply(`Doppelte ignoriert: ${parsed.duplicates.join(", ")}`);
  }
  await respondPick(ctx, msg.channel, msg.author.id, season);
  // Ambiguities direkt zeigen
  const entries = db.listDraftEntries(draft.id);
  const select = buildPickSelect(entries);
  if (select) {
    await msg.channel.send({ content: "Ein Name ist mehrdeutig — bitte Person wählen:", components: [select] });
  }
  void resolvePendingSynchronous(ctx, msg.channel, msg.author.id, season, draft.id, "add");
  return true;
}

/**
 * Hängt an: neue `pending`-Entries der Reihe nach mit proposWikiForName auflösen
 * und als linked/ambiguous/unlinked markieren. Kein Promise.all, 350ms-Pausen
 * stecken in proposeWikiForName.
 */
async function resolvePendingSynchronous(ctx, channel, userId, season, draftId, mode) {
  if (busyUsers.has(userId)) return;
  busyUsers.add(userId);
  try {
    const entries = db.listDraftEntries(draftId);
    for (const e of entries) {
      if (e.link_status !== "pending") continue;
      try {
        const proposal = await proposeWikiForName(
          ctx.config.userAgent,
          e.raw_name,
          season.start_date,
          null
        );
        const { linkStatus } = classifyProposal(proposal);
        if (linkStatus === "ambiguous") {
          db.setDraftEntryLinked(e.id, {
            wikiUrl: proposal.wikiUrl,
            wikiNorm: proposal.wikiNorm,
            qid: proposal.qid,
            proposedAge: proposal.proposedAge,
            candidates_json: JSON.stringify(proposal.candidates || []),
            linkStatus,
          });
        } else if (linkStatus === "linked") {
          db.setDraftEntryLinked(e.id, {
            wikiUrl: proposal.wikiUrl,
            wikiNorm: proposal.wikiNorm,
            qid: proposal.qid,
            proposedAge: proposal.proposedAge,
            linkStatus,
          });
        } else {
          db.setDraftEntryLinked(e.id, { linkStatus });
        }
      } catch (e) {
        console.warn("[pick] propose failed", e.raw_name, e.message);
        db.setDraftEntryLinked(e.id, { linkStatus: "unlinked" });
      }
    }
    // Fortschritt zeigen (falls es Ambiguities gibt)
    const all = db.listDraftEntries(draftId);
    if (all.some((x) => x.link_status === "ambiguous")) {
      const select = buildPickSelect(all);
      if (select && channel.send) {
        await channel.send({ content: "Bitte Person wählen:", components: [select] }).catch(() => {});
      }
    }
    if (mode !== "replace" && channel.send) {
      await respondPick(ctx, channel, userId, season);
    }
  } finally {
    busyUsers.delete(userId);
  }
}

/**
 * Pre-Start-Todeswarnungen versenden: findet ungewarnete announced-Picks,
 * deren Celeb vor dem Saisonstart gestorben ist, und kontaktiert den Einreicher
 * per DM einmalig. Aufruf nach jeder Deathpool-/Retractions-Verarbeitung, solange
 * die announced-Saison noch live=0 ist.
 */
async function warnAnnouncedPreStartDeaths(ctx) {
  const season = db.getAnnouncedSeason();
  if (!season || season.live !== 0) return 0;
  const rows = db.getAnnouncedPreStartDeathsUnwarned(season.id);
  if (!rows.length) return 0;
  let sent = 0;
  for (const r of rows) {
    try {
      if (r.user_discord_id) {
        try {
          const user = await ctx.client.users.fetch(r.user_discord_id);
          await user.send(
            [
              `⚠️ **${r.celeb_name}** — einer deiner Tipps für Saison **${season.year}** ist **vor dem Saisonstart gestorben** (${r.celeb_died_at || "Todesdatum unklar"}).`,
              `Schreib mir \`unlock\`, ersetze den Namen und frier die Liste wieder ein — bis zum Start (${season.start_date || "Saisonstart"}) ist das jederzeit möglich.`,
            ].join("\n")
          );
          sent++;
        } catch (e) {
          console.warn("[pick] death-warn DM failed", r.celeb_name, e.message);
        }
      }
      db.markAnnouncedDeathWarned(season.id, r.player_id, r.celeb_id);
    } catch (e) {
      console.warn("[pick] death-warn row failed", r.celeb_name, e.message);
    }
  }
  if (rows.length) {
    const { logEvent } = require("./log");
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-death-warn",
      summary: `${rows.length} Pre-Start-Tode an Tipp-Einreicher gemeldet (Saison ${season.year})`,
    });
  }
  return sent;
}

module.exports = {
  tryConsumePickMessage,
  handlePickInteraction,
  respondPick,
  buildPickSelect,
  classifyProposal,
  warnAnnouncedPreStartDeaths,
};
