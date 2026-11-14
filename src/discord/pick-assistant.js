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
const { proposeWikiForName, lookupUrl } = require("../wiki/page-lookup");
const { queueCelebsForReview, sendNextReview } = require("./celeb-review");
const { resolveAdminTarget } = require("./admin-notify");
const { logEvent, logError } = require("./log");

const DONE_RE = /^(fertig|done|end|liste fertig)$/i;
const REMOVE_RE = /^entfern\w*\s+(\d+)$/i;
const CHANGE_RE = /^(?:änder|aendere|ändere|change)\s+(\d+)\s+(.+)$/i;
const UNLOCK_RE = /^(unlock|entsperren|oeffnen|öffnen)$/i;
const LINK_URL_RE = /^link\s+(\d+)\s+(\S+\.wikipedia\.org\/wiki\/\S+)$/i;
const WRONG_RE = /^(?:falsch|nein|wrong|nicht richtig|falsche)\s*(?:\s*(\d+))?$/i;
const WIKI_URL_RE = /^(?:https?:\/\/)?(?:en|de)\.wikipedia\.org\/wiki\/[^\s]+$/i;

/** In-Memory-Queue: ein Wiki-Auflösungs-Lauf pro User, nicht parallel. */
const busyUsers = new Set();
/** User, die während ihres Laufs weitere Namen geschickt haben (Nachlauf). */
const rerunUsers = new Set();

