const cron = require("node-cron");
const { ChannelType } = require("discord.js");
const db = require("../db");
const { logEvent, logError } = require("../discord/log");
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
  // F03: Live-Satz NUR wenn der Wechsel committet wurde (runningYear gesetzt) —
  // auf dem no-announced-Pfad kommt hier null rein und der Satz entfällt.
  if (runningYear) {
    lines.push("");
    lines.push(`Die neue Runde **${runningYear}** ist live. Tippt weiter — ich kenne das Ende schon.`);
  }
  return lines.join("\n");
}

/**
 * Datum in Europe/Vienna (YYYY-MM-DD) — F01: Der Cron feuert 00:00 Wiener Zeit
 * (= 23:00 UTC am 31.12.). Ein UTC-Datum täte den Wechsel am 31.12. statt am
 * 01.01., wodurch der Guard „start_date > heute" nie erfüllt würde. `date` ist
 * injizierbar für Tests mit eingefrorenem Instant.
 */
function todayInVienna(date = new Date()) {
  if (date == null) date = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Führt den Jahreswechsel aus: Auswertung posten + announced-Saison live schalten. */
async function runYearRollover(client, config, { force = false, now = null } = {}) {
  const announced = db.getAnnouncedSeason();
  const running = db.getActiveSeason();

  // Nichts zu wechseln? trotzdem Auswertung der laufenden + Hinweis, dass keine
  // neue Saison eröffnet wurde. Kein Live-Satz (runningYear = null).
  if (!announced) {
    await postReview(client, config, running, null);
    return { switched: false, reason: "no-announced" };
  }

  // F01: Wechsel erst, wenn das WIENER Datum >= start_date. Der Cron läuft
  // 00:00 Europe/Vienna; ein Nachhol-Run (Bot-Ausfall) kommt am selben Wiener
  // Tag oder später — überfällige start_date passieren, zukünftige blocken.
  if (!force && announced.start_date && todayInVienna(now) < announced.start_date) {
    await postReview(client, config, running, null);
    return { switched: false, reason: "not-yet", start: announced.start_date };
  }

  let pkg;
  try {
    pkg = createPackage(config, { reason: "year-rollover" });
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover backup" });
    throw e;
  }

  // F03: Wechsel KOMMITTEN, BEVOR die Bilanz gepostet wird — seasonReview liest
  // season_point_snapshots, die erst activateAnnouncedSeason schreibt.
  let res;
  try {
    res = db.activateAnnouncedSeason();
  } catch (e) {
    await logError(client, config, e, { where: "year-rollover activate" });
    throw e;
  }

  // F06: Neuen Kanal deathpool-{YEAR} anlegen + alle Teilnehmer einladen (1.1.).
  // Die neue Kanal-ID geht NUR in deathpool_channel_id — announce_channel_id
  // bleibt der Anmeldungskanal.
  let newChannel = null;
  let newChannelFailed = false; // F06: Fehlschlag muss die Kurzbestätigung sagen
  try {
    newChannel = await createNextSeasonChannel(client, config, res.activated.year);
    if (newChannel?.id) {
      db.setSeasonDeathpoolChannel(res.activated.id, newChannel.id);
    }
  } catch (e) {
    // F04/F06: Fehler nicht still schlucken — loggen, der Text unten sagt es.
    newChannelFailed = true;
    await logError(client, config, e, {
      where: "year-rollover createChannel",
      detail: `year=${res.activated.year}`,
    });
  }

  // F06: Jahresbilanz + Kurzbestätigung in den NEUEN Kanal, wenn einer erstellt
  // wurde — sonst in den gewohnten Zielkanal (gespeicherte ID/Env-Fallback).
  await postReview(client, config, res.archived, res.activated.year, newChannel?.id || null);

  await logEvent(client, config, {
    kind: "season-switch-auto",
    summary: `Automatischer Saisonwechsel ${res.archived.year} → ${res.activated.year}`,
    userId: config.adminId,
    detail: `backup=${pkg?.name} archived=${res.archived.id} activated=${res.activated.id}`,
  });

  // Kurze Bestätigung im (neuen) Deathpool-Kanal — Fehler nicht stumm schlucken (F04).
  let ackChannelId = null;
  if (newChannel?.id) {
    ackChannelId = newChannel.id;
  } else {
    ackChannelId = db.resolveDeathpoolChannel(config) || config.channelAllDeaths || null;
  }
  const channel = ackChannelId
    ? await client.channels.fetch(ackChannelId).catch(() => null)
    : null;
  if (channel?.isTextBased()) {
    try {
      const ackText = newChannel
        ? `🆕 **Neue Saison ${res.activated.year} live** — Kanal <#${newChannel.id}> ist erstellt, alle Teilnehmer sind eingeladen.`
        : newChannelFailed
          ? `🔄 **Saisonwechsel:** ${res.archived.year} archiviert — **${res.activated.year} ist live**. (Wechsel ohne neuen Kanal — Kanal-Anlage fehlgeschlagen.)`
          : `🔄 **Saisonwechsel:** ${res.archived.year} archiviert — **${res.activated.year} ist live**.`;
      await channel.send({
        content: ackText,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      // F04: ehrliche Rückgabe statt das Versagen zu verschlucken.
      await logError(client, config, e, {
        where: "year-rollover switch-ack send",
        detail: `channel=${ackChannelId}`,
      });
    }
  } else {
    const err = new Error(
      `runYearRollover: Switch-Bestätigung nicht gesendet (kein sendbarer Kanal, targetId=${ackChannelId})`
    );
    await logError(client, config, err, { where: "year-rollover switch-ack" });
  }

  return { switched: true, archived: res.archived, activated: res.activated, channel: newChannel?.id || null };
}

/**
 * Postet die Abschlussbilanz. `season` ist die zu bewertende Saison (nach dem
 * Wechsel die ARCHIVIERTE), `liveYear` steuert den Live-Satz: gesetzt nur wenn
 * der Wechsel committet wurde, sonst null (F03). Fehlgeschlagene sends werden
 * geloggt und liefern false statt still zu verschwinden.
 */
async function postReview(client, config, season, liveYear, preferredChannelId = null) {
  // F06: Bilanz in den NEUEN Kanal, wenn einer erstellt wurde — sonst der
  // gewohnte Deathpool-/All-Deaths-Kanal (gespeicherte ID zuerst, Env-Fallback).
  const targetId = preferredChannelId || db.resolveDeathpoolChannel(config) || config.channelAllDeaths || null;
  const channel = targetId ? await client.channels.fetch(targetId).catch(() => null) : null;
  if (!channel?.isTextBased()) return false;
  const review = season ? db.seasonReview(season.id) : null;
  const text = formatSeasonReviewText(review, liveYear ?? null);
  if (!text) return false;
  try {
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  } catch (e) {
    await logError(client, config, e, {
      where: "year-rollover postReview",
      detail: `channel=${targetId}`,
    });
    return false;
  }
  return true;
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
    const err = new Error(
      "Keine Guild (weder DISCORD_GUILD_ID noch aus Deathpool-Kanal ableitbar) — Kanal-Erstellung übersprungen"
    );
    // F15: logError statt stillem console.warn (Guild-ID mitloggen, auch
    // abgeleitet) — kein stilles Überspringen.
    await logError(client, config, err, {
      where: "year-rollover createChannel guild",
      detail: `guild=${guild?.id || config.discordGuildId || "none"} deriveFrom=${config.channelDeathpool || config.channelAllDeaths || "none"}`,
    });
    return null;
  }
  const name = `deathpool-${year}`;

  // F15: bestehenden Kanal robust per channels.fetch (frisch von der API, nicht
  // nur Cache) + Namens-/Typfilter auflösen — kalter Cache → kein zweites
  // deathpool-{YEAR} anlegen. NUR GuildText zählt: ein Voice-/Kategorie-Kanal
  // desselben Namens ist KEIN Deathpool.
  let existing = null;
  try {
    const all = await guild.channels.fetch();
    existing = all.find((c) => c.name === name && c.type === ChannelType.GuildText) || null;
  } catch (e) {
    // Kanal-Auflösung fehlgeschlagen → NICHT still weiterlaufen (F15).
    await logError(client, config, e, {
      where: "year-rollover createChannel fetch",
      detail: `guild=${guild.id} name=${name}`,
    });
    existing = null;
  }
  if (existing) {
    console.log(`[year-rollover] Kanal ${name} existiert bereits`);
    // F15: Overwrites auf den AKTUELLEN Spielerstand nachziehen (wer neu
    // eingeladen wurde, muss den Kanal sehen/darauf schreiben).
    await syncChannelOverwrites(existing, config);
    return existing;
  }

  // Alle Spieler (Teilnehmer) bekommen Sicht + Schreibrecht.
  const overwrites = currentPlayerOverwrites();

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    topic: `Deathpool ${year} — Greggs Liste. Teilnahme = diesen Kanal sehen.`,
  });

  await logEvent(client, config, {
    kind: "season-channel-created",
    summary: `Kanal ${name} erstellt (${overwrites.length} Spieler eingeladen)`,
    userId: config.adminId,
    detail: `guild=${guild.id} players=${overwrites.length}`,
  });
  return channel;
}

