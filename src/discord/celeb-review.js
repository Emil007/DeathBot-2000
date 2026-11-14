const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");
const db = require("../db");
const pageLookup = require("../wiki/page-lookup");

// ANNAHME: M1 (safe-text.js) und M10 (gate.js) sind in diesem Workspace noch nicht
// gemerged. Fehlt die Datei, gilt ein vertragsgleicher Fallback. Ist sie da, gewinnt
// ihr Export bei jedem Aufruf (kein eingefrorener Binding).
const Ephemeral = MessageFlags.Ephemeral;
const LOOKUP_FAIL =
  "Lookup fehlgeschlagen. Die URL ist keine Wikipedia-Seite, oder Wikipedia antwortet nicht.";
const REVIEW_INTRO =
  "Erst **Bestätigen**, dann zählt der automatische Abgleich. **Kein Wiki** heißt: nie automatisch als tot werten.";
const AFTER_CONFIRM = "Danach **Bestätigen**.";
const NOW_CONFIRM = "Jetzt **Bestätigen**.";
const BUTTON_LABEL_MAX = 80;

const REVIEW_BUTTONS = [
  { action: "confirm", label: "Bestätigen", style: ButtonStyle.Success },
  { action: "wrong", label: "Falscher Link", style: ButtonStyle.Primary },
  { action: "age", label: "Alter setzen", style: ButtonStyle.Secondary },
  { action: "nowiki", label: "Kein Wiki", style: ButtonStyle.Danger },
  { action: "skip", label: "Überspringen", style: ButtonStyle.Secondary },
];

function contractModule(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return require(absPath);
}

