const { EmbedBuilder } = require("discord.js");
const db = require("../db");
const { pickPhrase } = require("../phrases");
const { fetchBestImage } = require("../wiki/page-image");

function emojiBanner(config) {
  return Array(config.alertEmojiRepeat).fill(config.alertEmoji).join(" ");
}

/**
 * Apply death + optional public announce.
 * Uses age_at_pick for scoring (100 - age), not wiki age.
 */
async function processDeathpoolHit(
  client,
  config,
  { celeb, entry, wikiAge },
  { announce = true, confirmed = false, source = "wiki" } = {}
) {
  const result = db.applyDeath(celeb.id, {
    confirmed,
    source,
    diedAt: new Date().toISOString().slice(0, 10),
    wikiUrl: entry?.url || null,
  });

  if (!announce) return result;

  const channel = await client.channels.fetch(config.channelDeathpool).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error("[announce] deathpool channel missing");
    return result;
  }

  const { awards, score, age } = result;
  const winnerNames = awards.map((a) => a.player.display_name);
  const scoreLines = awards.map(
    (a) =>
      `<@${a.player.discord_user_id}> **+${a.points}** (Gesamt **${a.total}**)`
  );

  const roast = pickPhrase(config, db, {
    name: celeb.name,
    age,
    score,
    winners: winnerNames.length ? winnerNames.join(", ") : "niemand",
  });

  const image =
    (await fetchBestImage(
      entry?.lang === "en" ? entry.url : null,
      entry?.url || null,
      config.userAgent
    )) || null;

  const ageLine =
    age != null
      ? `Alter (Pool-Start): **${age}** → Punkte **${score}** (=100−Alter)`
      : "Alter unbekannt → 0 Punkte";
  const wikiAgeLine =
    wikiAge != null && wikiAge !== age ? `Alter (Wiki-Text): ${wikiAge}` : null;

  const embed = new EmbedBuilder()
    .setColor(0x1a1a1a)
    .setTitle(`${celeb.name} ist tot`)
    .setDescription(roast)
    .addFields(
      {
        name: "Details",
        value: [ageLine, wikiAgeLine, entry?.url ? `[Wikipedia](${entry.url})` : null]
          .filter(Boolean)
          .join("\n"),
      },
      {
        name: "Deathpool",
        value: scoreLines.length
          ? scoreLines.join("\n")
          : "_Niemand hatte diesen Pick._",
      }
    )
    .setTimestamp(new Date());

  if (image) embed.setImage(image);

  await channel.send({
    content: `${emojiBanner(config)} **Deathpool-Treffer**`,
    embeds: [embed],
    allowedMentions: {
      parse: [],
      users: awards.map((a) => a.player.discord_user_id),
    },
  });

  return result;
}

async function announceRetraction(client, config, { celeb, awards }) {
  const channel = await client.channels.fetch(config.channelDeathpool).catch(() => null);
  if (!channel?.isTextBased()) return;

  const lines = awards.map((a) => {
    const player = db.getDb().prepare("SELECT * FROM players WHERE id = ?").get(a.player_id);
    const total = player ? db.playerTotal(player.id) : "?";
    return player
      ? `<@${player.discord_user_id}> **−${a.points}** (Gesamt **${total}**)`
      : `player ${a.player_id} −${a.points}`;
  });

  await channel.send({
    content: [
      `↩️ **Rücknahme** — ${celeb.name} steht nicht mehr (zuverlässig) auf den Wiki-Todeslisten.`,
      `Innerhalb von ${config.deathConfirmDays} Tagen widerrufen. Punkte zurückgebucht:`,
      lines.length ? lines.join("\n") : "_keine Punkte_",
    ].join("\n"),
    allowedMentions: {
      parse: [],
      users: awards
        .map((a) => db.getDb().prepare("SELECT discord_user_id FROM players WHERE id = ?").get(a.player_id)?.discord_user_id)
        .filter(Boolean),
    },
  });
}