/** Aktuelle Spielerliste als permissionOverwrites (ViewChannel + SendMessages). */
function currentPlayerOverwrites() {
  const players = db.getDb().prepare("SELECT discord_user_id, display_name FROM players").all() || [];
  return players
    .filter((p) => p.discord_user_id)
    .map((p) => ({
      id: p.discord_user_id,
      allow: ["ViewChannel", "SendMessages"],
    }));
}

/**
 * F15: Overwrites eines bestehenden Deathpool-Kanals auf den AKTUELLEN
 * Spielerstand nachziehen. Rückgabe true wenn mind. eine Änderung gepingt wurde,
 * false wenn nichts zu tun war oder das Edit fehlschlug (Fehler wird geloggt).
 */
async function syncChannelOverwrites(channel, config) {
  const desired = currentPlayerOverwrites();
  try {
    const existingOw = (channel.permissionOverwrites?.cache || []);
    const existingFor = (id) =>
      Array.isArray(existingOw)
        ? existingOw.find((o) => String(o.id) === String(id))
        : existingOw.get(String(id));
    let changed = 0;
    for (const d of desired) {
      const o = existingFor(d.id);
      const hasView =
        o?.allow?.has?.("ViewChannel") ??
        (Array.isArray(o?.allow) && o.allow.includes("ViewChannel"));
      const hasSend =
        o?.allow?.has?.("SendMessages") ??
        (Array.isArray(o?.allow) && o.allow.includes("SendMessages"));
      if (o && hasView && hasSend) continue; // schon passend
      await channel.permissionOverwrites.edit(d.id, d.allow, {
        type: 1, // PermissionOverwriteType.Member
        reason: `Deathpool ${channel.name}: Spieler ${d.id} Zugriff nachgezogen (year-rollover)`,
      });
      changed++;
    }
    return changed > 0;
  } catch (e) {
    await logError(client, config, e, {
      where: "year-rollover syncChannelOverwrites",
      detail: `channel=${channel.id}`,
    });
    return false;
  }
}