function fallbackSanitizeDisplayName(raw) {
  if (raw == null) return "„Unbenannt“";
  let s = String(raw);
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "");
  s = s.replace(/[*_~|`<>@[\]()]/g, "");
  s = s.replace(/[ \t\f\v\u00a0]+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || "„Unbenannt“";
}

function fallbackWithWikiSlot(fn) {
  if (!fallbackWithWikiSlot.state) {
    fallbackWithWikiSlot.state = { active: 0, wait: [] };
  }
  const state = fallbackWithWikiSlot.state;
  return new Promise((resolve, reject) => {
    const start = () => {
      state.active += 1;
      Promise.resolve()
        .then(() => fn())
        .then(resolve, reject)
        .finally(() => {
          state.active -= 1;
          const next = state.wait.shift();
          if (next) next();
        });
    };
    if (state.active < 2) start();
    else state.wait.push(start);
  });
}

function sanitizeDisplayName(raw) {
  const mod = contractModule(path.join(__dirname, "safe-text.js"));
  if (!mod) return fallbackSanitizeDisplayName(raw);
  if (typeof mod.sanitizeDisplayName !== "function") {
    throw new Error("safe-text.js must export sanitizeDisplayName");
  }
  return mod.sanitizeDisplayName(raw);
}

function mentionOpts() {
  const mod = contractModule(path.join(__dirname, "safe-text.js"));
  if (!mod) return { allowedMentions: { parse: [] } };
  if (typeof mod.mentionOpts !== "function") {
    throw new Error("safe-text.js must export mentionOpts");
  }
  return mod.mentionOpts();
}

function withWikiSlot(fn) {
  const mod = contractModule(path.join(__dirname, "..", "wiki", "gate.js"));
  if (!mod) return fallbackWithWikiSlot(fn);
  if (typeof mod.withWikiSlot !== "function") {
    throw new Error("gate.js must export withWikiSlot");
  }
  return mod.withWikiSlot(fn);
}

function hidden(content) {
  return { content, flags: Ephemeral, ...mentionOpts() };
}

function said(content) {
  return { content, ...mentionOpts() };
}

function buttonLabel(text) {
  return String(text).slice(0, BUTTON_LABEL_MAX);
}

function displayWikiUrl(url) {
  const norm = pageLookup.normalizeWikiUrl(url);
  return norm?.url || null;
}

function hasProposedUrl(row) {
  return Boolean(row && String(row.proposed_wiki_url || "").trim());
}

function reviewCustomId(action, celebId) {
  return `crev:${action}:${celebId}`;
}

/**
 * Saison der Queue-Zeile eines Celebs — damit die Navigation (sendNextReview,
 * lookupUrl, enqueueReview) in der announced-Saison bleibt statt in die aktive
 * (2026) zu springen (F14).
 */
function seasonForQueue(celebId) {
  const q = db
    .getDb()
    .prepare("SELECT season_id FROM celeb_review_queue WHERE celeb_id = ?")
    .get(celebId);
  if (!q?.season_id) {
    const s = db.getActiveSeason();
    return { season: s, seasonId: s.id };
  }
  const season = db.getDb().prepare("SELECT * FROM seasons WHERE id = ?").get(q.season_id);
  return { season, seasonId: q.season_id };
}

function parseReviewCustomId(id) {
  const m = String(id).match(/^crev:(\w+):(\d+)$/);
  if (!m) return null;
  return { action: m[1], celebId: Number(m[2]) };
}

function parseCandidates(row, proposal) {
  if (proposal?.candidates?.length) return proposal.candidates;
  if (row?.proposed_candidates) {
    try {
      return JSON.parse(row.proposed_candidates) || [];
    } catch {
      return [];
    }
  }
  return [];
}

function proposalFromQueueRow(row) {
  const candidates = parseCandidates(row, null);
  const primary = candidates[0] || {};
  return {
    wikiUrl: row?.proposed_wiki_url || null,
    wikiNorm: primary.norm || null,
    lang: row?.proposed_lang || primary.lang || null,
    proposedAge: row?.proposed_age ?? primary.proposedAge ?? null,
    qid: primary.qid || null,
    candidates: candidates.length ? candidates : undefined,
    thumb: primary.thumb || null,
    title: primary.title || null,
  };
}

function buildReviewEmbed(row, proposal, progress) {
  const candidates = parseCandidates(row, proposal);
  const wikiShown = displayWikiUrl(proposal?.wikiUrl || row.proposed_wiki_url);
  const lines = [
    progress ? `Fortschritt: **${progress.total}** in Warteschlange (inkl. dieser)` : null,
    row.possible_homonym || /homonym/i.test(row.celeb_name || "")
      ? "_Möglicher Homonym — gleicher Name wie ein bestätigter Celeb._"
      : null,
    `Sheet-Alter: **${row.sheet_age_hint ?? "—"}**`,
    `Vorschlag Alter (Saisonstart): **${proposal?.proposedAge ?? row.proposed_age ?? "—"}**`,
    proposal?.qid || row.wikidata_id
      ? `Wikidata: **${proposal?.qid || row.wikidata_id}**`
      : null,
    wikiShown ? `Vorschlag Wiki: ${wikiShown}` : "_Kein Wikipedia-Treffer_",
  ];
  if (candidates.length > 1) {
    lines.push("", "**Weitere Treffer** (Menü wählen):");
    candidates.slice(0, 3).forEach((c, i) => {
      lines.push(
        `${i + 1}. **${sanitizeDisplayName(c.title)}** (${c.lang || "?"})${c.proposedAge != null ? ` · Alter ${c.proposedAge}` : ""}`
      );
    });
  }
  lines.push("", REVIEW_INTRO);

  const embed = new EmbedBuilder()
    .setColor(0x222222)
    .setTitle(`Wiki/Alter: ${sanitizeDisplayName(row.celeb_name || row.name)}`)
    .setDescription(lines.filter(Boolean).join("\n"));
  if (proposal?.thumb || candidates[0]?.thumb) {
    embed.setThumbnail(proposal?.thumb || candidates[0]?.thumb);
  }
  return embed;
}

function buildReviewButtons(celebId) {
  return new ActionRowBuilder().addComponents(
    REVIEW_BUTTONS.map((b) =>
      new ButtonBuilder()
        .setCustomId(reviewCustomId(b.action, celebId))
        .setLabel(buttonLabel(b.label))
        .setStyle(b.style)
    )
  );
}

function buildCandidateSelect(celebId, candidates) {
  if (!candidates?.length || candidates.length < 2) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(reviewCustomId("pick", celebId))
    .setPlaceholder("Anderen Wiki-Treffer wählen…")
    .addOptions(
      candidates.slice(0, 3).map((c, i) => ({
        label: sanitizeDisplayName(c.title || `Treffer ${i + 1}`).slice(0, 100),
        description: `${c.lang || "?"} · Alter ${c.proposedAge ?? "?"}`
          .slice(0, 100),
        value: String(i),
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

async function sendNextReview(ctx, channelOrUser, { season, seasonId } = {}) {
  const pending = db.countPendingReviews({ seasonId });
  const row = db.nextPendingReview(seasonId);
  if (!row) {
    if (typeof channelOrUser.send === "function") {
      await channelOrUser.send(said("Review-Warteschlange leer."));
    } else if (typeof channelOrUser.reply === "function") {
      await channelOrUser.reply(said("Review-Warteschlange leer."));
    }
    return null;
  }

  const effSeason = season || db.getActiveSeason();
  let proposal = proposalFromQueueRow(row);
  // Vorhandene proposed_wiki_url wiederverwenden — auch ohne Kandidatenliste.
  if (!hasProposedUrl(row)) {
    try {
      proposal = await withWikiSlot(() =>
        pageLookup.proposeWikiForName(
          ctx.config.userAgent,
          row.celeb_name,
          effSeason.start_date,
          row.sheet_age_hint
        )
      );
      db.enqueueReview(row.celeb_id, proposal, {
        seasonId: seasonId ?? row.season_id ?? db.getActiveSeason().id,
      });
    } catch (e) {
      console.error("[review] propose", e.message);
    }
  }

  const confirmedHomonym = db
    .getDb()
    .prepare(
      `SELECT 1 AS x FROM celebs WHERE name_key = (
         SELECT name_key FROM celebs WHERE id = ?
       ) AND wiki_confirmed = 1 AND id != ? LIMIT 1`
    )
    .get(row.celeb_id, row.celeb_id);
  if (confirmedHomonym) row.possible_homonym = true;

  const components = [buildReviewButtons(row.celeb_id)];
  const select = buildCandidateSelect(row.celeb_id, proposal.candidates || parseCandidates(row, proposal));
  if (select) components.unshift(select);

  const payload = {
    embeds: [
      buildReviewEmbed(row, proposal, {
        done: 0,
        total: pending,
      }),
    ],
    components,
    ...mentionOpts(),
  };
  if (channelOrUser.send) return channelOrUser.send(payload);
  return channelOrUser.reply(payload);
}

async function queueCelebsForReview(ctx, celebIds, notifyTarget, { season } = {}) {
  const effSeason = season || db.getActiveSeason();
  const effSeasonId = effSeason.id;
  let queued = 0;
  for (const id of celebIds) {
    const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(id);
    if (!celeb) continue;
    if (celeb.wiki_confirmed && !celeb.manual_only && celeb.wiki_url) continue;
    if (celeb.manual_only && celeb.wiki_confirmed) continue;

    const existingQ = db
      .getDb()
      .prepare("SELECT * FROM celeb_review_queue WHERE celeb_id = ?")
      .get(celeb.id);

    let proposal;
    if (hasProposedUrl(existingQ)) {
      proposal = proposalFromQueueRow(existingQ);
    } else {
      proposal = { proposedAge: celeb.sheet_age_hint };
      try {
        proposal = await withWikiSlot(() =>
          pageLookup.proposeWikiForName(
            ctx.config.userAgent,
            celeb.name,
            effSeason.start_date,
            celeb.sheet_age_hint
          )
        );
      } catch (e) {
        console.warn("[review] propose failed", celeb.name, e.message);
      }
    }

    // Merge if proposal matches existing identity (QID or wiki norm)
    if (proposal.qid) {
      const byQ = db.findCelebByWikidataId(proposal.qid);
      if (byQ && byQ.id !== celeb.id) {
        db.mergeCelebs(byQ.id, celeb.id);
        continue;
      }
    }
    if (proposal.wikiNorm) {
      const existing = db.findCelebByWikiNorm(proposal.wikiNorm);
      if (existing && existing.id !== celeb.id) {
        db.mergeCelebs(existing.id, celeb.id);
        continue;
      }
    }

    const r = db.enqueueReview(celeb.id, proposal, { seasonId: effSeasonId });
    if (r.queued) queued++;
  }

  if (notifyTarget && queued > 0) {
    await notifyTarget.send?.(
      said(`**${queued}** Celebs in Wiki-/Alter-Review. Buttons unten oder \`/review\`.`)
    );
    await sendNextReview(ctx, notifyTarget, { season: effSeason, seasonId: effSeasonId });
  }
  return queued;
}