async function announceAllDeath(client, config, entry, { isDeOnly = false } = {}) {
  if (!config.channelAllDeaths) return;
  const channel = await client.channels.fetch(config.channelAllDeaths).catch(() => null);
  if (!channel?.isTextBased()) return;

  const nameGuess = entry.text.split(",")[0].trim();
  const ageMatch = entry.text.match(/\b(\d{2,3})\b/);
  const age = ageMatch ? ageMatch[1] : null;

  const roast = pickPhrase(
    config,
    db,
    { name: nameGuess, age, score: "—", winners: "niemand" },
    { short: true }
  );

  const embed = new EmbedBuilder()
    .setColor(isDeOnly ? 0x333333 : 0x222222)
    .setTitle(isDeOnly ? `🇩🇪 ${nameGuess}` : `🌍 ${nameGuess}`)
    .setDescription(roast)
    .addFields({
      name: "Link",
      value: `[Wikipedia](${entry.url})${age ? `\nAlter (aus Text): ${age}` : ""}`,
    })
    .setTimestamp(new Date());

  const image = await fetchBestImage(
    entry.lang === "en" ? entry.url : null,
    entry.lang === "de" ? entry.url : null,
    config.userAgent
  );
  if (image) embed.setThumbnail(image);

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function announceDailySummary(client, config) {
  if (!db.isLive()) return;

  const targetId = config.channelAllDeaths || config.channelDeathpool;
  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const rows = db.deathsSinceHours(26);
  if (!rows.length) {
    await channel.send({
      content: "📋 **Tagesbericht** — Seit gestern: keine neuen Tode. Langweilig.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  const en = rows.filter((r) => r.lang === "en");
  const de = rows.filter((r) => r.lang !== "en");
  let msg = `📋 **Tagesbericht** — ${rows.length} neue Einträge seit gestern\n\n`;
  if (en.length) {
    msg += `🌍 **International:**\n`;
    en.slice(0, 20).forEach((e) => {
      msg += `• [${(e.name || e.entry_id).split(",")[0]}](${e.url})\n`;
    });
    if (en.length > 20) msg += `… +${en.length - 20}\n`;
    msg += "\n";
  }
  if (de.length) {
    msg += `🇩🇪 **Nur DE / Regional:**\n`;
    de.slice(0, 15).forEach((e) => {
      msg += `• [${(e.name || e.entry_id).split(",")[0]}](${e.url})\n`;
    });
    if (de.length > 15) msg += `… +${de.length - 15}\n`;
  }

  await channel.send({
    content: msg.slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}

function formatReconcileSummary(hits, season) {
  const lines = [
    `📋 **Reconcile** (Setup, keine Channel-Ankündigungen)`,
    `Saison-Start: **${season.start_date || "?"}** | Live: **nein**`,
    `Neu als tot erkannt: **${hits.length}**`,
    "",
  ];
  for (const h of hits.slice(0, 40)) {
    const awardStr = h.result.awards
      .map((a) => `${a.player.display_name} +${a.points}`)
      .join(", ");
    lines.push(
      `💀 **${h.celeb.name}** — Pool-Alter ${h.result.age ?? "?"} → ${h.result.score} Pkt` +
        (h.wikiAge != null ? ` (Wiki-Alter ${h.wikiAge})` : "") +
        (awardStr ? ` | ${awardStr}` : " | niemand")
    );
  }
  if (hits.length > 40) lines.push(`… +${hits.length - 40}`);
  lines.push("", `Danach \`!scores\` prüfen, dann \`!go\` für Live-Betrieb.`);
  return lines.join("\n").slice(0, 1900);
}

module.exports = {
  processDeathpoolHit,
  announceRetraction,
  announceAllDeath,
  announceDailySummary,
  formatReconcileSummary,
  // back-compat alias
  announceDeathpool: (client, config, m) =>
    processDeathpoolHit(client, config, { ...m, wikiAge: m.age }, { announce: true, confirmed: false }),
};
