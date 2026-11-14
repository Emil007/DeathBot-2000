const cron = require("node-cron");
const { ChannelType } = require("discord.js");
const db = require("../db");
const { logEvent, logError } = require("../discord/log");
const { sendAdmin } = require("../discord/admin-notify");
const { createPackage } = require("../backup");

/** Nächstes Jahr relativ zur laufenden Saison/aktuellen Datum. */
function nextYear(running) {
  const base = running?.year || new Date().getFullYear();
  return base + 1;
}

/**
 * Baut die Jahresauswertung („nette Auswertung des Vorjahres") als Discord-Nachricht.
 * Zeigt die Platzierungen der archivierten Saison (via season_point_snapshots)
 * + Anzahl Todesfälle des Jahres.
 */
function formatSeasonReviewText(review, runningYear) {
  if (!review) return null;
  const { season, rows, deaths } = review;
  const lines = [];
  lines.push(`📊 **Saison ${season.year} — Abschlussbilanz**`);
  lines.push("");
  if (!rows.length) {
    lines.push("Keine Punkte verbucht. Stille Saison.");
  } else {
    const medal = ["🥇", "🥈", "🥉"];
    rows.slice(0, 10).forEach((r, i) => {
      const badge = medal[i] ?? `${i + 1}.`;
      lines.push(`${badge} **${r.name}** — ${r.total} Punkte${r.hits ? `, ${r.hits} Treffer` : ""}`);
    });
    if (rows.length > 10) lines.push(`… +${rows.length - 10} weitere`);
  }
  lines.push("");
  lines.push(`💀 **${deaths}** Todesfälle dieses Jahres in den Listen.`);
  if (runningYear) lines.push("");
  lines.push(`Die neue Runde **${runningYear}** ist live. Tippt weiter — ich kenne das Ende schon.`);
  return lines.join("\n");
}

