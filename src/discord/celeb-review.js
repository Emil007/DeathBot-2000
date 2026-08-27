const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const db = require("../db");
const { proposeWikiForName, lookupUrl, normalizeWikiUrl } = require("../wiki/page-lookup");

const awaitingUrl = new Map(); // userId -> { celebId, expires }

function reviewCustomId(action, celebId) {
  return `crev:${action}:${celebId}`;
}

function parseReviewCustomId(id) {
  const m = String(id).match(/^crev:(\w+):(\d+)$/);
  if (!m) return null;
  return { action: m[1], celebId: Number(m[2]) };
}

function buildReviewEmbed(row, proposal, progress) {
  const embed = new EmbedBuilder()
    .setColor(0x222222)
    .setTitle(`Wiki/age review: ${row.celeb_name || row.name}`)
    .setDescription(
      [
        progress ? `Progress: **${progress.done}/${progress.total}** remaining in queue incl. this` : null,
        `Sheet age hint: **${row.sheet_age_hint ?? "—"}**`,
        `Proposed age (season start): **${proposal?.proposedAge ?? row.proposed_age ?? "—"}**`,
        proposal?.wikiUrl || row.proposed_wiki_url
          ? `Proposed wiki: ${proposal?.wikiUrl || row.proposed_wiki_url}`
          : "_No Wikipedia candidate found_",
        "Confirm before auto-matching. Manual-only celebs are never wiki-killed.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  if (proposal?.thumb) embed.setThumbnail(proposal.thumb);
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

async function sendNextReview(ctx, channelOrUser) {
  const pending = db.countPendingReviews();
  const row = db.nextPendingReview();
  if (!row) {
    if (typeof channelOrUser.send === "function") {
      await channelOrUser.send("Review queue empty.");
    } else if (typeof channelOrUser.reply === "function") {
      await channelOrUser.reply({ content: "Review queue empty." });
    }
    return null;
  }

  const season = db.getActiveSeason();
  let proposal = {
    wikiUrl: row.proposed_wiki_url,
    proposedAge: row.proposed_age,
    lang: row.proposed_lang,
  };
  if (!proposal.wikiUrl) {
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

  const embed = buildReviewEmbed(row, proposal, {
    done: 0,
    total: pending,
  });
  const payload = {
    embeds: [embed],
    components: [buildReviewButtons(row.celeb_id)],
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

    // If proposal matches an existing confirmed wiki celeb → merge immediately
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
      `Queued **${queued}** celebs for wiki/age review. Use buttons below or \`!review\`.`
    );
    await sendNextReview(ctx, notifyTarget);
  }
  return queued;
}

async function handleReviewInteraction(ctx, interaction) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return false;
  if (interaction.user.id !== ctx.config.adminId) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "Admin only.", ephemeral: true });
    }
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("crev:age:")) {
    const celebId = Number(interaction.customId.split(":")[2]);
    const age = parseInt(interaction.fields.getTextInputValue("age"), 10);
    if (!Number.isFinite(age) || age < 1 || age > 130) {
      await interaction.reply({ content: "Invalid age.", ephemeral: true });
      return true;
    }
    const result = db.setCelebAge(celebId, age);
    if (!result.ok) {
      await interaction.reply({
        content: `Cannot change age: ${result.awards} death awards already exist for this celeb.`,
        ephemeral: true,
      });
      return true;
    }
    db.getDb()
      .prepare(
        `UPDATE celeb_review_queue SET proposed_age = ?, updated_at = datetime('now') WHERE celeb_id = ?`
      )
      .run(age, celebId);
    await interaction.reply({ content: `Age set to **${age}**. Confirm when ready.`, ephemeral: true });
    return true;
  }

  if (!interaction.isButton()) return false;
  const parsed = parseReviewCustomId(interaction.customId);
  if (!parsed) return false;

  const { action, celebId } = parsed;
  const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celebId);
  if (!celeb) {
    await interaction.reply({ content: "Celeb gone.", ephemeral: true });
    return true;
  }
  const q = db
    .getDb()
    .prepare("SELECT * FROM celeb_review_queue WHERE celeb_id = ?")
    .get(celebId);
  const season = db.getActiveSeason();

  if (action === "confirm") {
    const url = q?.proposed_wiki_url || celeb.wiki_url;
    const norm = url ? normalizeWikiUrl(url) : null;
    db.applyWikiConfirm(celebId, {
      wikiUrl: norm?.url || url,
      wikiNorm: norm?.norm || null,
      age: q?.proposed_age ?? celeb.age_at_pick ?? celeb.sheet_age_hint,
      manualOnly: false,
    });
    await interaction.update({
      content: `Confirmed **${celeb.name}** → auto-match on.`,
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
      content: `**${celeb.name}** = manual-only (no wiki auto-kill).`,
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
    });
    await interaction.update({
      content: `Skipped **${celeb.name}** (moved to end of queue).`,
      embeds: [],
      components: [],
    });
    await sendNextReview(ctx, interaction.channel);
    return true;
  }

  if (action === "age") {
    const modal = new ModalBuilder()
      .setCustomId(reviewCustomId("age", celebId))
      .setTitle(`Set age: ${celeb.name}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("age")
          .setLabel("Age at season start")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "wrong") {
    awaitingUrl.set(interaction.user.id, {
      celebId,
      expires: Date.now() + 5 * 60 * 1000,
    });
    await interaction.reply({
      content: `Send the correct EN or DE Wikipedia URL for **${celeb.name}** (5 min).`,
      ephemeral: true,
    });
    return true;
  }

  return true;
}

async function tryConsumeReviewUrl(ctx, msg) {
  const wait = awaitingUrl.get(msg.author.id);
  if (!wait) return false;
  if (Date.now() > wait.expires) {
    awaitingUrl.delete(msg.author.id);
    return false;
  }
  if (msg.author.id !== ctx.config.adminId) return false;
  const text = msg.content.trim();
  if (!/wikipedia\.org\/wiki\//i.test(text)) return false;

  awaitingUrl.delete(msg.author.id);
  const celeb = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(wait.celebId);
  const season = db.getActiveSeason();
  try {
    const proposal = await lookupUrl(
      ctx.config.userAgent,
      text.split(/\s+/).find((t) => /wikipedia\.org/i.test(t)),
      season.start_date,
      celeb.sheet_age_hint
    );
    db.enqueueReview(wait.celebId, proposal);
    await msg.reply(
      `Updated proposal for **${celeb.name}**: ${proposal.wikiUrl} · age ${proposal.proposedAge ?? "?"}. Use \`!review\` to continue.`
    );
    await sendNextReview(ctx, msg.channel);
  } catch (e) {
    await msg.reply(`Lookup failed: ${e.message}`);
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