function confirmFromProposal(celebId, celeb, q, proposalExtras = {}) {
  const url = proposalExtras.wikiUrl || q?.proposed_wiki_url || celeb.wiki_url;
  const norm = url ? pageLookup.normalizeWikiUrl(url) : null;
  let candidates = [];
  try {
    candidates = q?.proposed_candidates ? JSON.parse(q.proposed_candidates) : [];
  } catch {
    candidates = [];
  }
  const match = candidates.find((c) => c.url === url || c.norm === norm?.norm);
  db.applyWikiConfirm(celebId, {
    wikiUrl: proposalExtras.wikiUrl || norm?.url || url,
    wikiNorm: proposalExtras.wikiNorm || norm?.norm || null,
    wikiUrlDe: proposalExtras.wikiUrlDe || null,
    wikidataId: proposalExtras.qid || match?.qid || null,
    age:
      proposalExtras.proposedAge ??
      q?.proposed_age ??
      celeb.age_at_pick ??
      celeb.sheet_age_hint,
    manualOnly: false,
  });
}

async function handleReviewInteraction(ctx, interaction) {
  if (
    !interaction.isButton() &&
    !interaction.isModalSubmit() &&
    !interaction.isStringSelectMenu()
  ) {
    return false;
  }
  // Fremde Custom-IDs (z.B. pka: des Pick-Assistenten) NICHT hier abfangen:
  // das Admin-Gate darunter würde den Nicht-Admin-Button verschlucken.
  if (!String(interaction.customId || "").startsWith("crev:")) return false;
  if (interaction.user.id !== ctx.config.adminId) {
    if (interaction.isRepliable()) {
      await interaction.reply(hidden("Nur Admin."));
    }
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("crev:age:")) {
    const celebId = Number(interaction.customId.split(":")[2]);
    const age = parseInt(interaction.fields.getTextInputValue("age"), 10);
    if (!Number.isFinite(age) || age < 1 || age > 130) {
      await interaction.reply(hidden("Ungültiges Alter."));
      return true;
    }
    const { season, seasonId } = seasonForQueue(celebId);
    const isAnnounced = season?.phase === "announced";
    if (isAnnounced) {
      // Das maßgebliche 2027er-Alter liegt auf picks.age_at_pick (F15):
      // Feed alle Spieler, die den Celeb in dieser Saison gepickt haben.
      const info = db
        .getDb()
        .prepare("UPDATE picks SET age_at_pick = ? WHERE celeb_id = ? AND season_id = ?")
        .run(age, celebId, seasonId);
      db.getDb()
        .prepare(
          `UPDATE celeb_review_queue SET proposed_age = ?, updated_at = datetime('now') WHERE celeb_id = ?`
        )
        .run(age, celebId);
      await interaction.reply(
        hidden(
          `Alter = **${age}** (${info.changes} Player-Picks in Saison ${season.year}). ${AFTER_CONFIRM}`
        )
      );
      return true;
    }
    const result = db.setCelebAge(celebId, age);
    if (!result.ok) {
      await interaction.reply(
        hidden(`Alter gesperrt: ${result.awards} Todes-Punkte existieren schon.`)
      );
      return true;
    }
    db.getDb()
      .prepare(
        `UPDATE celeb_review_queue SET proposed_age = ?, updated_at = datetime('now') WHERE celeb_id = ?`
      )
      .run(age, celebId);
    await interaction.reply(hidden(`Alter = **${age}**. ${AFTER_CONFIRM}`));
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("crev:url:")) {
    // Ack zuerst (Discord-Fenster 3s), danach der langsame Lookup, dann editReply.
    let deferred = false;
    try {
      await interaction.deferReply({ flags: Ephemeral });
      deferred = true;
      const celebId = Number(interaction.customId.split(":")[2]);
      const url = interaction.fields.getTextInputValue("url").trim();
      const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
      const { season, seasonId } = seasonForQueue(celebId);
      const proposal = await withWikiSlot(() =>
        pageLookup.lookupUrl(
          ctx.config.userAgent,
          url,
          season?.start_date,
          celeb?.sheet_age_hint
        )
      );
      db.enqueueReview(celebId, proposal, { seasonId });
      db.clearUrlWait(interaction.user.id);
      const shown = displayWikiUrl(proposal?.wikiUrl);
      await interaction.editReply(
        said(
          `Vorschlag für **${sanitizeDisplayName(celeb?.name)}**: ${shown || "—"} · Alter ${proposal?.proposedAge ?? "?"} · QID ${proposal?.qid || "—"}`
        )
      );
      await sendNextReview(ctx, interaction.channel, { season, seasonId });
    } catch (e) {
      console.error("[review] url", e?.message || e);
      const payload = said(LOOKUP_FAIL);
      if (deferred || interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: Ephemeral });
      }
    }
    return true;
  }

  const parsed = parseReviewCustomId(interaction.customId);
  if (!parsed) return false;

  const { action, celebId } = parsed;
  const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb) {
    await interaction.reply(hidden("Celeb weg."));
    return true;
  }
  const q = db
    .getDb()
    .prepare("SELECT * FROM celeb_review_queue WHERE celeb_id = ?")
    .get(celebId);

  if (action === "pick" && interaction.isStringSelectMenu()) {
    const idx = parseInt(interaction.values[0], 10);
    let candidates = [];
    try {
      candidates = q?.proposed_candidates ? JSON.parse(q.proposed_candidates) : [];
    } catch {
      candidates = [];
    }
    const chosen = candidates[idx];
    if (!chosen) {
      await interaction.reply(hidden("Treffer ungültig."));
      return true;
    }
    const { season, seasonId } = seasonForQueue(celebId);
    db.enqueueReview(celebId, {
      wikiUrl: chosen.url,
      wikiNorm: chosen.norm,
      lang: chosen.lang,
      proposedAge: chosen.proposedAge,
      qid: chosen.qid,
      candidates,
      thumb: chosen.thumb,
    }, { seasonId });
    await interaction.update({
      content: `Gewählt: **${sanitizeDisplayName(chosen.title)}**. ${NOW_CONFIRM}`,
      embeds: [],
      components: [],
      ...mentionOpts(),
    });
    await sendNextReview(ctx, interaction.channel, { season, seasonId });
    return true;
  }

  if (!interaction.isButton()) return false;

  if (action === "confirm") {
    // F13: Saison VOR dem (evtl. mergenden) Confirm einfrieren und an
    // sendNextReview weiterreichen, analog zum Skip-Pfad. applyWikiConfirm kann
    // celebId per QID/norm-Merge in einen kanonischen Celeb mergen und löscht
    // dabei die Queue-Zeile der Dublette — ein nachträgliches seasonForQueue(celebId)
    // fände keine Zeile mehr und würde in die aktive Saison abrutschen. So bleibt
    // die Navigation nach einem Merge in der announced-Queue.
    const { season, seasonId } = seasonForQueue(celebId);
    confirmFromProposal(celebId, celeb, q);
    await interaction.update({
      content: `Bestätigt **${sanitizeDisplayName(celeb.name)}** → Auto-Match an.`,
      embeds: [],
      components: [],
      ...mentionOpts(),
    });
    await sendNextReview(ctx, interaction.channel, { season, seasonId });
    return true;
  }

  if (action === "nowiki") {
    db.applyWikiConfirm(celebId, {
      age: q?.proposed_age ?? celeb.age_at_pick ?? celeb.sheet_age_hint,
      manualOnly: true,
    });
    const { season, seasonId } = seasonForQueue(celebId);
    await interaction.update({
      content: `**${sanitizeDisplayName(celeb.name)}** = manual-only (kein Wiki-Auto-Kill).`,
      embeds: [],
      components: [],
      ...mentionOpts(),
    });
    await sendNextReview(ctx, interaction.channel, { season, seasonId });
    return true;
  }

  if (action === "skip") {
    const { season, seasonId } = seasonForQueue(celebId);
    // Neu-Einreihung hinten mit DERSELBEN Saison — nie in die aktive/NULL-Queue.
    db.getDb().prepare(`DELETE FROM celeb_review_queue WHERE celeb_id = ?`).run(celebId);
    db.enqueueReview(celebId, {
      wikiUrl: q?.proposed_wiki_url,
      proposedAge: q?.proposed_age,
      lang: q?.proposed_lang,
      candidates: parseCandidates(q, null),
    }, { seasonId });
    await interaction.update({
      content: `**${sanitizeDisplayName(celeb.name)}** übersprungen (ans Ende).`,
      embeds: [],
      components: [],
      ...mentionOpts(),
    });
    await sendNextReview(ctx, interaction.channel, { season, seasonId });
    return true;
  }

  if (action === "age") {
    const modal = new ModalBuilder()
      .setCustomId(reviewCustomId("age", celebId))
      .setTitle(`Alter: ${sanitizeDisplayName(celeb.name)}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("age")
          .setLabel("Alter am Saisonstart")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "wrong") {
    // Prefer modal (survives restarts); also persist waiter for paste fallback
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.setUrlWait(interaction.user.id, celebId, expires);
    const modal = new ModalBuilder()
      .setCustomId(reviewCustomId("url", celebId))
      .setTitle(`Wiki-URL: ${sanitizeDisplayName(celeb.name)}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("url")
          .setLabel("EN/DE Wikipedia /wiki/ URL")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(20)
          .setMaxLength(300)
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  return true;
}

async function tryConsumeReviewUrl(ctx, msg) {
  const wait = db.getUrlWait(msg.author.id);
  if (!wait) return false;
  if (new Date(wait.expires_at).getTime() < Date.now()) {
    db.clearUrlWait(msg.author.id);
    return false;
  }
  if (msg.author.id !== ctx.config.adminId) return false;
  const text = msg.content.trim();
  if (!/wikipedia\.org\/wiki\//i.test(text)) return false;

  db.clearUrlWait(msg.author.id);
  const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(wait.celeb_id);
  const { season, seasonId } = seasonForQueue(wait.celeb_id);
  try {
    const proposal = await withWikiSlot(() =>
      pageLookup.lookupUrl(
        ctx.config.userAgent,
        text.split(/\s+/).find((t) => /wikipedia\.org/i.test(t)),
        season?.start_date,
        celeb?.sheet_age_hint
      )
    );
    db.enqueueReview(wait.celeb_id, proposal, { seasonId });
    const shown = displayWikiUrl(proposal?.wikiUrl);
    await msg.reply(
      said(
        `Vorschlag **${sanitizeDisplayName(celeb?.name)}**: ${shown || "—"} · Alter ${proposal?.proposedAge ?? "?"} · QID ${proposal?.qid || "—"}. \`/review\` fortsetzen.`
      )
    );
    await sendNextReview(ctx, msg.channel, { season, seasonId });
  } catch (e) {
    console.error("[review] url paste", e?.message || e);
    await msg.reply(said(LOOKUP_FAIL));
  }
  return true;
}

module.exports = {
  queueCelebsForReview,
  sendNextReview,
  handleReviewInteraction,
  tryConsumeReviewUrl,
  buildReviewButtons,
  seasonForQueue,
  reviewCustomId,
};
