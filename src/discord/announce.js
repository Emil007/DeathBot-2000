const { EmbedBuilder } = require("discord.js");
const db = require("../db");
const { pickPhrase } = require("../phrases");
const { fetchBestImage } = require("../wiki/page-image");
const { fetchDeathBrief, resolveDeathImage } = require("../wiki/death-brief");

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
      celeb.wiki_url || (entry?.lang === "en" ? entry.url : null),
      celeb.wiki_url_de || (entry?.lang === "de" ? entry.url : null) || entry?.url,
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

  // Thumbnail sits beside the text (Discord layout); full-width setImage is too large
  if (image) embed.setThumbnail(image);

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

  const brief = await fetchDeathBrief(entry.url, config.userAgent, {
    listText: entry.text,
  });

  const name = brief.name || entry.text.split(",")[0].trim();
  const detailLines = [];
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
  if (brief.knownFor) detailLines.push(`Bekannt für: ${brief.knownFor}`);

  // Death-list blurb minus leading "Name, age," — extra context (country, role)
  let listNote = null;
  if (entry.text) {
    let rest = String(entry.text).replace(/\[\d+\]/g, "").trim();
    const nameRe = new RegExp(
      `^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
      "i"
    );
    rest = rest.replace(nameRe, "").replace(/^[,:\-–]\s*/, "");
    rest = rest.replace(/^\(?\s*\d{2,3}\s*\)?\s*[,;]?\s*/, "").trim();
    if (rest.length >= 12 && rest.toLowerCase() !== (brief.summary || "").toLowerCase()) {
      listNote = rest.length > 220 ? rest.slice(0, 219).trim() + "…" : rest;
    }
  }

  const description =
    brief.summary ||
    listNote ||
    "_Neuer Eintrag auf der Wikipedia-Todesliste._";

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
        value: `[Wikipedia](${brief.url || entry.url})`,
      }
    )
    .setTimestamp(new Date());

  const image = await resolveDeathImage(brief, entry, config.userAgent);
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
    `📋 **Reconcile** (setup / pre-live — no channel announcements)`,
    `Season start: **${season.start_date || "?"}** | Live: **${season.live ? "yes" : "no"}**`,
    `Newly marked dead: **${hits.length}**`,
    "",
  ];
  const mismatches = [];
  for (const h of hits.slice(0, 40)) {
    const awardStr = h.result.awards
      .map((a) => `${a.player.display_name} +${a.points}`)
      .join(", ");
    lines.push(
      `💀 **${h.celeb.name}** — pool age ${h.result.age ?? "?"} → ${h.result.score} pts` +
        (h.wikiAge != null ? ` (wiki age ${h.wikiAge})` : "") +
        (awardStr ? ` | ${awardStr}` : " | nobody")
    );
    if (
      h.wikiAge != null &&
      h.result.age != null &&
      Math.abs(Number(h.wikiAge) - Number(h.result.age)) >= 3
    ) {
      mismatches.push(`${h.celeb.name}: pool ${h.result.age} vs wiki ${h.wikiAge}`);
    }
  }
  if (hits.length > 40) lines.push(`… +${hits.length - 40}`);
  if (mismatches.length) {
    lines.push("", "⚠️ Large pool-age vs wiki-age gaps:");
    mismatches.slice(0, 15).forEach((m) => lines.push(`• ${m}`));
  }
  lines.push("", "Next: `/scores`, then `/go` if not already live.");
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
  const channel = await client.channels.fetch(config.channelDeathpool).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error("[announce] deathpool channel missing");
    return;
  }

  const score = age != null ? db.scoreForAge(age) : 0;
  const winnerNames = (winners || []).map((w) => w.displayName).filter(Boolean);
  const roast = pickPhrase(config, db, {
    name,
    age,
    score: score || "—",
    winners: winnerNames.length ? winnerNames.join(", ") : "niemand",
  });

  const ageLine =
    age != null
      ? `Alter (Pool-Start): **${age}** → Punkte **${score}** (=100−Alter)`
      : "Alter unbekannt → 0 Punkte";

  // Names only — never <@id> (no pings in simulation)
  let deathpoolValue;
  if (!inPool) {
    deathpoolValue = "_Simulation — nicht im Deathpool (keine Punkte)._";
  } else if (alreadyDead) {
    deathpoolValue = "_Schon tot markiert — Simulation vergibt nichts._";
  } else if (winnerNames.length) {
    deathpoolValue = winnerNames.map((n) => `**${n}** +${score} _(Simulation)_`).join("\n");
  } else {
    deathpoolValue = "_Niemand hatte diesen Pick._";
  }

  const embed = new EmbedBuilder()
    .setColor(0x4a0000)
    .setTitle(`${name} ist tot`)
    .setDescription(roast)
    .addFields(
      {
        name: "Details",
        value: [ageLine, url ? `[Wikipedia](${url})` : null].filter(Boolean).join("\n"),
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

  await channel.send({
    content: `${emojiBanner(config)} **Simulation** (kein DB-Write · keine Pings)`,
    embeds: [embed],
    // Explicitly empty — do not ping even if a phrase somehow contains an id
    allowedMentions: { parse: [], users: [], roles: [] },
  });
}

module.exports = {
  processDeathpoolHit,
  announceRetraction,
  announceAllDeath,
  announceDailySummary,
  announceSimulatedDeath,
  formatReconcileSummary,
  // back-compat alias
  announceDeathpool: (client, config, m) =>
    processDeathpoolHit(client, config, { ...m, wikiAge: m.age }, { announce: true, confirmed: false }),
};
