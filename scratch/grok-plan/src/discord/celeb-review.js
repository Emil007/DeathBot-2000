const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const db = require("../db");
const { proposeWikiForName, lookupUrl, normalizeWikiUrl } = require("../wiki/page-lookup");

function reviewCustomId(action, celebId) {
  return `crev:${action}:${celebId}`;
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

function buildReviewEmbed(row, proposal, progress) {
  const candidates = parseCandidates(row, proposal);
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
    proposal?.wikiUrl || row.proposed_wiki_url
      ? `Vorschlag Wiki: ${proposal?.wikiUrl || row.proposed_wiki_url}`
      : "_Kein Wikipedia-Treffer_",
  ];
  if (candidates.length > 1) {
    lines.push("", "**Weitere Treffer** (Menü wählen):");
    candidates.slice(0, 3).forEach((c, i) => {
      lines.push(
        `${i + 1}. **${c.title}** (${c.lang || "?"})${c.proposedAge != null ? ` · Alter ${c.proposedAge}` : ""}`
      );
    });
  }
  lines.push("", "Bestätigen bevor Auto-Match. Manual-only = nie Wiki-Kill.");

  const embed = new EmbedBuilder()
    .setColor(0x222222)
    .setTitle(`Wiki/Alter: ${row.celeb_name || row.name}`)
    .setDescription(lines.filter(Boolean).join("\n"));
  if (proposal?.thumb || candidates[0]?.thumb) {
    embed.setThumbnail(proposal?.thumb || candidates[0]?.thumb);
  }
  return embed;
}

