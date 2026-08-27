const { EmbedBuilder } = require("discord.js");
const db = require("../db");
const { pickPhrase } = require("../phrases");
const { fetchBestImage } = require("../wiki/page-image");

function emojiBanner(config) {
  return Array(config.alertEmojiRepeat).fill(config.alertEmoji).join(" ");
}

async function announceDeathpool(client, config, { celeb, entry, age }) {
  const channel = await client.channels.fetch(config.channelDeathpool).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error("[announce] deathpool channel missing");
    return;
  }

  const season = db.getActiveSeason();
  const winners = db.getWinnersForCeleb(celeb.id, season.id);
  const score = db.scoreForAge(age);
  const winnerNames = winners.map((w) => w.display_name);

  db.markCelebDead(celeb.id, new Date().toISOString().slice(0, 10), entry.url);

  const scoreLines = [];
  for (const w of winners) {
    if (score > 0) db.addPoints(w.id, score);
    const total = db.playerTotal(w.id);
    scoreLines.push(`<@${w.discord_user_id}> **+${score}** (Gesamt **${total}**)`);
  }

  const roast = pickPhrase(config, db, {
    name: celeb.name,
    age,
    score,
    winners: winnerNames.length ? winnerNames.join(", ") : "niemand",
  });

  const image =
    (await fetchBestImage(entry.lang === "en" ? entry.url : null, entry.url, config.userAgent)) ||
    null;

  const embed = new EmbedBuilder()
    .setColor(0x1a1a1a)
    .setTitle(`${celeb.name} ist tot`)
    .setDescription(roast)
    .addFields(
      {
        name: "Details",
        value: [
          age != null ? `Alter: **${age}**` : "Alter: unbekannt",
          entry.url ? `[Wikipedia](${entry.url})` : null,
          `Punkte pro Treffer: **${score}**`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        name: "Deathpool",
        value: scoreLines.length
          ? scoreLines.join("\n")
          : "_Niemand hatte diesen Pick. Pech für euch, Freude für mich._",
      }
    )
    .setTimestamp(new Date());

  if (image) embed.setImage(image);

  const banner = `${emojiBanner(config)} **Deathpool-Treffer**`;
  await channel.send({
    content: banner,
    embeds: [embed],
    allowedMentions: {
      parse: [],
      users: winners.map((w) => w.discord_user_id),
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

module.exports = {
  announceDeathpool,
  announceAllDeath,
  announceDailySummary,
};