/** Führt den Jahreswechsel aus: Auswertung posten + announced-Saison live schalten. */
async function runYearRollover(client, config, { force = false } = {}) {
  const announced = db.getAnnouncedSeason();
  const running = db.getActiveSeason();

  // Nichts zu wechseln? trotzdem Auswertung der laufenden + Hinweis, dass keine
  // neue Saison eröffnet wurde.
  if (!announced) {
    await postReview(client, config, running);
    return { switched: false, reason: "no-announced" };
  }

  if (!force && announced.start_date && utcToday() < announced.start_date) {
    // Noch nicht am Startdatum — Kritisch: der Cron ist auf 1.1.0 gesetzt,
    // aber falls der Bot offline war und der Run nachgeholt wird, verhindert
    // das doppelten Wechsel an falschem Datum.
    await postReview(client, config, running);
    return { switched: false, reason: "not-yet", start: announced.start_date };
  }

  // Posten VOR dem Wechsel, damit 'running' noch die alte Saison ist.
  await postReview(client, config, running);

  let pkg;
  try {
    pkg = createPackage(config, { reason: "year-rollover" });
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover backup" });
    throw e;
  }

  let res;
  try {
    res = db.activateAnnouncedSeason();
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover activate" });
    throw e;
  }

  await logEvent(client, config, {
    kind: "season-switch-auto",
    summary: `Automatischer Saisonwechsel ${res.archived.year} → ${res.activated.year}`,
    userId: config.adminId,
    detail: `backup=${pkg?.name} archived=${res.archived.id} activated=${res.activated.id}`,
  });

  // Neuen Kanal deathpool-{YEAR} anlegen + alle Teilnehmer einladen (1.1.).
  let newChannel = null;
  try {
    newChannel = await createNextSeasonChannel(client, config, res.activated.year);
    if (newChannel?.id) {
      // Kanal-ID auf die neue (nun laufende) Saison schreiben: dort landen künftige
      // Deathpool-Nachrichten.
      db.getDb()
        .prepare(`UPDATE seasons SET announce_channel_id = ? WHERE id = ?`)
        .run(String(newChannel.id), res.activated.id);
    }
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover createChannel" });
  }

  // Kurze Bestätigung im (neuen) Deathpool-Kanal
  const targetId =
    newChannel?.id || config.channelAllDeaths || config.channelDeathpool;
  const channel = targetId ? await client.channels.fetch(targetId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await channel
      .send({
        content: newChannel
          ? `🆕 **Neue Saison ${res.activated.year} live** — Kanal <#${newChannel.id}> ist erstellt, alle Teilnehmer sind eingeladen.`
          : `🔄 **Saisonwechsel:** ${res.archived.year} archiviert — **${res.activated.year} ist live**.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  return { switched: true, archived: res.archived, activated: res.activated };
}

async function postReview(client, config, runningSeason) {
  const targetId = config.channelAllDeaths || config.channelDeathpool;
  const channel = targetId ? await client.channels.fetch(targetId).catch(() => null) : null;
  if (!channel?.isTextBased()) return false;
  const review = runningSeason ? db.seasonReview(runningSeason.id) : null;
  const text = formatSeasonReviewText(review, announcedYear(config));
  if (!text) return false;
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => false);
  return true;
}

function announcedYear(config) {
  const announced = config && db.getAnnouncedSeason ? db.getAnnouncedSeason() : null;
  return announced?.year || null;
}

function utcToday() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Erstellt den neuen Saison-Kanal `deathpool-{YEAR}` (GuildText) im Server,
 * gibt allen Spielern ViewChannel (+ Send), und postet eine Bestätigung.
 * Fehlender Guild/Channel wird abgefangen — nie fatal.
 *
 * Guild-Auflösung (in dieser Reihenfolge):
 *   1. config.discordGuildId (explizit gesetzt)
 *   2. aus dem Deathpool-Kanal abgeleitet — client.channels.fetch(channelDeathpool).guild
 *      (= derselbe Server wie das Announcement, falls er da gepostet wurde)
 *   3. sonst: keine Guild → Kanal-Erstellung übersprungen (nicht fatal)
 */
async function createNextSeasonChannel(client, config, year) {
  let guild = null;
  if (config.discordGuildId) {
    guild = await client.guilds.fetch(config.discordGuildId).catch(() => null);
  }
  if (!guild) {
    // Ableitung aus dem Deathpool-Kanal (gleicher Server wie Announcement)
    const deriveChannelId = config.channelDeathpool || config.channelAllDeaths;
    if (deriveChannelId) {
      const ch = await client.channels.fetch(deriveChannelId).catch(() => null);
      guild = ch?.guild || null;
      if (guild) console.log(`[year-rollover] Guild aus Kanal ${deriveChannelId} abgeleitet: ${guild.name || guild.id}`);
    }
  }
  if (!guild?.channels?.create) {
    console.warn(
      "[year-rollover] keine Guild (weder DISCORD_GUILD_ID noch aus Deathpool-Kanal ableitbar) — Kanal-Erstellung übersprungen"
    );
    return null;
  }
  const name = `deathpool-${year}`;
  const existing = guild.channels.cache.find((c) => c.name === name);
  if (existing) {
    console.log(`[year-rollover] Kanal ${name} existiert bereits`);
    return existing;
  }

  // Alle Spieler (Teilnehmer) bekommen Sicht + Schreibrecht.
  const players = db.getDb().prepare("SELECT discord_user_id, display_name FROM players").all() || [];
  const overwrites = players
    .filter((p) => p.discord_user_id)
    .map((p) => ({
      id: p.discord_user_id,
      allow: ["ViewChannel", "SendMessages"],
    }));

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    topic: `Deathpool ${year} — Greggs Liste. Teilnahme = diesen Kanal sehen.`,
  });

  await logEvent(client, config, {
    kind: "season-channel-created",
    summary: `Kanal ${name} erstellt (${players.length} Spieler eingeladen)`,
    userId: config.adminId,
    detail: `guild=${config.discordGuildId} players=${players.length}`,
  });
  return channel;
}

/**
 * Erinnerung an den Admin (01.11. & 01.12.), wenn die neue Saison noch nicht
 * eröffnet wurde (keine announced-Saison und aktives Jahr = das kommende Jahr
 * ist noch nicht vorbereitet).
 */
async function remindAdminToAnnounce(client, config) {
  const announced = db.getAnnouncedSeason();
  if (announced) return { reminded: false, reason: "already-announced" };

  const running = db.getActiveSeason();
  const target = nextYear(running);
  const today = utcToday();
  const [y] = today.split("-").map(Number);

  // Erinnere nur, wenn wir im aktuellen Kalenderjahr der noch laufenden Runde
  // sind (z. B. Nov/Dez 2026, Runde 2026) und die neue (2027) noch fehlt.
  if (running && y !== running.year) {
    // Wir sind bereits im neuen Jahr und die alte Runde läuft noch — keine
    // Erinnerung nötig (es läuft erst gerade an).
    return { reminded: false, reason: "running-current-year" };
  }

  const text =
    `⚰️ **Erinnerung:** Die Runde **${target}** ist noch nicht eröffnet.\n` +
    "Erstelle sie manuell mit `/announce-season announce_channel:#Kanal` (oder `!announce-season #Kanal`), " +
    "bevor am 01.01. gewechselt wird — sonst verpasst Gregg den Kanal-Start.";
  await sendAdmin({ client, config }, { content: text });
  await logEvent(client, config, {
    kind: "admin-reminder",
    summary: `Erinnerung: Runde ${target} noch nicht eröffnet`,
    userId: config.adminId,
  });
  return { reminded: true, reason: "sent", target };
}

/** Startet den Jahreswechsel-Cron: 1. Januar, 00:00 Wiener Zeit (explizit, egal ob Host/Container). */
function startYearRollover(client, config) {
  const expr = "0 0 1 1 *";
  console.log(`[year-rollover] scheduled (cron: ${expr}, tz: Europe/Vienna)`);
  cron.schedule(
    expr,
    () => {
      runYearRollover(client, config).catch((e) =>
        console.error("[year-rollover] failed", e.message)
      );
    },
    { timezone: "Europe/Vienna" }
  );

  // Erinnerungen 01.11. & 01.12., 00:00 (Vorlauf zum 01.01.).
  const remindExpr = "0 0 1 11,12 *";
  console.log(`[year-rollover] reminders scheduled (cron: ${remindExpr}, tz: Europe/Vienna)`);
  cron.schedule(
    remindExpr,
    () => {
      remindAdminToAnnounce(client, config).catch((e) =>
        console.error("[year-rollover] reminder failed", e.message)
      );
    },
    { timezone: "Europe/Vienna" }
  );

  return { expr, remindExpr, timezone: "Europe/Vienna" };
}


module.exports = {
  runYearRollover,
  startYearRollover,
  formatSeasonReviewText,
  remindAdminToAnnounce,
  createNextSeasonChannel,
  nextYear,
};