/** link_status je nach Proposal. Exportiert für Tests. */
function classifyProposal(proposal) {
  const cands = proposal?.candidates || [];
  if (!proposal?.wikiUrl) return { linkStatus: "unlinked" };
  // Zwei Treffer sind eine Auswahl — auch wenn weiter einer ohne QID ist (F22):
  // ein stilles Verknüpfen auf den ersten Treffer wäre falsch.
  if (cands.length >= 2) return { linkStatus: "ambiguous" };
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

  // Hilfe: ein nackter Wikipedia-Link in der DM löst den nächsten ungeklärten
  // Eintrag auf („er ist es”) — ohne dass der User nummeriert.
  if (WIKI_URL_RE.test(body) && !LINK_URL_RE.test(body)) {
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    if (!player) {
      await msg.reply("Noch keine Liste angelegt.");
      return true;
    }
    const draft = db.getDraftForPlayer(player.id, season.id);
    if (!draft || draft.status !== "draft") {
      await msg.reply("Kein offener Draft — schick erst Namen, oder `unlock`.");
      return true;
    }
    const entries = db.listDraftEntries(draft.id);
    // nächster Eintrag, der nicht sauber verlinkt ist
    const target = targetForUrlPaste(entries);
    if (!target) {
      await msg.reply("Alle Einträge sind bereits verlinkt — nutze `link <Nummer> <URL>`, um einen gezielt zu ändern.");
      return true;
    }
    // Kurz auf laufende Auto-Auflösung warten, damit keine Überschreibung passiert
    if (busyUsers.has(msg.author.id)) {
      await msg.reply("Moment, ich löse noch Namen auf — gleich nochmal schicken (oder `fertig` warten).");
      return true;
    }
    busyUsers.add(msg.author.id);
    try {
      const proposal = await lookupUrl(ctx.config.userAgent, body, season.start_date, null);
      db.setDraftEntryLinked(target.id, {
        wikiUrl: proposal.wikiUrl,
        wikiNorm: proposal.wikiNorm,
        qid: proposal.qid,
        proposedAge: proposal.proposedAge,
        linkStatus: "linked",
      });
      await logEvent(ctx.client, ctx.config, {
        kind: "pick-link-url",
        summary: `${target.raw_name} → ${body} (Saison ${season.year})`,
        userId: msg.author.id,
      });
    } catch (err) {
      await msg.reply(
        `Mit dieser URL konnte nichts verlinkt werden (**${err.message}**). Nur en./de.wikipedia.org/wiki/…-Links zu Personen funktionieren.`
      );
    } finally {
      busyUsers.delete(msg.author.id);
    }
    await respondPick(ctx, msg.channel, msg.author.id, season);
    return true;
  }

  // „falsch 3” / „nein” — automatisch verlinkten Eintrag als nicht gemeint markieren
  if (WRONG_RE.test(body)) {
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    const draft = player && db.getDraftForPlayer(player.id, season.id);
    if (!draft || draft.status !== "draft") {
      await msg.reply("Kein offener Draft.");
      return true;
    }
    const entries = db.listDraftEntries(draft.id);
    const match = body.match(WRONG_RE);
    const num = match?.[1] ? Number(match[1]) : null;
    const target = num ? entries[num - 1] : entries.find((e) => e.link_status === "linked" || e.link_status === "ambiguous");
    if (!target) {
      await msg.reply("Kein verlinkter Eintrag gefunden. Nutze `falsch <Nummer>`.");
      return true;
    }
    // Link entfernen → wieder pending zur Neu-Auflösung (gemeint war ein anderer
    // oder keiner: User kann neu wählen oder per Link-Paste auflösen).
    db.replaceDraftEntryName(target.id, target.raw_name);
    await logEvent(ctx.client, ctx.config, {
      kind: "pick-wrong",
      summary: `${target.raw_name} als falsch markiert (Link entfernt)`,
      userId: msg.author.id,
    });
    await msg.reply(`⚠️ ${target.raw_name} zur Korrektur zurückgesetzt. Schick einen Wikipedia-Link, wähle aus der Liste, oder lösche den Eintrag.`);
    await respondPick(ctx, msg.channel, msg.author.id, season);
    // NICHT auto-auflösen: Der User hat „falsch” gesagt — er entscheidet, was
    // als Nächstes passiert (URL, Auswahl, entfernen).
    return true;
  }

  // „link 3 <url>” — explizit Eintrag Nr. N mit URL verknüpfen
  if (LINK_URL_RE.test(body)) {
    const m = body.match(LINK_URL_RE);
    const num = Number(m[1]);
    const url = m[2];
    const player = db
      .getDb()
      .prepare("SELECT * FROM players WHERE discord_user_id = ?")
      .get(String(msg.author.id));
    const draft = player && db.getDraftForPlayer(player.id, season.id);
    if (!draft || draft.status !== "draft") {
      await msg.reply("Kein offener Draft.");
      return true;
    }
    const entries = db.listDraftEntries(draft.id);
    const target = entries[num - 1];
    if (!target) {
      await msg.reply(`Kein Eintrag Nr. **${num}**.`);
      return true;
    }
    try {
      const proposal = await lookupUrl(ctx.config.userAgent, url, season.start_date, null);
      db.setDraftEntryLinked(target.id, {
        wikiUrl: proposal.wikiUrl,
        wikiNorm: proposal.wikiNorm,
        qid: proposal.qid,
        proposedAge: proposal.proposedAge,
        linkStatus: "linked",
      });
      await msg.reply(`🔗 ${target.raw_name} → **${proposal.title || url}**`);
    } catch (err) {
      await msg.reply(`Mit dieser URL konnte nichts verlinkt werden (**${err.message}**).`);
    }
    await respondPick(ctx, msg.channel, msg.author.id, season);
    return true;
  }

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
    if (draft.status !== "draft") {
      await msg.reply(`Deine Liste ist eingefroren — mit \`unlock\` öffnest du sie wieder, um Namen zu ändern.`);
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
    if (draft.status !== "draft") {
      await msg.reply(`Deine Liste ist eingefroren — mit \`unlock\` öffnest du sie wieder, um Namen zu ändern.`);
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
  // Bereits laufende Auflösung: nicht droppen, sondern Nachlauf anfordern (F9).
  // Die parallel eingetroffene DM hat ihre Namen schon in die DB geschrieben —
  // der laufende Lauf verarbeitet sie nach seinem aktuellen Durchlauf.
  if (busyUsers.has(userId)) {
    rerunUsers.add(userId);
    return;
  }
  busyUsers.add(userId);
  let progressMsg = null;
  try {
    do {
      rerunUsers.delete(userId);
      const entries = db.listDraftEntries(draftId);
      const pendings = entries.filter((e) => e.link_status === "pending");
      if (!pendings.length) break;
      // F25: Fortschritt statt stillem Warten bei langen Listen
      if (channel.send && !progressMsg) {
        progressMsg = await channel
          .send({ content: `Auflösung läuft… 0/${entries.length}` })
          .catch(() => null);
      }
      let i = 0;
      for (const e of pendings) {
        i++;
        if (progressMsg?.edit) {
          await progressMsg
            .edit({ content: `Auflösung ${i}/${entries.length}: ${e.raw_name}` })
            .catch(() => {});
        }
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
              candidatesJson: JSON.stringify(proposal.candidates || []),
              linkStatus,
            });
          } else if (linkStatus === "linked") {
            db.setDraftEntryLinked(e.id, {
              wikiUrl: proposal.wikiUrl,
              wikiNorm: proposal.wikiNorm,
              qid: proposal.qid,
              proposedAge: proposal.proposedAge,
              candidatesJson: JSON.stringify(proposal.candidates || []),
              linkStatus,
            });
          } else {
            db.setDraftEntryLinked(e.id, {
              linkStatus,
              candidatesJson: JSON.stringify(proposal.candidates || []),
            });
          }
        } catch (err) {
          // Ein Wiki-Fehler ist KEIN "kein Treffer": wird NICHT pending gelassen,
          // sondern als unlinked markiert — sonst blockt `fertig` dauerhaft (F8).
          console.warn("[pick] propose failed", e.raw_name, err.message);
          db.setDraftEntryLinked(e.id, { linkStatus: "unlinked", candidatesJson: null });
          logError(ctx.client, ctx.config, err, {
            where: "pick propose " + e.raw_name,
            userId,
          }).catch(() => {});
        }
      }
    } while (rerunUsers.has(userId));

    if (progressMsg?.edit) {
      await progressMsg.edit({ content: "Auflösung abgeschlossen." }).catch(() => {});
    }
    // Ambiguities nochmal zeigen
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

/** Nächster ungeklärter Eintrag, den eine nackte URL-Paste auflöst. */
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
  WIKI_URL_RE,
  LINK_URL_RE,
  WRONG_RE,
};