/**
 * Erinnerung an den Admin (01.11. & 01.12.), wenn die neue Saison noch nicht
 * eröffnet wurde (keine announced-Saison und aktives Jahr = das kommende Jahr
 * ist noch nicht vorbereitet).
 */
async function remindAdminToAnnounce(client, config) {
  const announced = db.getAnnouncedSeason();
  // F07: Erinnern, solange keine announced-Saison existiert — der falsche
  // Jahr-Vergleichs-Guard (unterdrückte die Erinnerung nach einem
  // liegengebliebenen Jahr) ist entfernt.
  if (announced) return { reminded: false, reason: "already-announced" };

  const running = db.getActiveSeason();
  const target = nextYear(running);

  const text =
    `⚰️ **Erinnerung:** Die Runde **${target}** ist noch nicht eröffnet.\n` +
    "Erstelle sie manuell mit `/announce-season announce_channel:#Kanal` (oder `!announce-season #Kanal`), " +
    "bevor am 01.01. gewechselt wird — sonst verpasst Gregg den Kanal-Start.";

  // F07: Ziel auflösen — CHANNEL_ADMIN, sonst DM an den Admin. sendAdmin hat
  // KEINEN DM-Fallback: bei leerem CHANNEL_ADMIN ginge sonst nichts raus, aber
  // es würde trotzdem reminded:true / reason:'sent' geloggt.
  let targetObj = null;
  if (config.channelAdmin) {
    try {
      const ch = await client.channels.fetch(config.channelAdmin).catch(() => null);
      if (ch?.isTextBased?.() || ch?.send) targetObj = ch;
    } catch {
      targetObj = null;
    }
  }
  if (!targetObj && config.adminId) {
    try {
      const user = await client.users.fetch(config.adminId).catch(() => null);
      if (user?.createDM) targetObj = await user.createDM().catch(() => null);
    } catch {
      targetObj = null;
    }
  }
  if (!targetObj?.send) {
    const err = new Error(
      "remindAdminToAnnounce: kein Ziel (kein CHANNEL_ADMIN und Admin-DM fehlgeschlagen)"
    );
    await logError(client, config, err, { where: "remindAdminToAnnounce" });
    return { reminded: false, reason: "no-target", target };
  }

  try {
    await targetObj.send({ content: text });
  } catch (e) {
    await logError(client, config, e, { where: "remindAdminToAnnounce send" });
    return { reminded: false, reason: "no-target", target };
  }
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
  todayInVienna,
};