function buildReviewButtons(celebId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(reviewCustomId("confirm", celebId))
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(reviewCustomId("wrong", celebId))
      .setLabel("Wrong link")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(reviewCustomId("age", celebId))
      .setLabel("Set age")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(reviewCustomId("nowiki", celebId))
      .setLabel("No wiki")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(reviewCustomId("skip", celebId))
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildCandidateSelect(celebId, candidates) {
  if (!candidates?.length || candidates.length < 2) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(reviewCustomId("pick", celebId))
    .setPlaceholder("Anderen Wiki-Treffer wählen…")
    .addOptions(
      candidates.slice(0, 3).map((c, i) => ({
        label: String(c.title || `Treffer ${i + 1}`).slice(0, 100),
        description: `${c.lang || "?"} · Alter ${c.proposedAge ?? "?"}`
          .slice(0, 100),
        value: String(i),
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

async function sendNextReview(ctx, channelOrUser) {
  const pending = db.countPendingReviews();
  const row = db.nextPendingReview();
  if (!row) {
    if (typeof channelOrUser.send === "function") {
      await channelOrUser.send("Review-Warteschlange leer.");
    } else if (typeof channelOrUser.reply === "function") {
      await channelOrUser.reply({ content: "Review-Warteschlange leer." });
    }
    return null;
  }

  const season = db.getActiveSeason();
  let proposal = {
    wikiUrl: row.proposed_wiki_url,
    proposedAge: row.proposed_age,
    lang: row.proposed_lang,
    candidates: parseCandidates(row, null),
  };
  if (!proposal.wikiUrl || !proposal.candidates?.length) {
    try {
      proposal = await proposeWikiForName(
        ctx.config.userAgent,
        row.celeb_name,
        season.start_date,
        row.sheet_age_hint
      );
      db.enqueueReview(row.celeb_id, proposal);
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
  };
  if (channelOrUser.send) return channelOrUser.send(payload);
  return channelOrUser.reply(payload);
}

async function queueCelebsForReview(ctx, celebIds, notifyTarget) {
  const season = db.getActiveSeason();
  let queued = 0;
  for (const id of celebIds) {
    const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(id);
    if (!celeb) continue;
    if (celeb.wiki_confirmed && !celeb.manual_only && celeb.wiki_url) continue;
    if (celeb.manual_only && celeb.wiki_confirmed) continue;

    let proposal = { proposedAge: celeb.sheet_age_hint };
    try {
      proposal = await proposeWikiForName(
        ctx.config.userAgent,
        celeb.name,
        season.start_date,
        celeb.sheet_age_hint
      );
    } catch (e) {
      console.warn("[review] propose failed", celeb.name, e.message);
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

    db.enqueueReview(celeb.id, proposal);
    queued++;
  }

  if (notifyTarget && queued > 0) {
    await notifyTarget.send?.(
      `**${queued}** Celebs in Wiki-/Alter-Review. Buttons unten oder \`/review\`.`
    );
    await sendNextReview(ctx, notifyTarget);
  }
  return queued;
}

function confirmFromProposal(celebId, celeb, q, proposalExtras = {}) {
  const url = proposalExtras.wikiUrl || q?.proposed_wiki_url || celeb.wiki_url;
  const norm = url ? normalizeWikiUrl(url) : null;
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
  if (interaction.user.id !== ctx.config.adminId) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "Nur Admin.", ephemeral: true });
    }
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("crev:age:")) {
    const celebId = Number(interaction.customId.split(":")[2]);
    const age = parseInt(interaction.fields.getTextInputValue("age"), 10);
    if (!Number.isFinite(age) || age < 1 || age > 130) {
      await interaction.reply({ content: "Ungültiges Alter.", ephemeral: true });
      return true;
    }
    const result = db.setCelebAge(celebId, age);
    if (!result.ok) {
      await interaction.reply({
        content: `Alter gesperrt: ${result.awards} Todes-Punkte existieren schon.`,
        ephemeral: true,
      });
      return true;
    }
    db.getDb()
      .prepare(
        `UPDATE celeb_review_queue SET proposed_age = ?, updated_at = datetime('now') WHERE celeb_id = ?`
      )
      .run(age, celebId);
    await interaction.reply({
      content: `Alter = **${age}**. Danach Confirm.`,
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("crev:url:")) {
    const celebId = Number(interaction.customId.split(":")[2]);
    const url = interaction.fields.getTextInputValue("url").trim();
    const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
    const season = db.getActiveSeason();
    try {
      const proposal = await lookupUrl(
        ctx.config.userAgent,
        url,
        season.start_date,
        celeb?.sheet_age_hint
      );
      db.enqueueReview(celebId, proposal);
      db.clearUrlWait(interaction.user.id);
      await interaction.reply({
        content: `Vorschlag für **${celeb?.name}**: ${proposal.wikiUrl} · Alter ${proposal.proposedAge ?? "?"} · QID ${proposal.qid || "—"}`,
        ephemeral: true,
      });
      await sendNextReview(ctx, interaction.channel);
    } catch (e) {
      await interaction.reply({ content: `Lookup fehlgeschlagen: ${e.message}`, ephemeral: true });
    }
    return true;
  }

  const parsed = parseReviewCustomId(interaction.customId);
  if (!parsed) return false;

  const { action, celebId } = parsed;
  const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb) {
    await interaction.reply({ content: "Celeb weg.", ephemeral: true });
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
      await interaction.reply({ content: "Treffer ungültig.", ephemeral: true });
      return true;
    }
    db.enqueueReview(celebId, {
      wikiUrl: chosen.url,
      wikiNorm: chosen.norm,
      lang: chosen.lang,
      proposedAge: chosen.proposedAge,
      qid: chosen.qid,
      candidates,
      thumb: chosen.thumb,
    });
    await interaction.update({
      content: `Gewählt: **${chosen.title}**. Jetzt Confirm.`,
      embeds: [],
      components: [],
    });
    await sendNextReview(ctx, interaction.channel);
    return true;
  }

  if (!interaction.isButton()) return false;

  if (action === "confirm") {
    confirmFromProposal(celebId, celeb, q);
    await interaction.update({
      content: `Bestätigt **${celeb.name}** → Auto-Match an.`,
      embeds: [],
      components: [],
    });
    await sendNextReview(ctx, interaction.channel);
    return true;
  }

  if (action === "nowiki") {
    db.applyWikiConfirm(celebId, {
      age: q?.proposed_age ?? celeb.age_at_pick ?? celeb.sheet_age_hint,
      manualOnly: true,
    });
    await interaction.update({
      content: `**${celeb.name}** = manual-only (kein Wiki-Auto-Kill).`,
      embeds: [],
      components: [],
    });
    await sendNextReview(ctx, interaction.channel);
    return true;
  }

  if (action === "skip") {
    db.getDb().prepare(`DELETE FROM celeb_review_queue WHERE celeb_id = ?`).run(celebId);
    db.enqueueReview(celebId, {
      wikiUrl: q?.proposed_wiki_url,
      proposedAge: q?.proposed_age,
      lang: q?.proposed_lang,
      candidates: parseCandidates(q, null),
    });
    await interaction.update({
      content: `**${celeb.name}** übersprungen (ans Ende).`,
      embeds: [],
      components: [],
    });
    await sendNextReview(ctx, interaction.channel);
    return true;
  }

  if (action === "age") {
    const modal = new ModalBuilder()
      .setCustomId(reviewCustomId("age", celebId))
      .setTitle(`Alter: ${celeb.name}`.slice(0, 45));
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
      .setTitle(`Wiki-URL: ${celeb.name}`.slice(0, 45));
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
  const season = db.getActiveSeason();
  try {
    const proposal = await lookupUrl(
      ctx.config.userAgent,
      text.split(/\s+/).find((t) => /wikipedia\.org/i.test(t)),
      season.start_date,
      celeb.sheet_age_hint
    );
    db.enqueueReview(wait.celeb_id, proposal);
    await msg.reply(
      `Vorschlag **${celeb.name}**: ${proposal.wikiUrl} · Alter ${proposal.proposedAge ?? "?"} · QID ${proposal.qid || "—"}. \`/review\` fortsetzen.`
    );
    await sendNextReview(ctx, msg.channel);
  } catch (e) {
    await msg.reply(`Lookup fehlgeschlagen: ${e.message}`);
  }
  return true;
}

module.exports = {
  queueCelebsForReview,
  sendNextReview,
  handleReviewInteraction,
  tryConsumeReviewUrl,
  buildReviewButtons,
};
