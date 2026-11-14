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
  // F03: Live-Satz NUR wenn der Wechsel committet wurde (runningYear gesetzt) —
  // auf dem no-announced-Pfad kommt hier null rein und der Satz entfällt.
  if (runningYear) {
    lines.push("");
    lines.push(`Die neue Runde **${runningYear}** ist live. Tippt weiter — ich kenne das Ende schon.`);
  }
  return lines.join("\n");
}

/**
 * Datum in der Bot-Zeitzone (YYYY-MM-DD) — F01: Der Cron feuert 00:00 Wiener
 * Zeit (= 23:00 UTC am 31.12.). Ein UTC-Datum täte den Wechsel am 31.12. statt
 * am 01.01., wodurch der Guard „start_date > heute" nie erfüllt würde. `date`
 * ist injizierbar für Tests mit eingefrorenem Instant.
 *
 * `timeZone` ist konfigurierbar (config.tz). Default Europe/Vienna — bleibt
 * damit rückwärtskompatibel zu Aufrufen, die kein Zeitzonen-Argument mitgeben.
 */
function todayInVienna(date = new Date(), timeZone = "Europe/Vienna") {
  if (date == null) date = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Ist heute (in der Bot-TZ) der 01.01.? — Stichtag für den einmaligen Jahresbericht (F20). */
function isNewYearDayVienna(date = new Date(), timeZone = "Europe/Vienna") {
  return todayInVienna(date, timeZone).endsWith("-01-01");
}

/**
 * Führt den Jahreswechsel aus: Auswertung posten + announced-Saison live schalten.
 *
 * F20: Der no-announced-Pfad postet NICHT mehr bei jedem Start — nur am WIENER
 * 01.01. genau einmal (Meta-Flag `year_rollover_annual_review`), mit echten
 * Live-Summen der laufenden Saison statt 0-Punkte-Snapshots. Der not-yet-Pfad
 * (start_date liegt in der Zukunft) postet GAR NICHT.
 */
async function runYearRollover(client, config, { force = false, now = null } = {}) {
  const announced = db.getAnnouncedSeason();
  const running = db.getActiveSeason();
  // Bot-Zeitzone aus config.tz (Default Europe/Vienna), konfigurierbar per TZ-Env.
  const tz = config.tz || "Europe/Vienna";

  // Nichts zu wechseln. Nur am Bot-TZ-01.01. GENAU EINMAL eine echte Jahresbilanz
  // der laufenden Saison posten (Live-Summen, KEINE Snapshots), als Rückgrat
  // für Handwechsel/Deploys, bei denen keine announced-Saison angelegt wurde.
  if (!announced) {
    const today = todayInVienna(now, tz);
    const reviewKey = "year_rollover_annual_review";
    if (isNewYearDayVienna(now, tz) && db.getMeta(reviewKey) !== today.slice(0, 4)) {
      // Flag VOR dem Post setzen: sendet der Post (z. B. Zielkanal weg), ist er
      // nicht wiederholbar — genau einmal pro Jahr.
      db.setMeta(reviewKey, today.slice(0, 4));
      // live:true → echte Live-Summen der laufenden Saison (base_points + Boni),
      // NICHT die leeren Snapshot-Zählung (F20(b)).
      const posted = await postReview(client, config, running, null, null, { live: true });
      // F25: auch der no-announced-Pfad wertet den Rückgabewert aus.
      if (!posted) {
        await logError(
          client,
          config,
          new Error("runYearRollover: Jahresbilanz (no-announced) konnte nicht gesendet werden"),
          { where: "year-rollover postReview failed", detail: `season=${running.id}` }
        );
      }
    }
    return { switched: false, reason: "no-announced" };
  }

  // F01: Wechsel erst, wenn das Bot-TZ-Datum >= start_date. Der Cron läuft
  // 00:00 config.tz; ein Nachhol-Run (Bot-Ausfall) kommt am selben TZ-Tag
  // oder später — überfällige start_date passieren, zukünftige blocken.
  // F20(a): vor dem Stichtag gibt es KEINEN Post — keine Abschlussbilanz der
  // laufenden Saison ohne deren Snapshots.
  if (!force && announced.start_date && todayInVienna(now, tz) < announced.start_date) {
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

  // F21: gemeinsame Nacharbeit (Cron +/new-year activate): Kanal anlegen,
  // deathpool_channel_id setzen, Bilanz der ARCHIVIERTEN Saison posten.
  const fin = await finalizeYearSwitch(client, config, res.archived.id, res.activated.year);
  const newChannel = fin.newChannel;
  const newChannelFailed = fin.newChannelFailed;

  // F25: postReview-Rückgabewert auswerten — false NICHT still schlucken.
  if (!fin.posted) {
    await logError(
      client,
      config,
      new Error("runYearRollover: Abschlussbilanz wurde nicht gesendet"),
      { where: "year-rollover postReview failed", detail: `archived=${res.archived.id}` }
    );
  }

  // Der Jahresbericht für den neuen Jahreswechsel ist erledigt (Bilanz der
  // archivierten Saison). Flag setzen, damit ein Restart am selben/folgenden Tag
  // auf dem no-announced-Pfad NICHT erneut postet (F20).
  db.setMeta("year_rollover_annual_review", String(res.activated.year));

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
 * F21/Cron-Nacharbeit nach erfolgreichem activateAnnouncedSeason — von beiden
 * Einstiegen gemeinsam genutzt: neuen Deathpool-Kanal anlegen (deathpool_channel_id),
 * Bilanz der ARCHIVIERTEN Saison mit Live-Satz posten. Rückgabe enthält Kanal,
 * Fehlschlag-Flag und ob die Bilanz wirklich gesendet wurde — Aufrufer loggen
 * die Details (F25).
 */
async function finalizeYearSwitch(client, config, archivedId, newYear) {
  const archived = db.getDb().prepare("SELECT * FROM seasons WHERE id = ?").get(archivedId);
  let newChannel = null;
  let newChannelFailed = false; // F06: Fehlschlag muss die Kurzbestätigung sagen
  try {
    newChannel = await createNextSeasonChannel(client, config, newYear);
    if (newChannel?.id) {
      // F06: Kanal-ID NUR in deathpool_channel_id — announce_channel_id bleibt der
      // Anmeldungskanal. Nach activateAnnouncedSeason ist die neue Saison active.
      db.setSeasonDeathpoolChannel(db.getActiveSeason().id, newChannel.id);
    } else {
      // F23: createNextSeasonChannel liefert bei fehlender Guild null (kein throw —
      // der Fehler wurde dort schon geloggt). Das Flag muss trotzdem gesetzt werden,
      // damit die Kurzbestätigung den fehlenden Kanal nennt statt „ist live".
      newChannelFailed = true;
    }
  } catch (e) {
    // F04/F06: Fehler nicht still schlucken — loggen, der Text unten sagt es.
    newChannelFailed = true;
    await logError(client, config, e, {
      where: "year-rollover finalize createChannel",
      detail: `year=${newYear}`,
    });
  }

  // Jahresbilanz + Kurzbestätigung in den NEUEN Kanal, wenn einer erstellt
  // wurde — sonst in den gewohnten Zielkanal (gespeicherte ID/Env-Fallback).
  const posted = await postReview(client, config, archived, newYear, newChannel?.id || null);
  return { newChannel, newChannelFailed, posted };
}

/**
 * Postet die Abschlussbilanz. `season` ist die zu bewertende Saison (nach dem
 * Wechsel die ARCHIVIERTE), `liveYear` steuert den Live-Satz: gesetzt nur wenn
 * der Wechsel committet wurde, sonst null (F03). Fehlgeschlagene sends werden
 * geloggt und liefern false statt still zu verschwinden.
 *
 * F20(b): `live` wählt die Live-Auswertung (base_points + Boni der laufenden
 * Saison) statt seasonReview (Snapshots, die nur beim Archivieren existieren) —
 * für den einmaligen Jahresbericht am 01.01. ohne Wechsel.
 * F25: fehlendes Ziel (gelöschter Kanal / nichts konfiguriert) wird per logError
 * gemeldet und liefert false — kein stilles Schweigen.
 */
async function postReview(client, config, season, liveYear, preferredChannelId = null, { live = false } = {}) {
  // F06: Bilanz in den NEUEN Kanal, wenn einer erstellt wurde — sonst der
  // gewohnte Deathpool-/All-Deaths-Kanal (gespeicherte ID zuerst, Env-Fallback).
  const targetId = preferredChannelId || db.resolveDeathpoolChannel(config) || config.channelAllDeaths || null;
  const channel = targetId ? await client.channels.fetch(targetId).catch(() => null) : null;
  if (!channel?.isTextBased()) {
    // F25: fehlendes/unerreichbares Ziel NICHT still schlucken.
    await logError(
      client,
      config,
      new Error(`postReview: kein sendbarer Kanal (targetId=${targetId || "keiner"})`),
      { where: "year-rollover postReview no-target", detail: `season=${season?.id ?? "?"} liveYear=${liveYear ?? "-"}` }
    );
    return false;
  }
  const review = season ? (live ? db.seasonLiveReview(season.id) : db.seasonReview(season.id)) : null;
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
 *   2. aus dem Deathpool-Kanal abgeleitet — client.channels.fetch(resolveDeathpoolChannel).guild
 *      (derselbe Server wie das Announcement, falls er da gepostet wurde)
 *   3. sonst: keine Guild → Kanal-Erstellung übersprungen (nicht fatal)
 */
async function createNextSeasonChannel(client, config, year) {
  let guild = null;
  if (config.discordGuildId) {
    guild = await client.guilds.fetch(config.discordGuildId).catch(() => null);
  }
  if (!guild) {
    // Ableitung aus dem Deathpool-Kanal (gleicher Server wie Announcement) —
    // NUR an den gespeicherten Kanal der aktiven Saison (kein Env-Fallback
    // mehr: CHANNEL_DEATHPOOL ist seit dem interaktiven Kanal-Setup leer und
    // zählt als „kein Kanal"). 
    const deriveChannelId = db.resolveDeathpoolChannel(config) || config.channelAllDeaths;
    if (deriveChannelId) {
      const ch = await client.channels.fetch(deriveChannelId).catch(() => null);
      guild = ch?.guild || null;
      if (guild) console.log(`[year-rollover] Guild aus Kanal ${deriveChannelId} abgeleitet: ${guild.name || guild.id}`);
    } else {
      // Klar loggen, wenn kein Kanal da ist (Setup hat nichts verknüpft).
      console.log("[year-rollover] kein Kanal zur Guild-Ableitung (weder gespeichert noch CHANNEL_ALL_DEATHS)");
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
      detail: `guild=${guild?.id || config.discordGuildId || "none"} deriveFrom=${db.resolveDeathpoolChannel(config) || config.channelAllDeaths || "none"}`,
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
    await syncChannelOverwrites(client, existing, config);
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
      allow: { ViewChannel: true, SendMessages: true },
    }));
}

/**
 * F15: Overwrites eines bestehenden Deathpool-Kanals auf den AKTUELLEN
 * Spielerstand nachziehen. Rückgabe true wenn mind. eine Änderung gepingt wurde,
 * false wenn nichts zu tun war oder das Edit fehlschlug (Fehler wird geloggt).
 */
async function syncChannelOverwrites(client, channel, config) {
  const desired = currentPlayerOverwrites();
  const existingOw = (channel.permissionOverwrites?.cache || []);
  const existingFor = (id) =>
    Array.isArray(existingOw)
      ? existingOw.find((o) => String(o.id) === String(id))
      : existingOw.get(String(id));
  let changed = 0;
  for (const d of desired) {
    const o = existingFor(d.id);
    // F23: Bestand kann entweder ein PermissionsBitField (.has()) oder eine
    // Boolean-Map sein — das ARRAY-Format gibt es nicht mehr.
    const hasView =
      o?.allow?.has?.("ViewChannel") ?? (o?.allow?.ViewChannel === true);
    const hasSend =
      o?.allow?.has?.("SendMessages") ?? (o?.allow?.SendMessages === true);
    if (o && hasView && hasSend) continue; // schon passend
    try {
      // F23: d.allow ist die Boolean-Map — genau das zweite Argument, das
      // edit() für die Overwrite-Nachpflege auf Bestands-Kanälen braucht.
      await channel.permissionOverwrites.edit(d.id, d.allow, {
        type: 1, // PermissionOverwriteType.Member
        reason: `Deathpool ${channel.name}: Spieler ${d.id} Zugriff nachgezogen (year-rollover)`,
      });
      changed++;
    } catch (e) {
      // F23: Teilfehler (z.B. Server verlassen, fehlende Rechte) nur loggen —
      // der bestehende Kanal wird NICHT verworfen, die übrigen Spieler laufen weiter.
      await logError(client, config, e, {
        where: "year-rollover syncChannelOverwrites",
        detail: `channel=${channel.id} player=${d.id}`,
      });
    }
  }
  return changed > 0;
}


/**
 * Erinnerung an den Admin (01.11. & 01.12.), wenn die neue Saison noch nicht
 * eröffnet wurde (keine announced-Saison und aktives Jahr = das kommende Jahr
 * ist noch nicht vorbereitet).
 *
 * ZIEL-VEREINHEITLICHUNG: Das Admin-Ziel wird NICHT mehr händisch aufgelöst,
 * sondern über den zentralen Pfad src/discord/admin-notify.js (resolveAdminTarget/
 * sendAdmin): CHANNEL_ADMIN-Kanal, sonst DM an config.adminId. Erfolgs- und
 * Fehlerlogik (reminded/ reason 'no-target' + logError) bleibt erhalten.
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

  // Ziel über den zentralen sendAdmin-Pfad: CHANNEL_ADMIN-Kanal, sonst DM an
  // config.adminId. resolveAdminTarget kennt config.adminId nicht selbst — der
  // Admin-User wird (nur wenn kein CHANNEL_ADMIN gesetzt ist) hier geholt und
  // als preferDmUser mitgegeben. sendAdmin liefert null zurück, wenn kein
  // sendbares Ziel existiert.
  const ctx = { client, config };
  let preferDmUser = null;
  if (!config.channelAdmin && config.adminId) {
    try {
      const u = await client.users.fetch(config.adminId).catch(() => null);
      if (u?.createDM) {
        const dm = await u.createDM().catch(() => null);
        if (dm?.send) preferDmUser = { ...u, createDM: async () => dm };
      }
    } catch {
      preferDmUser = null;
    }
  }

  const delivered = await sendAdmin(ctx, text, { preferDmUser });
  if (!delivered) {
    const err = new Error(
      "remindAdminToAnnounce: kein Ziel (kein CHANNEL_ADMIN und Admin-DM fehlgeschlagen)"
    );
    await logError(client, config, err, { where: "remindAdminToAnnounce" });
    return { reminded: false, reason: "no-target", target };
  }

  await logEvent(client, config, {
    kind: "admin-reminder",
    summary: `Erinnerung: Runde ${target} noch nicht eröffnet`,
    userId: config.adminId,
  });
  return { reminded: true, reason: "sent", target };
}

/** Startet den Jahreswechsel-Cron: 1. Januar, 00:00 in config.tz (explizit, egal ob Host/Container). */
function startYearRollover(client, config) {
  const tz = config.tz || "Europe/Vienna";
  const expr = "0 0 1 1 *";
  console.log(`[year-rollover] scheduled (cron: ${expr}, tz: ${tz})`);
  cron.schedule(
    expr,
    () => {
      // F25: Fehler über logError in den Logkanal, nicht nur stdout.
      runYearRollover(client, config).catch((e) => {
        console.error("[year-rollover] failed", e.message);
        logError(client, config, e, { where: "year-rollover cron" });
      });
    },
    { timezone: tz }
  );

  // Erinnerungen 01.11. & 01.12., 00:00 (Vorlauf zum 01.01.).
  const remindExpr = "0 0 1 11,12 *";
  console.log(`[year-rollover] reminders scheduled (cron: ${remindExpr}, tz: ${tz})`);
  cron.schedule(
    remindExpr,
    () => {
      remindAdminToAnnounce(client, config).catch((e) => {
        console.error("[year-rollover] reminder failed", e.message);
        logError(client, config, e, { where: "year-rollover reminder cron" });
      });
    },
    { timezone: tz }
  );

  return { expr, remindExpr, timezone: tz };
}


module.exports = {
  runYearRollover,
  startYearRollover,
  finalizeYearSwitch,
  formatSeasonReviewText,
  remindAdminToAnnounce,
  createNextSeasonChannel,
  nextYear,
  todayInVienna,
  isNewYearDayVienna,
};
